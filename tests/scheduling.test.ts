import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccessPolicy, parseGrants, slashCommandCapability } from "../src/common/accessPolicy.js";
import { nextOccurrences, parseEndAt, parseStartAt, validateSchedule } from "../src/scheduling/cron.js";
import { ScheduleStore } from "../src/scheduling/store.js";
import { Scheduler, ScheduleAccessError, DeliveryRejectedError, type ScheduleAdapter } from "../src/scheduling/engine.js";
import { RunTimeoutError } from "../src/providers/types.js";
import { providerTimeout } from "../src/common/runLifecycle.js";
import { commands } from "../src/commands.js";
import type { ScheduledTask } from "../src/scheduling/types.js";
import { DiscordScheduleAdapter } from "../src/scheduling/discordAdapter.js";

const admin = { userId: "100", guildId: "200" };
const input = { guildId: "200", channelId: "300", kind: "message" as const, content: "Reminder", cron: "0 * * * *", timezone: "UTC", contextMessages: 0 };
const limits = { minimumMs: 60_000, maxOwner: 2, maxGuild: 3, concurrency: 2, timeoutMs: 1000 };

test("failed research sources remain diagnostic while a useful sourced update is delivered", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-research-"));
  const old = process.env.AI_ASSISTANT_WORKSPACE_ROOT;
  const mode = process.env.AI_ASSISTANT_SECURITY_MODE;
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = workspace;
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  t.after(() => {
    if (old === undefined) delete process.env.AI_ASSISTANT_WORKSPACE_ROOT; else process.env.AI_ASSISTANT_WORKSPACE_ROOT = old;
    if (mode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE; else process.env.AI_ASSISTANT_SECURITY_MODE = mode;
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const content = "Panel update: new gameplay details. [Source](https://example.com/article)";
  const sessions = {
    setSessionProvider: async () => {}, setSessionWorkingDir: () => {}, setModel: async () => {}, forgetSession: async () => {},
    sendMessage: async (_key: string, prompt: string, _attachments: unknown, options: any) => {
      assert.match(prompt, /hosted web search and article opening/);
      assert.deepEqual(options.rulesetContext.requester.roleIds, ["400"]);
      options.onLookup({ url: "https://blocked.example", status: "unavailable", checkedAt: new Date().toISOString(), summary: "HTTP 403" });
      return { content, attachments: [] };
    },
  };
  const client = { guilds: { fetch: async () => ({ members: {
    fetch: async () => ({ roles: { cache: new Map([["400", {}]]) } }),
  } }) } };
  const adapter = new DiscordScheduleAdapter(client as unknown as ConstructorParameters<typeof DiscordScheduleAdapter>[0], createAccessPolicy({}), sessions as any);
  const task = { ...input, id: "research", kind: "ai", provider: "codex", model: "test" } as ScheduledTask;
  const run = { id: "run", startedAt: Date.now() } as any;
  assert.deepEqual(await adapter.generate(task, run, 1000), [{ content }]);
  assert.equal(run.lookups[0].status, "unavailable");
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: { after(fn: () => Promise<void>): void }, adapter: Partial<ScheduleAdapter> = {}, env = { DISCORD_ADMIN_USERS: "100" }) {
  let now = Date.UTC(2026, 0, 1);
  const store = new ScheduleStore(":memory:");
  const sent: string[] = [];
  const scheduler = new Scheduler(store, createAccessPolicy(env), {
    authorize: async () => {}, generate: async task => [{ content: task.content }],
    send: async (_task, part) => { sent.push(part.content); return String(sent.length); }, ...adapter,
  }, limits, () => now);
  scheduler.start();
  t.after(() => scheduler.stop());
  return { scheduler, store, sent, advance(ms: number) {
    while (ms > 0) { const step = Math.min(ms, 30_000); now += step; store.renew(now); ms -= step; }
  }, setTime(value: number) { now = value; }, now: () => now };
}

test("lookup outcomes and last verified values survive delivery while unavailable checks preserve the old snapshot", async t => {
  let available = true;
  const f = fixture(t, { generate: async (_task, run) => {
    run.lookups = [{ url: "https://example.com/auction", checkedAt: new Date(f.now()).toISOString(), status: available ? "verified" : "unavailable", summary: available ? "$42, 3 bids" : "HTTP 403" }];
    return [{ content: available ? "$42, 3 bids" : "Lookup unavailable" }];
  } });
  const task = await f.scheduler.create(admin, { ...input, kind: "ai", provider: "codex", model: "test" });
  const first = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(first)?.state, "succeeded");
  assert.equal(f.store.getRun(first)?.lookups?.[0].status, "verified");
  assert.deepEqual(f.store.getRun(first)?.parts, []);
  const snapshot = f.store.get(task.id)?.lastVerifiedLookups;
  available = false;
  f.advance(60_000);
  const second = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(second)?.state, "succeeded");
  assert.equal(f.store.getRun(second)?.lookups?.[0].status, "unavailable");
  assert.deepEqual(f.store.get(task.id)?.lastVerifiedLookups, snapshot);
  await f.scheduler.edit(admin, task.id, { cron: "0 */2 * * *" });
  assert.deepEqual(f.store.get(task.id)?.lastVerifiedLookups, snapshot);
  await f.scheduler.edit(admin, task.id, { content: "Different source" });
  assert.equal(f.store.get(task.id)?.lastVerifiedLookups, undefined);
});

for (const parseDate of [parseStartAt, parseEndAt]) test(`${parseDate.name} uses the schedule timezone or offset and rejects invalid or ambiguous times`, () => {
  for (const [value, timezone, expected] of [
    ["2026-07-01 18:30", "America/New_York", "2026-07-01T22:30:00.000Z"],
    ["2026-12-01T18:30:15", "America/New_York", "2026-12-01T23:30:15.000Z"],
    ["2026-07-01 18:30", "Asia/Kathmandu", "2026-07-01T12:45:00.000Z"],
    ["2026-07-01T18:30:00Z", "America/New_York", "2026-07-01T18:30:00.000Z"],
    ["2026-07-01T18:30:00.125+02:00", "UTC", "2026-07-01T16:30:00.125Z"],
    ["2026-11-01T01:30:00-04:00", "America/New_York", "2026-11-01T05:30:00.000Z"],
    ["2026-11-01T01:30:00-05:00", "America/New_York", "2026-11-01T06:30:00.000Z"],
  ]) assert.equal(new Date(parseDate(value, timezone)).toISOString(), expected);
  for (const value of ["", "tomorrow", "2026-12-01", "2026-02-30 12:00", "2026-02-30T12:00:00Z", "2026-01-01 24:00", "2026-01-01T10:00+25:00", "2026-01-01 12:60"]) {
    assert.throws(() => parseDate(value, "UTC"), /valid .* date and time/, value);
  }
  assert.throws(() => parseDate("2026-03-08 02:30", "America/New_York"), /does not exist/);
  assert.throws(() => parseDate("2026-11-01 01:30", "America/New_York"), /occurs twice/);
  assert.throws(() => parseDate("2026-12-01 18:30", "not/a-zone"));
});

test("start dates can be added, moved, preserved or cleared, and ends must follow starts", async t => {
  const f = fixture(t);
  const task = await f.scheduler.create(admin, input);
  for (const startAt of [NaN, Infinity, 8.64e15 + 1, f.now() + 0.5]) {
    await assert.rejects(f.scheduler.create(admin, { ...input, startAt }), /start date/);
    await assert.rejects(f.scheduler.edit(admin, task.id, { startAt }), /start date/);
  }
  for (const endAt of [f.now() + 30_000, f.now() + 60_000]) {
    const dates = { startAt: f.now() + 60_000, endAt };
    await assert.rejects(f.scheduler.create(admin, { ...input, ...dates }), /after the start date/);
    await assert.rejects(f.scheduler.edit(admin, task.id, dates), /after the start date/);
  }
  const startAt = f.now() + 3_600_000;
  await f.scheduler.edit(admin, task.id, { startAt });
  await f.scheduler.edit(admin, task.id, { content: "Updated" });
  assert.equal(f.store.get(task.id)?.startAt, startAt);
  assert.equal(f.store.get(task.id)?.nextRunAt, startAt);
  await f.scheduler.edit(admin, task.id, { startAt: startAt + 1 });
  assert.equal(f.store.get(task.id)?.nextRunAt, startAt + 3_600_000);
  await f.scheduler.edit(admin, task.id, { startAt: undefined });
  assert.equal(f.store.get(task.id)?.startAt, undefined);
  await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Updated"]);
  // Historical starts are already active and do not block later edits or resumes.
  await f.scheduler.edit(admin, task.id, { startAt: f.now() - 1 });
  f.scheduler.pause(admin, task.id);
  await f.scheduler.resume(admin, task.id);
  assert.equal(f.store.get(task.id)?.enabled, true);
});

test("a future start blocks manual runs and delivery retries, and is honored by resume", async t => {
  const f = fixture(t);
  const startAt = f.now() + 30_000;
  const task = await f.scheduler.create(admin, { ...input, startAt });
  await assert.rejects(f.scheduler.runNow(admin, task.id), /not started yet/);
  await assert.rejects(f.scheduler.retryDelivery(admin, task.id, "run"), /not started yet/);
  assert.equal(f.store.claim(task.id, f.now(), limits.minimumMs, true), undefined);
  f.scheduler.pause(admin, task.id);
  await f.scheduler.resume(admin, task.id);
  assert.equal(f.store.get(task.id)?.enabled, true);
  assert.equal(f.store.get(task.id)?.nextRunAt, Date.UTC(2026, 0, 1, 1));
  await assert.rejects(f.scheduler.runNow(admin, task.id), /not started yet/);
  f.advance(30_000);
  await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Reminder"]);
});

test("create and edit validate cutoffs, and editing can add, change, preserve or clear them", async t => {
  const f = fixture(t);
  const task = await f.scheduler.create(admin, input);
  for (const endAt of [NaN, Infinity, 8.64e15 + 1, f.now() - 1, f.now(), f.now() + 0.5]) {
    await assert.rejects(f.scheduler.create(admin, { ...input, endAt }), /end date/);
    await assert.rejects(f.scheduler.edit(admin, task.id, { endAt }), /end date/);
  }
  await f.scheduler.edit(admin, task.id, { endAt: f.now() + 30_000 });
  assert.equal(f.store.get(task.id)?.endAt, f.now() + 30_000);
  await f.scheduler.edit(admin, task.id, { content: "Updated" });
  assert.equal(f.store.get(task.id)?.endAt, f.now() + 30_000);
  await f.scheduler.edit(admin, task.id, { endAt: f.now() + 45_000 });
  assert.equal(f.store.get(task.id)?.endAt, f.now() + 45_000);
  await f.scheduler.edit(admin, task.id, { endAt: undefined });
  assert.equal(f.store.get(task.id)?.endAt, undefined);
  await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Updated"]);
});

for (const hours of [1, 3]) test(`every-${hours}-hour tasks include the exact start and exclude the exact end`, async t => {
  const f = fixture(t);
  const interval = hours * 3_600_000;
  const startAt = f.now() + 2 * interval;
  const task = await f.scheduler.create(admin, { ...input, cron: `0 */${hours} * * *`, startAt, endAt: f.now() + 4 * interval });
  assert.equal(task.nextRunAt, startAt);
  for (let i = 0; i < 4; i++) {
    f.advance(interval);
    f.scheduler.tick();
    await f.scheduler.idle();
    assert.equal(f.sent.length, Math.min(i, 2));
  }
  assert.deepEqual(f.sent, ["Reminder", "Reminder"]);
  assert.equal(f.store.get(task.id)?.enabled, false);
  assert.match(f.store.get(task.id)?.pauseReason ?? "", /end date/);
  assert.equal(f.store.runs(task.id).length, 2);
  await assert.rejects(f.scheduler.runNow(admin, task.id), /ended/);
  await assert.rejects(f.scheduler.resume(admin, task.id), /end date/);
});

test("cutoffs between occurrences expire even when the next run is still in the future", async t => {
  const f = fixture(t);
  const task = await f.scheduler.create(admin, { ...input, endAt: f.now() + 30_000 });
  f.advance(30_000);
  f.scheduler.tick();
  const ended = f.store.get(task.id)!;
  assert.equal(ended.enabled, false);
  f.scheduler.tick();
  assert.equal(f.store.get(task.id)?.revision, ended.revision);
  await f.scheduler.edit(admin, task.id, { endAt: f.now() + 45_000 });
  assert.equal(f.store.get(task.id)?.enabled, true);
  f.advance(45_000);
  f.scheduler.tick();
  await f.scheduler.edit(admin, task.id, { endAt: undefined });
  assert.equal(f.store.get(task.id)?.enabled, true);
  await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Reminder"]);
});

test("editing dates does not resume a schedule paused by a user", async t => {
  const f = fixture(t);
  const task = await f.scheduler.create(admin, { ...input, endAt: f.now() + 30_000 });
  f.scheduler.pause(admin, task.id);
  const edited = await f.scheduler.edit(admin, task.id, { endAt: f.now() + 60_000 });
  assert.equal(edited.enabled, false);
  assert.equal(edited.pauseReason, "Paused by a user.");
});

for (const action of ["clear", "extend"] as const) test(`${action} an elapsed end date before the next tick keeps the schedule paused`, async t => {
  const f = fixture(t);
  const task = await f.scheduler.create(admin, { ...input, endAt: f.now() + 30_000 });
  f.advance(30_000);
  assert.equal(f.store.get(task.id)?.enabled, true);
  const edited = await f.scheduler.edit(admin, task.id, { endAt: action === "clear" ? undefined : f.now() + 60_000 });
  assert.equal(edited.enabled, false);
  assert.match(edited.pauseReason ?? "", /end date/);
  await assert.rejects(f.scheduler.runNow(admin, task.id), /paused/);
  assert.deepEqual(f.store.runs(task.id), []);
  await f.scheduler.resume(admin, task.id);
  await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Reminder"]);
});

test("a cutoff that elapses while an edit authorizes also requires explicit resume", async t => {
  const gate = deferred();
  let block = false;
  const f = fixture(t, { authorize: async (_task, actorId) => { if (block && actorId) await gate.promise; } });
  const task = await f.scheduler.create(admin, { ...input, endAt: f.now() + 30_000 });
  block = true;
  const pending = f.scheduler.edit(admin, task.id, { endAt: undefined });
  await new Promise(resolve => setImmediate(resolve));
  f.advance(30_000);
  gate.resolve();
  const edited = await pending;
  assert.equal(edited.enabled, false);
  assert.match(edited.pauseReason ?? "", /end date/);
  assert.equal(edited.endAt, undefined);
});

test("an expired task cannot be claimed automatically or manually before the next tick", async t => {
  const f = fixture(t);
  const task = await f.scheduler.create(admin, { ...input, endAt: f.now() + 30_000 });
  f.advance(30_000);
  assert.equal(f.store.claim(task.id, f.now(), limits.minimumMs, true), undefined);
  assert.equal(f.store.claim(task.id, f.now(), limits.minimumMs), undefined);
  assert.equal(f.store.get(task.id)?.enabled, false);
  assert.deepEqual(f.store.runs(task.id), []);
});

test("a run claimed before its cutoff can finish after the schedule ends", async t => {
  const gate = deferred();
  const f = fixture(t, { generate: async () => { await gate.promise; return [{ content: "Finished" }]; } });
  t.after(async () => { gate.resolve(); });
  const task = await f.scheduler.create(admin, { ...input, kind: "ai", provider: "codex", model: "test", endAt: f.now() + 30_000 });
  const runId = await f.scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  f.advance(30_000);
  f.scheduler.tick();
  gate.resolve();
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Finished"]);
  assert.equal(f.store.getRun(runId)?.state, "succeeded");
  assert.equal(f.store.get(task.id)?.enabled, false);
});

test("a cutoff passing during the final send check does not discard claimed output", async t => {
  let sends = 0;
  const f = fixture(t, { send: async (_task, _part, _nonce, beforeSend) => {
    f.advance(30_000);
    beforeSend();
    sends++;
    return "message";
  } });
  const task = await f.scheduler.create(admin, { ...input, endAt: f.now() + 30_000 });
  const runId = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(sends, 1);
  assert.equal(f.store.getRun(runId)?.state, "succeeded");
  f.scheduler.tick();
  assert.equal(f.store.get(task.id)?.enabled, false);
});

test("failed delivery cannot be retried at or after the cutoff", async t => {
  const f = fixture(t, { send: async () => { throw new DeliveryRejectedError("Rejected"); } });
  const task = await f.scheduler.create(admin, { ...input, endAt: f.now() + 30_000 });
  const runId = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  f.advance(30_000);
  await assert.rejects(f.scheduler.retryDelivery(admin, task.id, runId), /ended/);
  assert.equal(f.store.getRun(runId)?.state, "delivery_failed");
  assert.equal(f.store.get(task.id)?.enabled, false);
});

test("schedule dates survive restart, expire before the next run, and leave legacy tasks enabled", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ended-schedule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "schedules.sqlite");
  const now = Date.UTC(2026, 0, 1);
  const first = new ScheduleStore(file);
  const task: ScheduledTask = { ...input, id: "ended", ownerId: "100", revision: 1, createdAt: now, nextRunAt: now + 3_600_000, enabled: true, endAt: now + 30_000 };
  first.save(task);
  first.save({ ...task, id: "legacy", endAt: undefined });
  first.save({ ...task, id: "future", startAt: now + 3_600_000, endAt: now + 7_200_000 });
  first.close();
  const second = new ScheduleStore(file);
  t.after(() => second.close());
  second.acquire(now + 30_000);
  second.recover(now + 30_000);
  assert.equal(second.get("ended")?.endAt, now + 30_000);
  assert.equal(second.get("ended")?.enabled, false);
  assert.equal(second.get("legacy")?.enabled, true);
  assert.equal(second.get("future")?.enabled, true);
  assert.equal(second.get("future")?.startAt, now + 3_600_000);
  assert.equal(second.get("future")?.nextRunAt, now + 3_600_000);
  assert.equal(second.claim("future", now + 30_000, limits.minimumMs, true), undefined);
});

