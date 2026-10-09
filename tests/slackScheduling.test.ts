import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createAccessPolicy } from "../src/common/accessPolicy.js";
import type { IncomingTurn } from "../src/core/conversation.js";
import type { TextEngine } from "../src/composition/textEngine.js";
import { SlackApiError, type SlackApi, type SlackResponse } from "../src/adapters/slack.js";
import { DeliveryRejectedError, DeliveryUncertainError, Scheduler } from "../src/scheduling/engine.js";
import { ScheduleStore, SchedulerLeaseHeldError } from "../src/scheduling/store.js";
import { ScheduleService } from "../src/scheduling/service.js";
import { SlackScheduleAdapter } from "../src/scheduling/slackAdapter.js";
import { SlackScheduleFrontend } from "../src/scheduling/slackCommands.js";
import { createScheduleToolRun, ScheduleTools } from "../src/common/scheduleTools.js";
import { resolveSessionContext } from "../src/common/sessionContext.js";

const now = Date.UTC(2026, 9, 8, 12);
const input: IncomingTurn = { eventId: "event", sourceMessageId: "1700000000.000001", receivedAt: new Date(now).toISOString(), text: "",
  actor: { platform: "slack", tenantId: "T", userId: "U" },
  conversation: { platform: "slack", tenantId: "T", installationId: "i", channelId: "C", threadId: "1700000000.000000", kind: "thread" } };

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slack-schedules-"));
  const rights = path.join(directory, "rights.json");
  fs.writeFileSync(rights, JSON.stringify({ grants: [{ platform: "slack", tenantId: "T", userId: "U",
    capabilities: ["schedule.message.create", "schedule.ai.create", "schedule.manage.own"] }] }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: Array<{ method: string; args?: Record<string, string> }> = [];
  const api: SlackApi = { async call(method, args) {
    calls.push({ method, args });
    if (method === "conversations.info") return { ok: true, channel: { is_member: true } };
    if (method === "conversations.members") return { ok: true, members: ["BOT", "U"] };
    if (method === "conversations.replies") return { ok: true, messages: [{ ts: "1699999999.000000", user: "U", text: "untrusted context" }] };
    if (method === "chat.postMessage") return { ok: true, ts: `1700000001.${String(calls.length).padStart(6, "0")}` };
    return { ok: true };
  } };
  const generated: string[] = [];
  const engine: TextEngine = { async configureSession() {}, async sendMessage(_key, prompt) { generated.push(prompt); return { content: "AI result", attachments: [] }; },
    async resetSession() {}, async forgetSession() {}, async shutdown() {} };
  const access = createAccessPolicy({ SLACK_RIGHTS_FILE: rights });
  const store = new ScheduleStore(":memory:");
  const adapter = new SlackScheduleAdapter(api, api, access, engine, { teamId: "T", installationId: "i", botUserId: "BOT", channels: new Set(["C"]), users: new Set(["U"]) });
  const scheduler = new Scheduler(store, access, adapter, { minimumMs: 60_000, maxOwner: 10, maxGuild: 10, concurrency: 2, timeoutMs: 1000 }, () => now);
  scheduler.start(); t.after(() => scheduler.stop());
  return { directory, rights, calls, generated, api, store, adapter, scheduler, service: new ScheduleService(scheduler, () => now) };
}

test("Slack proposals bind actor and conversation and duplicate confirmation is idempotent", async t => {
  const f = fixture(t);
  const proposal = await f.service.proposeCreate(input.actor, input.conversation, { guildId: "T", channelId: "C",
    destination: { version: 1, platform: "slack", tenantId: "T", installationId: "i", channelId: "C", threadId: input.conversation.threadId, kind: "thread" },
    kind: "ai", content: "Research release notes", cron: "0 9 * * 1", timezone: "America/New_York", provider: "codex", model: "test", reasoning: "low", contextMessages: 5 });
  await assert.rejects(f.service.confirm({ ...input.actor, userId: "ATTACKER" }, input.conversation, proposal.id), /not found/);
  await assert.rejects(f.service.confirm(input.actor, { ...input.conversation, channelId: "OTHER" }, proposal.id), /not found/);
  const first = await f.service.confirm(input.actor, input.conversation, proposal.id);
  const second = await f.service.confirm(input.actor, input.conversation, proposal.id);
  assert.equal(first.task.id, second.task.id); assert.equal(second.duplicate, true); assert.equal(f.store.list("T", "slack").length, 1);
});

test("agent schedule tools propose a host-bound schedule, require confirmation, and can run saved output", async t => {
  const f = fixture(t); const frontend = new SlackScheduleFrontend(f.service, f.api, { timezone: "America/New_York", provider: "codex", model: "test" });
  const turn = { ...input, text: "Schedule every Monday at 9 AM to search latest news about AI safety" };
  const run = createScheduleToolRun(), tools = new ScheduleTools(run, frontend.toolContext(turn));
  await assert.rejects(tools.call("create_schedule", { run_id: run.id, kind: "ai", content: "x", cron: "0 9 * * 1", user_id: "ATTACKER" }), /Invalid schedule tool arguments/);
  const proposed = await tools.call("create_schedule", { run_id: run.id, kind: "ai", content: "Search the internet for the latest news about AI safety and summarize it.", cron: "0 9 * * 1", timezone: "America/New_York", context_messages: "5" }) as { proposal_id: string };
  const proposalId = proposed.proposal_id; assert.match(proposalId, /^proposal_[a-f0-9]+$/); assert.equal(f.store.list(undefined, "slack").length, 0);
  await frontend.handle({ ...turn, text: `confirm ${proposalId}` });
  const task = f.store.list("T", "slack")[0]; assert.equal(task.destination?.threadId, input.conversation.threadId);
  assert.match(f.calls.at(-1)?.args?.text ?? "", /Schedule created:[\s\S]*Status: enabled/);
  await f.service.runNow(input.actor, task.id); await f.scheduler.idle();
  assert.match(f.generated[0], /untrusted context/); assert.equal(f.store.runs(task.id)[0].state, "succeeded");
});

test("Slack edit confirmation revives an automatically expired schedule and reports the update", async t => {
  const f = fixture(t); const frontend = new SlackScheduleFrontend(f.service, f.api, { timezone: "UTC", provider: "codex", model: "test" });
  const created = await f.service.proposeCreate(input.actor, input.conversation, { guildId: "T", channelId: "C",
    destination: { version: 1, platform: "slack", tenantId: "T", installationId: "i", channelId: "C", kind: "channel" },
    kind: "message", content: "Reminder", cron: "0 13 * * *", timezone: "UTC", contextMessages: 0, endAt: now + 30_000 });
  const task = (await f.service.confirm(input.actor, input.conversation, created.id)).task;
  f.store.pause(task.id, "Schedule reached its end date.");
  const proposal = await f.service.proposeEdit(input.actor, input.conversation, task.id, { endAt: now + 60_000 });
  await frontend.handle({ ...input, text: `confirm ${proposal.id}` });
  assert.equal(f.store.get(task.id)?.enabled, true);
  assert.match(f.calls.at(-1)?.args?.text ?? "", /Schedule updated:[\s\S]*Status: enabled/);
});

test("free-form scheduling reaches the agent and schedule context teaches tool-based interpretation", async t => {
  const f = fixture(t); const frontend = new SlackScheduleFrontend(f.service, f.api, { timezone: "UTC", provider: "codex", model: "test" });
  const text = "Every Monday, at 9AM EST, search the internet for relevant news to the keyword ai-assistant and then create a marketing article";
  assert.equal(await frontend.handle({ ...input, text }), false);
  const context = resolveSessionContext({ transportContext: { platform: "slack", history: true, attachments: true, schedules: true } });
  assert.equal(context.schedulesEnabled, true);
  assert.match(context.systemPrompt, /Use them whenever the user asks to create/);
  assert.match(context.systemPrompt, /EST\/EDT or ET means America\/New_York/);
  assert.doesNotMatch(context.systemPrompt, /could not safely resolve/i);
});

test("Slack delivery classifies definite and ambiguous failures and re-fences rate-limit retry", async t => {
  const f = fixture(t); const task = { id: "x", ownerId: "U", guildId: "T", channelId: "C", destination: { version: 1 as const, platform: "slack" as const, tenantId: "T", installationId: "i", channelId: "C", kind: "channel" as const },
    kind: "message" as const, content: "x", cron: "0 * * * *", timezone: "UTC", contextMessages: 0, enabled: true, nextRunAt: now, revision: 1, createdAt: now };
  let calls = 0, fences = 0;
  const rateApi: SlackApi = { async call(): Promise<SlackResponse> { calls++; if (calls === 1) throw new SlackApiError("rate", 429, "ratelimited", 0); return { ok: true, ts: "1700000002.000000" }; } };
  const rate = new SlackScheduleAdapter(rateApi, rateApi, createAccessPolicy({}), {} as TextEngine, { teamId: "T", installationId: "i", botUserId: "BOT", channels: new Set(["C"]), users: new Set(["U"]) });
  assert.equal(await rate.send(task, { content: "hello" }, "nonce", () => { fences++; }), "1700000002.000000"); assert.equal(fences, 2);
  for (const [error, type] of [[new SlackApiError("no", 200, "channel_not_found"), DeliveryRejectedError], [new SlackApiError("maybe", 200, "internal_error"), DeliveryUncertainError]] as const) {
    const failing: SlackApi = { async call() { throw error; } };
    const adapter = new SlackScheduleAdapter(failing, failing, createAccessPolicy({}), {} as TextEngine, { teamId: "T", installationId: "i", botUserId: "BOT", channels: new Set(["C"]), users: new Set(["U"]) });
    await assert.rejects(adapter.send(task, { content: "hello" }, "nonce", () => {}), value => value instanceof type);
  }
});

test("legacy databases migrate transactionally to versioned Discord destinations with a rollback backup", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-migration-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "schedules.sqlite"), db = new Database(file);
  db.exec("CREATE TABLE scheduler_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE tasks (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL, next_run INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, occurrence TEXT NOT NULL, state TEXT NOT NULL, started INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(task_id, occurrence));");
  const legacy = { id: "legacy", guildId: "G", ownerId: "U", channelId: "C", kind: "message", content: "hello", cron: "0 * * * *", timezone: "UTC", contextMessages: 0, enabled: true, nextRunAt: now, revision: 1, createdAt: now };
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("legacy", "G", "U", 1, now, JSON.stringify(legacy)); db.close();
  const store = new ScheduleStore(file); try { assert.equal(store.get("legacy")?.destination?.platform, "discord"); } finally { store.close(); }
  assert.equal(fs.existsSync(file + ".pre-v2-backup"), true);
  const migrated = new Database(file, { readonly: true }); try { assert.equal(migrated.pragma("user_version", { simple: true }), 2); } finally { migrated.close(); }
});

test("legacy migration refuses an active worker before changing its schema", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-migration-lock-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "schedules.sqlite"), db = new Database(file);
  db.exec("CREATE TABLE scheduler_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE tasks (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL, next_run INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, occurrence TEXT NOT NULL, state TEXT NOT NULL, started INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(task_id, occurrence));");
  db.prepare("INSERT INTO scheduler_lock VALUES (1,?,?)").run("active", Date.now() + 60_000); db.close();
  assert.throws(() => new ScheduleStore(file), SchedulerLeaseHeldError);
  const unchanged = new Database(file, { readonly: true });
  try { assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedule_proposals'").get(), undefined); }
  finally { unchanged.close(); }
  assert.equal(fs.existsSync(file + ".pre-v2-backup"), false);
});
