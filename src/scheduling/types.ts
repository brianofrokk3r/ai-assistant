import type { ProviderName } from "../providers/types.js";
import type { LookupRecord } from "../utils/fetchWebpage.js";
export type SchedulePlatform = "discord" | "slack";
export interface ScheduleDestination {
  version: 1;
  platform: SchedulePlatform;
  tenantId: string;
  channelId: string;
  threadId?: string;
  installationId?: string;
  kind?: "channel" | "thread" | "direct";
  /** Hash of the verified destination audience at creation/edit time. */
  audienceHash?: string;
}
export interface ScheduledTask {
  id: string;
  /** Legacy Discord alias. New records use destination.tenantId. */
  guildId: string;
  ownerId: string;
  /** Legacy channel alias retained for Discord command compatibility. */
  channelId: string;
  destination?: ScheduleDestination;
  kind: "message" | "ai";
  content: string;
  cron: string;
  timezone: string;
  /** Inclusive start, stored as an absolute Unix timestamp in milliseconds. */
  startAt?: number;
  /** Exclusive cutoff, stored as an absolute Unix timestamp in milliseconds. */
  endAt?: number;
  provider?: ProviderName;
  model?: string;
  reasoning?: string;
  contextMessages: number;
  enabled: boolean;
  nextRunAt: number;
  revision: number;
  createdAt: number;
  lastStartedAt?: number;
  pauseReason?: string;
  /** Source-backed, model-reported values; always stale context on later runs. */
  lastVerifiedLookups?: LookupRecord[];
}
export type RunState = "queued" | "running" | "ready" | "sending" | "succeeded" | "failed" | "delivery_failed" | "uncertain" | "cancelled";
export interface DeliveryPart { content: string; attachment?: { name: string; base64: string } }
export interface TaskRun {
  id: string; taskId: string; channelId: string; taskRevision: number; occurrence: string; startedAt: number;
  destination?: ScheduleDestination;
  state: RunState; parts: DeliveryPart[]; messageIds: string[]; error?: string;
  lookups?: LookupRecord[];
  /** Generation restarts for this occurrence; bounds crash loops without disabling the schedule. */
  recoveryAttempts?: number;
}

export function scheduleDestination(task: Pick<ScheduledTask, "guildId" | "channelId" | "destination">): ScheduleDestination {
  return task.destination ?? { version: 1, platform: "discord", tenantId: task.guildId, channelId: task.channelId, kind: "channel" };
}
export function schedulePlatform(task: Pick<ScheduledTask, "guildId" | "channelId" | "destination">): SchedulePlatform {
  return scheduleDestination(task).platform;
}
export function scheduleOwnerKey(task: Pick<ScheduledTask, "ownerId" | "guildId" | "channelId" | "destination">): string {
  const d = scheduleDestination(task);
  return JSON.stringify([d.platform, d.tenantId, task.ownerId]);
}
export function scheduleTenantKey(task: Pick<ScheduledTask, "guildId" | "channelId" | "destination">): string {
  const d = scheduleDestination(task);
  return JSON.stringify([d.platform, d.tenantId]);
}