test("schedule rights never inherit legacy open-admin fallback", () => {
  const policy = createAccessPolicy({});
  assert.equal(policy.canUseAdminCommands("100"), true);
  for (const capability of ["schedule.message.create", "schedule.ai.create", "schedule.manage.own", "schedule.manage.guild"] as const) {
    assert.equal(policy.can(admin, capability), false);
  }
  const explicit = createAccessPolicy({ DISCORD_ADMIN_USERS: "100" });
  assert.equal(explicit.can(admin, "schedule.ai.create"), true);
  assert.equal(explicit.can(admin, "schedule.manage.guild", { guildId: "999" }), false);
});

test("explicit AI role grants are guild scoped, preserve ownership and do not grant bot administration", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rights.json");
  fs.writeFileSync(file, JSON.stringify({ grants: [{ guildId: "200", roleId: "400", roles: ["scheduler"], capabilities: ["schedule.ai.create"] }] }));
  const policy = createAccessPolicy({ DISCORD_RIGHTS_FILE: file, DISCORD_ALLOWED_USERS: "999", DISCORD_ADMIN_USERS: "999" });
  const user = { userId: "101", guildId: "200", roleIds: ["400"] };
  assert.equal(policy.can(user, "schedule.message.create"), true);
  assert.equal(policy.canMessage("101", user), true);
  assert.equal(policy.can({ ...user, guildId: "201" }, "schedule.message.create"), false);
  assert.equal(policy.can({ ...user, roleIds: [] }, "schedule.message.create"), false);
  assert.equal(policy.can(user, "schedule.ai.create"), true);
  assert.equal(policy.can({ ...user, guildId: "201" }, "schedule.ai.create"), false);
  assert.equal(policy.can({ ...user, roleIds: [] }, "schedule.ai.create"), false);
  assert.equal(policy.can({ ...user, guildId: null }, "schedule.ai.create"), false);
  assert.equal(policy.can(user, "schedule.manage.own", { guildId: "200", ownerId: "102" }), false);
  assert.equal(policy.can(user, "bot.manage"), false);
  assert.equal(policy.can(user, "workspace.manage"), false);
  assert.equal(policy.isExplicitAdmin(user), false);
  fs.writeFileSync(file, JSON.stringify({ grants: [{ guildId: "200", roleId: "400", roles: ["server-admin"] }] }));
  const messageOnly = createAccessPolicy({ DISCORD_RIGHTS_FILE: file, DISCORD_ADMIN_USERS: "999" });
  assert.equal(messageOnly.can(user, "schedule.ai.create"), false);
});

