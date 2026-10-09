import { randomUUID } from "node:crypto";
import type { ConversationRef, Principal } from "../core/conversation.js";
import type { ProviderName } from "../providers/types.js";
import type { ScheduleCreateInput, ScheduleEditPatch, ScheduleService } from "../scheduling/service.js";
import { scheduleDestination, type ScheduledTask } from "../scheduling/types.js";
import { SCHEDULE_TOOLS } from "./scheduleToolDefinitions.js";

export interface ScheduleToolContext {
  service: ScheduleService;
  actor: Principal;
  conversation: ConversationRef;
  defaults: { timezone: string; provider: ProviderName; model?: string; reasoning?: string };
}
export interface ScheduleToolRun { id: string }
export const createScheduleToolRun = (): ScheduleToolRun => ({ id: randomUUID() });

function date(value: unknown, clearable = false): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (clearable && String(value).toLowerCase() === "none") return undefined;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error("Dates must be valid ISO-8601 instants.");
  return parsed;
}
function count(value: unknown, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error("context_messages must be an integer.");
  return parsed;
}
function summary(task: ScheduledTask): Record<string, unknown> {
  const destination = scheduleDestination(task);
  return { id: task.id, enabled: task.enabled, kind: task.kind, cron: task.cron, timezone: task.timezone,
    next_run_at: new Date(task.nextRunAt).toISOString(), destination: { channel_id: destination.channelId, thread_id: destination.threadId } };
}

export class ScheduleTools {
  readonly id: string;
  readonly controller = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private calls = 0;
  constructor(readonly run: ScheduleToolRun, readonly context: ScheduleToolContext) { this.id = run.id; }
  async cancel(): Promise<void> { this.controller.abort(); await this.queue.catch(() => {}); }
  async close(): Promise<void> { await this.cancel(); }
  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const operation = this.queue.catch(() => {}).then(async () => {
      this.controller.signal.throwIfAborted();
      if (args.run_id !== this.id) throw new Error("This schedule run has expired or belongs to another response.");
      if (++this.calls > 30) throw new Error("Schedule tool call limit reached for this response.");
      const schema = SCHEDULE_TOOLS.find(tool => tool.name === name)?.inputSchema;
      if (!schema || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw new Error("Invalid schedule tool arguments.");
      for (const key of schema.required) if (typeof args[key] !== "string" || !(args[key] as string).trim()) throw new Error(`Missing ${key}.`);
      for (const value of Object.values(args)) if (typeof value !== "string" || value.length > 20_000) throw new Error("Tool arguments must be strings of bounded length.");
      if (name === "create_schedule") return this.create(args);
      if (name === "list_schedules") return { schedules: this.context.service.list(this.context.actor).map(summary) };
      if (name === "inspect_schedule") return this.inspect(args);
      if (name === "edit_schedule") return this.edit(args);
      const id = String(args.schedule_id);
      if (name === "pause_schedule") { this.context.service.pause(this.context.actor, id); return { status: "paused", schedule_id: id }; }
      if (name === "resume_schedule") { await this.context.service.resume(this.context.actor, id); return { status: "resumed", schedule_id: id }; }
      if (name === "delete_schedule") { this.context.service.delete(this.context.actor, id); return { status: "deleted", schedule_id: id }; }
      if (name === "run_schedule_now") return { status: "started", schedule_id: id, schedule_run_id: await this.context.service.runNow(this.context.actor, id) };
      if (name === "retry_schedule_delivery") { await this.context.service.retryDelivery(this.context.actor, id, String(args.schedule_run_id)); return { status: "retry_started", schedule_id: id }; }
      throw new Error("Unknown schedule tool.");
    });
    this.queue = operation;
    return operation;
  }
  private destination() {
    const { conversation, actor } = this.context;
    if (actor.platform !== "slack" || conversation.platform !== "slack" || actor.tenantId !== conversation.tenantId) {
      throw new Error("Schedule identity is unavailable or inconsistent for this transport.");
    }
    return { version: 1 as const, platform: "slack" as const, tenantId: actor.tenantId, installationId: conversation.installationId,
      channelId: conversation.channelId, threadId: conversation.threadId, kind: conversation.kind };
  }
  private async create(args: Record<string, unknown>): Promise<unknown> {
    const kind = String(args.kind) as "message" | "ai";
    const provider = (args.provider || this.context.defaults.provider) as ProviderName;
    if (!(["message", "ai"] as string[]).includes(kind)) throw new Error("kind must be message or ai.");
    if (!(["copilot", "codex", "opencode"] as string[]).includes(provider)) throw new Error("Unsupported AI provider.");
    const model = String(args.model || this.context.defaults.model || "") || undefined;
    if (kind === "ai" && !model) throw new Error("AI scheduling requires a configured or explicit model.");
    const input: ScheduleCreateInput = { guildId: this.context.actor.tenantId, channelId: this.context.conversation.channelId,
      destination: this.destination(), kind, content: String(args.content), cron: String(args.cron), timezone: String(args.timezone || this.context.defaults.timezone),
      contextMessages: kind === "ai" ? count(args.context_messages, 0) : 0, startAt: date(args.start_at), endAt: date(args.end_at),
      ...(kind === "ai" ? { provider, model, reasoning: String(args.reasoning || this.context.defaults.reasoning || "") || undefined } : {}) };
    const proposal = await this.context.service.proposeCreate(this.context.actor, this.context.conversation, input);
    return { status: "confirmation_required", proposal_id: proposal.id, expires_at: new Date(proposal.expiresAt).toISOString(), summary: proposal.summary, confirmation: `confirm ${proposal.id}`, cancellation: `cancel ${proposal.id}` };
  }
  private inspect(args: Record<string, unknown>): unknown {
    const result = this.context.service.inspect(this.context.actor, this.context.conversation, String(args.schedule_id));
    return { schedule: { ...summary(result.task), content: result.task.content, context_messages: result.task.contextMessages, provider: result.task.provider, model: result.task.model, reasoning: result.task.reasoning }, redacted: result.redacted,
      recent_runs: result.runs.slice(0, 20).map(run => ({ id: run.id, state: run.state, occurrence: run.occurrence, error: run.error })) };
  }
  private async edit(args: Record<string, unknown>): Promise<unknown> {
    const patch: ScheduleEditPatch = {};
    if (args.content !== undefined) patch.content = String(args.content);
    if (args.cron !== undefined) patch.cron = String(args.cron);
    if (args.timezone !== undefined) patch.timezone = String(args.timezone);
    if (args.context_messages !== undefined) patch.contextMessages = count(args.context_messages, 0);
    if (args.provider !== undefined) {
      if (!(["copilot", "codex", "opencode"] as string[]).includes(String(args.provider))) throw new Error("Unsupported AI provider.");
      patch.provider = String(args.provider) as ProviderName;
    }
    if (args.model !== undefined) patch.model = String(args.model);
    if (args.reasoning !== undefined) patch.reasoning = String(args.reasoning).toLowerCase() === "none" ? undefined : String(args.reasoning);
    if (args.start_at !== undefined) patch.startAt = date(args.start_at, true);
    if (args.end_at !== undefined) patch.endAt = date(args.end_at, true);
    const proposal = await this.context.service.proposeEdit(this.context.actor, this.context.conversation, String(args.schedule_id), patch);
    return { status: "confirmation_required", proposal_id: proposal.id, expires_at: new Date(proposal.expiresAt).toISOString(), summary: proposal.summary, confirmation: `confirm ${proposal.id}`, cancellation: `cancel ${proposal.id}` };
  }
}
