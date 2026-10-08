import type { IncomingTurn } from "../core/conversation.js";
import type { ProviderName } from "../providers/types.js";
import type { SlackApi } from "../adapters/slack.js";
import type { ScheduleCreateInput, ScheduleService } from "./service.js";

function tokens(value: string): string[] {
  return [...value.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g)].map(match => (match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, "$1"));
}
function options(items: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < items.length; i++) {
    const match = items[i].match(/^--?([a-z][a-z-]*)(?:=(.*))?$/i);
    if (!match) continue;
    result[match[1]] = match[2] ?? items[++i] ?? "";
  }
  return result;
}
const weekdays: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
function recurrence(text: string): { cron: string; timezone?: string } | undefined {
  const explicit = text.match(/(?:cron\s*[:=]\s*)["']?([^"']+?)["']?(?:\s+(?:in|timezone\s*[:=])\s*([A-Za-z_]+\/[A-Za-z_+-]+|UTC))?(?:\s|$)/i);
  if (explicit && explicit[1].trim().split(/\s+/).length === 5) return { cron: explicit[1].trim(), timezone: explicit[2] };
  const at = text.match(/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) { let hour = Number(at[2]) % 12; if (at[4]?.toLowerCase() === "pm") hour += 12; return { cron: `${Number(at[3] ?? 0)} ${hour} * * ${weekdays[at[1].toLowerCase()]}` }; }
  const weekdaysAt = text.match(/every\s+weekday(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (weekdaysAt) { let hour = Number(weekdaysAt[1] ?? 9) % 12; if (weekdaysAt[3]?.toLowerCase() === "pm") hour += 12; return { cron: `${Number(weekdaysAt[2] ?? 0)} ${hour} * * 1-5` }; }
  const daily = text.match(/every\s+day(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (daily) { let hour = Number(daily[1] ?? 9) % 12; if (daily[3]?.toLowerCase() === "pm") hour += 12; return { cron: `${Number(daily[2] ?? 0)} ${hour} * * *` }; }
  return;
}

export class SlackScheduleFrontend {
  constructor(private service: ScheduleService, private api: SlackApi, private defaults: { timezone: string; provider: ProviderName; model?: string; reasoning?: string }) {}
  private async reply(input: IncomingTurn, text: string): Promise<void> {
    await this.api.call("chat.postMessage", { channel: input.conversation.channelId, ...(input.conversation.threadId ? { thread_ts: input.conversation.threadId } : {}), text, parse: "none", unfurl_links: "false", unfurl_media: "false" });
  }
  async handle(input: IncomingTurn): Promise<boolean> {
    const text = input.text.trim();
    const confirm = text.match(/^confirm\s+(proposal_[a-f0-9]+)$/i);
    if (confirm) {
      try {
        const result = await this.service.confirm(input.actor, input.conversation, confirm[1]);
        await this.reply(input, `${result.duplicate ? "Already confirmed" : "Schedule created"}: ${result.task.id}\n${this.service.describe(result.task)}`);
      } catch (error) { await this.reply(input, error instanceof Error ? error.message : "Schedule confirmation failed."); }
      return true;
    }
    const cancel = text.match(/^cancel\s+(proposal_[a-f0-9]+)$/i);
    if (cancel) {
      try { this.service.cancelProposal(input.actor, input.conversation, cancel[1]); await this.reply(input, `Cancelled ${cancel[1]}.`); }
      catch (error) { await this.reply(input, error instanceof Error ? error.message : "Schedule proposal cancellation failed."); }
      return true;
    }
    if (/^schedule\s+(?:create|list|inspect|edit|pause|resume|delete|run-now|retry-delivery)\b/i.test(text)) {
      await this.command(input, text);
      return true;
    }
    if (/\b(schedule|remind|post)\b/i.test(text) && /\bevery\b/i.test(text)) {
      await this.natural(input, text);
      return true;
    }
    return false;
  }
  private async command(input: IncomingTurn, text: string): Promise<void> {
    const values = tokens(text); const action = values[1]?.toLowerCase(); const opts = options(values.slice(2));
    try {
      if (action === "create") {
        if (opts.kind && !["message", "ai"].includes(opts.kind)) throw new Error("--kind must be message or ai.");
        const kind = opts.kind === "ai" ? "ai" : "message";
        if (!opts.content || !opts.cron) throw new Error("Use schedule create --kind message|ai --content \"...\" --cron \"m h dom mon dow\" [--timezone IANA].");
        const proposal = await this.service.proposeCreate(input.actor, input.conversation, this.createInput(input, kind, opts.content, opts.cron, opts.timezone, opts));
        await this.reply(input, `${proposal.summary}\n\nConfirm within 10 minutes with: confirm ${proposal.id}`);
      } else if (action === "list") {
        const tasks = this.service.list(input.actor);
        await this.reply(input, tasks.length ? tasks.map(task => `${task.id} — ${task.enabled ? "enabled" : "paused"} — ${task.cron} ${task.timezone}`).join("\n") : "No manageable schedules.");
      } else if (action === "inspect") {
        if (!values[2]) throw new Error("Use schedule inspect <schedule-id>.");
        const result = this.service.inspect(input.actor, input.conversation, values[2]);
        const links = new Map<string, string>();
        if (!result.redacted) for (const messageId of result.runs.flatMap(run => run.messageIds).filter(id => !id.startsWith("file:")).slice(0, 20)) {
          try { const permalink = await this.api.call("chat.getPermalink", { channel: result.task.channelId, message_ts: messageId }); if (typeof permalink.permalink === "string") links.set(messageId, permalink.permalink); }
          catch { /* A missing permalink must not hide the persisted run. */ }
        }
        await this.reply(input, `${this.service.describe(result.task)}\nStatus: ${result.task.enabled ? "enabled" : `paused (${result.task.pauseReason ?? "no reason"})`}\nRecent runs: ${result.runs.map(run => `${run.id} ${run.state}${run.messageIds.length ? ` (${run.messageIds.map(id => links.get(id) ?? id).join(", ")})` : ""}`).join("; ") || "none"}${result.redacted ? "\nSensitive details are redacted outside the saved destination." : ""}`);
      } else if (action === "edit") {
        const id = values[2]; if (!id) throw new Error("Use schedule edit <schedule-id> --content \"...\" and/or --cron, --timezone, --context-messages, --start-at, --end-at.");
        const patch: Record<string, unknown> = {};
        if (opts.content !== undefined) patch.content = opts.content;
        if (opts.cron !== undefined) patch.cron = opts.cron;
        if (opts.timezone !== undefined) patch.timezone = opts.timezone;
        if (opts.provider !== undefined) patch.provider = opts.provider;
        if (opts.model !== undefined) patch.model = opts.model;
        if (opts.reasoning !== undefined) patch.reasoning = opts.reasoning.toLowerCase() === "none" ? undefined : opts.reasoning;
        if (opts["context-messages"] !== undefined) patch.contextMessages = Number(opts["context-messages"]);
        if (opts.channel !== undefined || opts.thread !== undefined) {
          const channelId = opts.channel ?? input.conversation.channelId;
          patch.channelId = channelId;
          patch.destination = { version: 1, platform: "slack", tenantId: input.actor.tenantId, installationId: input.conversation.installationId,
            channelId, ...(opts.thread ? { threadId: opts.thread, kind: "thread" } : { kind: "channel" }) };
        }
        for (const [option, field] of [["start-at", "startAt"], ["end-at", "endAt"]] as const) if (opts[option] !== undefined) {
          patch[field] = opts[option].toLowerCase() === "none" ? undefined : Date.parse(opts[option]);
        }
        const proposal = await this.service.proposeEdit(input.actor, input.conversation, id, patch as any);
        await this.reply(input, `${proposal.summary}\n\nConfirm this edit within 10 minutes with: confirm ${proposal.id}`);
      } else if (["pause", "resume", "delete", "run-now", "retry-delivery"].includes(action)) {
        const id = values[2]; if (!id) throw new Error(`Use schedule ${action} <schedule-id>.`);
        if (action === "pause") this.service.pause(input.actor, id);
        else if (action === "resume") await this.service.resume(input.actor, id);
        else if (action === "delete") this.service.delete(input.actor, id);
        else if (action === "run-now") await this.service.runNow(input.actor, id);
        else { if (!values[3]) throw new Error("Use schedule retry-delivery <schedule-id> <run-id>."); await this.service.retryDelivery(input.actor, id, values[3]); }
        await this.reply(input, `Schedule ${action} accepted for ${id}.`);
      } else throw new Error("Schedule actions: create, list, inspect, edit, pause, resume, delete, run-now, retry-delivery.");
    } catch (error) { await this.reply(input, error instanceof Error ? error.message : "Schedule operation failed."); }
  }
  private async natural(input: IncomingTurn, text: string): Promise<void> {
    try {
      if (/first business day/i.test(text)) throw new Error("The first business day cannot be represented safely by five-field cron. Please provide a supported cadence.");
      const cadence = recurrence(text); if (!cadence) throw new Error("I could not safely resolve that recurrence. Include a phrase such as ‘every Monday at 9 AM’ or provide a five-field cron expression.");
      if (/latest\s+(?:news|updates)/i.test(text) && !/latest\s+(?:news|updates)\s+(?:about|on|for)\s+\S+/i.test(text)) throw new Error("What topic or scope should the latest-news schedule cover?");
      const ai = /\b(search|summari[sz]e|research|latest|ai\s+action)\b/i.test(text);
      if (ai && !this.defaults.model) throw new Error("AI scheduling needs SCHEDULE_DEFAULT_MODEL or an explicit --model in the deterministic command.");
      const proposal = await this.service.proposeCreate(input.actor, input.conversation,
        this.createInput(input, ai ? "ai" : "message", text, cadence.cron, cadence.timezone, {}));
      await this.reply(input, `${proposal.summary}\n\nConfirm within 10 minutes with: confirm ${proposal.id}`);
    } catch (error) { await this.reply(input, error instanceof Error ? error.message : "Could not interpret the schedule request."); }
  }
  private createInput(input: IncomingTurn, kind: "message" | "ai", content: string, cron: string, timezone?: string, opts: Record<string, string> = {}): ScheduleCreateInput {
    const startAt = opts["start-at"] ? Date.parse(opts["start-at"]) : undefined, endAt = opts["end-at"] ? Date.parse(opts["end-at"]) : undefined;
    const channelId = opts.channel ?? input.conversation.channelId, threadId = opts.thread ?? (opts.channel ? undefined : input.conversation.threadId);
    const destination = { version: 1 as const, platform: "slack" as const, tenantId: input.actor.tenantId, installationId: input.conversation.installationId,
      channelId, threadId, kind: threadId ? "thread" as const : opts.channel ? "channel" as const : input.conversation.kind };
    return { guildId: input.actor.tenantId, channelId, destination, kind, content, cron,
      timezone: timezone || this.defaults.timezone, startAt, endAt, contextMessages: Number(opts["context-messages"] ?? (kind === "ai" ? 20 : 0)),
      ...(kind === "ai" ? { provider: (opts.provider as ProviderName | undefined) ?? this.defaults.provider, model: opts.model ?? this.defaults.model!, reasoning: opts.reasoning ?? this.defaults.reasoning } : {}) };
  }
}