test("malformed and overbroad rights fail closed", () => {
  for (const grants of [[{ roleId: "123" }], [{ userId: "123", guildId: "200", roles: ["bot-admin"] }],
    [{ userId: "123", roles: ["typo"] }], [{ userId: "123", capabilities: ["schedule.typo"] }], [{ userId: "123", roleId: "456", guildId: "200" }]]) {
    assert.throws(() => parseGrants({ grants }));
  }
  assert.throws(() => createAccessPolicy({ DISCORD_RIGHTS_FILE: "/nonexistent/rights.json" }));
  assert.equal(slashCommandCapability({ commandName: "future" }), undefined);
});

test("cron validates format, timezone, frequency and weekday local time across DST", () => {
  assert.throws(() => nextOccurrences("* * * * * *", "UTC"));
  assert.throws(() => nextOccurrences("0 9 * * *", "not/a-zone"));
  assert.throws(() => validateSchedule("* * * * *", "UTC", 900_000));
  const dates = nextOccurrences("0 9 * * 1-5", "America/New_York", Date.UTC(2026, 2, 6, 0), 2);
  assert.deepEqual(dates.map(d => new Date(d).toISOString()), ["2026-03-06T14:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
});

test("all registered slash command payloads serialize", () => {
  const serialized = commands.map(command => command.toJSON());
  assert.equal(serialized.filter(command => command.name === "schedule").length, 1);
  const schedule = serialized.find(command => command.name === "schedule")!;
  for (const name of ["create", "edit"]) {
    const sub = schedule.options?.find(option => option.name === name);
    assert.ok(sub && "options" in sub);
    for (const field of ["start_at", "end_at"]) {
      const date = sub.options?.find(option => option.name === field);
      assert.equal(date?.type, 3);
      assert.ok(!date?.required);
    }
  }
  for (const command of serialized.filter(c => c.name !== "schedule")) {
    const subs = command.options?.filter(option => option.type === 1) ?? [];
    for (const request of subs.length ? subs.map(sub => ({ commandName: command.name, subcommand: sub.name })) : [{ commandName: command.name }]) {
      assert.ok(slashCommandCapability(request), JSON.stringify(request));
    }
  }
});

test("fixed message runs persist delivery IDs and cannot immediately rerun", async t => {
  const f = fixture(t);
  const task = await f.scheduler.create(admin, input);
  const runId = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Reminder"]);
  assert.equal(f.store.getRun(runId)?.state, "succeeded");
  assert.deepEqual(f.store.getRun(runId)?.messageIds, ["1"]);
  await assert.rejects(() => f.scheduler.runNow(admin, task.id), /minimum run interval/);
});

test("task quotas count paused schedules and scope ownership", async t => {
  const f = fixture(t);
  const first = await f.scheduler.create(admin, input);
  f.scheduler.pause(admin, first.id);
  await f.scheduler.create(admin, input);
  await assert.rejects(f.scheduler.create(admin, input), /limit reached/);
  assert.throws(() => f.scheduler.requireTask({ userId: "101", guildId: "200" }, first.id), /unavailable/);
  assert.throws(() => f.scheduler.requireTask({ ...admin, guildId: "201" }, first.id), /unavailable/);
});

test("pause during generation suppresses pending output", async t => {
  const gate = deferred();
  const f = fixture(t, { generate: async () => { await gate.promise; return [{ content: "Late" }]; } });
  const task = await f.scheduler.create(admin, input);
  const id = await f.scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  f.scheduler.pause(admin, task.id);
  gate.resolve();
  await f.scheduler.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.getRun(id)?.state, "cancelled");
});

test("edit during generation suppresses stale output without pausing the new revision", async t => {
  const gate = deferred();
  const f = fixture(t, { generate: async () => { await gate.promise; return [{ content: "Old" }]; } });
  const task = await f.scheduler.create(admin, input);
  await f.scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  await f.scheduler.edit(admin, task.id, { content: "New" });
  gate.resolve();
  await f.scheduler.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get(task.id)?.enabled, true);
  assert.equal(f.store.get(task.id)?.content, "New");
});

test("revoked authorization before delivery pauses without sending", async t => {
  let authorized = true;
  const f = fixture(t, { authorize: async () => { if (!authorized) throw new ScheduleAccessError("Revoked"); },
    generate: async () => { authorized = false; return [{ content: "Private" }]; } });
  const task = await f.scheduler.create(admin, input);
  await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get(task.id)?.pauseReason, "Revoked");
});

test("definitely rejected delivery retries only the unsent parts without new generation", async t => {
  let generated = 0; let sends = 0; let reject = true;
  const f = fixture(t, { generate: async () => { generated++; return [{ content: "A" }, { content: "B" }]; },
    send: async () => { sends++; if (sends === 2 && reject) throw new DeliveryRejectedError("Rejected"); return String(sends); } });
  const task = await f.scheduler.create(admin, input);
  const id = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(id)?.state, "delivery_failed");
  reject = false;
  await f.scheduler.retryDelivery(admin, task.id, id);
  await f.scheduler.idle();
  assert.equal(generated, 1);
  assert.equal(sends, 3);
  assert.deepEqual(f.store.getRun(id)?.messageIds, ["1", "3"]);
});

test("uncertain sends are never automatically retried and leave future occurrences enabled", async t => {
  const f = fixture(t, { send: async () => { throw new Error("connection reset after send"); } });
  const task = await f.scheduler.create(admin, input);
  const id = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(id)?.state, "uncertain");
  assert.equal(f.store.get(task.id)?.enabled, true);
  await assert.rejects(() => f.scheduler.retryDelivery(admin, task.id, id), /Uncertain sends/);
});

test("unconfirmed AI cancellation pauses future execution", async t => {
  const f = fixture(t, { generate: async () => { throw new RunTimeoutError("test", 1000, false); } });
  const task = await f.scheduler.create(admin, { ...input, kind: "ai", provider: "codex", model: "test" });
  const id = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(id)?.state, "uncertain");
  assert.equal(f.store.get(task.id)?.enabled, false);
});

test("database survives restart, skips missed schedules and fences a second worker", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedules-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "schedules.sqlite");
  const now = Date.UTC(2026, 0, 1);
  const first = new ScheduleStore(file);
  first.acquire(now);
  const second = new ScheduleStore(file);
  assert.throws(() => second.acquire(now + 1), /Another scheduler/);
  const task: ScheduledTask = { ...input, id: "task", ownerId: "100", revision: 1, createdAt: now, nextRunAt: now, enabled: true };
  first.save(task);
  assert.ok(first.claim(task.id, now, 60_000));
  assert.equal(first.claim(task.id, now, 60_000), undefined);
  second.acquire(now + 60_001);
  assert.throws(() => first.assertLease(now + 60_001), /lease lost/);
  second.recover(now + 60_001);
  assert.equal(second.get(task.id)?.enabled, true);
  assert.equal(second.runs(task.id)[0].state, "queued");
  second.save({ ...task, id: "missed", nextRunAt: now });
  second.recover(now + 60_001);
  assert.equal(second.get("missed")?.nextRunAt, now + 3_600_000);
  first.close(); second.close();
  const third = new ScheduleStore(file);
  assert.equal(third.runs(task.id)[0].state, "queued");
  third.close();
});

test("host timeout can only shorten provider timeout", () => {
  assert.equal(providerTimeout("TEST_MISSING_TIMEOUT", { timeoutMs: 1234 }), 1234);
  assert.equal(providerTimeout("TEST_MISSING_TIMEOUT", { timeoutMs: 9_000_000 }), 3_600_000);
  assert.throws(() => providerTimeout("TEST_MISSING_TIMEOUT", { timeoutMs: NaN }));
});

test("restart preserves generated output for automatic delivery recovery", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ready-schedule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ScheduleStore(path.join(dir, "db.sqlite"));
  t.after(() => store.close());
  const now = Date.UTC(2026, 0, 1);
  store.acquire(now);
  store.save({ ...input, id: "task", ownerId: "100", revision: 1, createdAt: now, nextRunAt: now, enabled: true });
  const { run } = store.claim("task", now, 60_000)!;
  run.state = "ready";
  run.parts = [{ content: "Already generated" }];
  store.saveRun(run);
  store.recover(now + 1);
  assert.equal(store.getRun(run.id)?.state, "ready");
  assert.deepEqual(store.getRun(run.id)?.parts, [{ content: "Already generated" }]);
  assert.equal(store.get("task")?.enabled, true);
  assert.equal(store.get("task")?.revision, 1);
});

test("context author policy retains guild-scoped user and role grants", async t => {
  const { contextAuthorPolicy } = await import("../src/common/discordAccess.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-rights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rights.json");
  fs.writeFileSync(file, JSON.stringify({ grants: [
    { userId: "101", guildId: "200", roles: ["member"] },
    { roleId: "400", guildId: "200", roles: ["member"] },
  ] }));
  const policy = createAccessPolicy({ DISCORD_ALLOWED_USERS: "100", DISCORD_ADMIN_USERS: "100", DISCORD_RIGHTS_FILE: file });
  const client = { guilds: { cache: new Map([["200", { members: { cache: new Map([["102", { roles: { cache: new Map([["400", {}]]) } }]]) } }]]) } };
  const filter = contextAuthorPolicy(policy, client as any, "200");
  assert.equal(filter("101"), true);
  assert.equal(filter("102"), true);
  assert.equal(filter("103"), false);
  assert.equal(contextAuthorPolicy(policy, client as any, "201")("101"), false);
});

test("repeated rejected deliveries cannot accumulate unbounded saved payloads", t => {
  const store = new ScheduleStore(":memory:");
  t.after(() => store.close());
  const now = Date.UTC(2026, 0, 1);
  store.acquire(now);
  store.save({ ...input, id: "task", ownerId: "100", revision: 1, createdAt: now, nextRunAt: now, enabled: true });
  let firstId = "";
  for (let i = 0; i < 25; i++) {
    const { run } = store.claim("task", now + i * 1000, 1, true)!;
    if (!firstId) firstId = run.id;
    run.state = "delivery_failed";
    run.parts = [{ content: "Saved result" }];
    store.saveRun(run);
  }
  assert.equal(store.runs("task").length, 20);
  assert.equal(store.getRun(firstId), undefined);
});

test("shared mode rejects rights files writable through provider workspaces", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "protected-rights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace);
  const inside = path.join(workspace, "rights.json");
  const outside = path.join(dir, "rights.json");
  fs.writeFileSync(inside, '{"grants":[]}');
  fs.writeFileSync(outside, '{"grants":[]}');
  const env = { AI_ASSISTANT_SECURITY_MODE: "shared", AI_ASSISTANT_WORKSPACE_ROOT: workspace };
  assert.throws(() => createAccessPolicy({ ...env, DISCORD_RIGHTS_FILE: inside }), /outside the provider workspace/);
  const linkIn = path.join(dir, "link-in.json");
  const linkOut = path.join(workspace, "link-out.json");
  fs.symlinkSync(inside, linkIn);
  fs.symlinkSync(outside, linkOut);
  assert.throws(() => createAccessPolicy({ ...env, DISCORD_RIGHTS_FILE: linkIn }), /outside the provider workspace/);
  assert.throws(() => createAccessPolicy({ ...env, DISCORD_RIGHTS_FILE: linkOut }), /outside the provider workspace/);
  assert.doesNotThrow(() => createAccessPolicy({ ...env, DISCORD_RIGHTS_FILE: outside }));
});

test("a raw bot.manage grant does not confer administrator or unrelated capabilities", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-management-rights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rights.json");
  fs.writeFileSync(file, JSON.stringify({ grants: [{ userId: "101", capabilities: ["bot.manage"] }] }));
  const policy = createAccessPolicy({ DISCORD_ALLOWED_USERS: "100", DISCORD_ADMIN_USERS: "100", DISCORD_RIGHTS_FILE: file });
  const subject = { userId: "101", guildId: "200" };
  assert.equal(policy.can(subject, "bot.manage"), true);
  assert.equal(policy.isExplicitAdmin(subject), false);
  assert.equal(policy.canUseAdminCommands("101"), false);
  for (const capability of ["workspace.manage", "mcp.manage", "session.configure", "schedule.ai.create", "schedule.message.create", "schedule.manage.guild"] as const) {
    assert.equal(policy.can(subject, capability), false, capability);
  }
});

test("graceful shutdown drains a claimed run and leaves its recurring schedule enabled", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draining-schedule-"));
  const file = path.join(dir, "schedules.sqlite");
  const store = new ScheduleStore(file);
  const gate = deferred();
  const sent: string[] = [];
  const scheduler = new Scheduler(store, createAccessPolicy({ DISCORD_ADMIN_USERS: "100" }), {
    authorize: async () => {},
    generate: async () => { await gate.promise; return [{ content: "Completed during shutdown" }]; },
    send: async (_task, part, _nonce, beforeSend) => { beforeSend(); sent.push(part.content); return "message-id"; },
  }, limits);
  scheduler.start();
  t.after(async () => { gate.resolve(); await scheduler.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const task = await scheduler.create(admin, input);
  const runId = await scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  const stopping = scheduler.stop();
  await assert.rejects(() => scheduler.runNow(admin, task.id), /not running/);
  gate.resolve();
  await stopping;
  assert.deepEqual(sent, ["Completed during shutdown"]);
  const reopened = new ScheduleStore(file);
  assert.equal(reopened.get(task.id)?.enabled, true);
  assert.equal(reopened.getRun(runId)?.state, "succeeded");
  assert.deepEqual(reopened.getRun(runId)?.messageIds, ["message-id"]);
  reopened.close();
});

test("an inaccessible manager's manual attempt leaves the owner's schedule and cooldown unchanged", async t => {
  const f = fixture(t, { authorize: async (_task, actorId) => {
    if (actorId === "101") throw new ScheduleAccessError("Actor cannot access destination");
  } }, { DISCORD_ADMIN_USERS: "100,101" });
  const task = await f.scheduler.create(admin, input);
  await assert.rejects(f.scheduler.runNow({ userId: "101", guildId: "200" }, task.id), /Actor cannot access/);
  assert.deepEqual(f.store.get(task.id), task);
  assert.deepEqual(f.store.runs(task.id), []);
  await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  assert.deepEqual(f.sent, ["Reminder"]);
});

test("an inaccessible manager cannot consume another owner's saved delivery retry", async t => {
  let generated = 0;
  let sends = 0;
  const f = fixture(t, {
    authorize: async (_task, actorId) => { if (actorId === "101") throw new ScheduleAccessError("Actor cannot access destination"); },
    generate: async () => { generated++; return [{ content: "Saved output" }]; },
    send: async () => { if (++sends === 1) throw new DeliveryRejectedError("Rejected"); return "message-id"; },
  }, { DISCORD_ADMIN_USERS: "100,101" });
  const task = await f.scheduler.create(admin, input);
  const runId = await f.scheduler.runNow(admin, task.id);
  await f.scheduler.idle();
  const beforeTask = f.store.get(task.id);
  const beforeRun = f.store.getRun(runId);
  await assert.rejects(f.scheduler.retryDelivery({ userId: "101", guildId: "200" }, task.id, runId), /Actor cannot access/);
  assert.deepEqual(f.store.get(task.id), beforeTask);
  assert.deepEqual(f.store.getRun(runId), beforeRun);
  await f.scheduler.retryDelivery(admin, task.id, runId);
  await f.scheduler.idle();
  assert.equal(f.store.getRun(runId)?.state, "succeeded");
  assert.equal(generated, 1);
});

test("shutdown while a manual request authorizes cannot admit a late run", async t => {
  const gate = deferred();
  let block = false;
  const f = fixture(t, { authorize: async (_task, actorId) => { if (block && actorId) await gate.promise; } });
  const task = await f.scheduler.create(admin, input);
  block = true;
  const pending = f.scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  await f.scheduler.stop();
  gate.resolve();
  await assert.rejects(pending, /not running/);
  assert.deepEqual(f.sent, []);
});

test("editing a task during manual authorization rejects the stale request without claiming it", async t => {
  const gate = deferred();
  let block = false;
  const f = fixture(t, { authorize: async (task, actorId) => {
    if (block && actorId && task.content === "Reminder") await gate.promise;
  } });
  const task = await f.scheduler.create(admin, input);
  block = true;
  const pending = f.scheduler.runNow(admin, task.id);
  await new Promise(resolve => setImmediate(resolve));
  await f.scheduler.edit(admin, task.id, { content: "Changed destination prompt" });
  gate.resolve();
  await assert.rejects(pending, /Schedule changed/);
  assert.equal(f.store.get(task.id)?.enabled, true);
  assert.deepEqual(f.store.runs(task.id), []);
  assert.deepEqual(f.sent, []);
});
