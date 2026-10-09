import type { LookupRecord } from "../utils/fetchWebpage.js";
import type { ContextProfile, TransportContext } from "../common/sessionContext.js";
import type { AccessPolicy, AccessSubject } from "../common/accessPolicy.js";
import type { UserInstructionContext } from "../utils/userInstructions.js";
import type { ScheduleToolContext } from "../common/scheduleTools.js";

export const PROVIDERS = ["copilot", "codex", "opencode"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function normalizeProviderName(value?: string | null): string {
  return value?.trim().toLowerCase() || "copilot";
}

export class UnsupportedError extends Error {
  constructor(providerName: string, feature: string) {
    super(`The **${providerName}** provider does not support **${feature}**.`);
    this.name = "UnsupportedError";
  }
}

export function isUnsupported(err: unknown): err is UnsupportedError {
  return err instanceof UnsupportedError;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface AgentInfo {
  name: string;
  displayName: string;
  description: string;
}

export interface AuthStatus {
  isAuthenticated: boolean;
  login?: string;
  authType?: string;
  host?: string;
  statusMessage?: string;
}

export interface StatusInfo {
  status: { version?: string };
  authStatus: AuthStatus;
  /** Provider capability diagnostics kept distinct from authentication state. */
  providerSecurity?: {
    hostedWebSearch?: string;
    sandboxedCommandNetwork?: string;
  };
}

export type HistoryEvent =
  | {
      type: "user.message";
      data: { content: string };
    }
  | {
      type: "assistant.message";
      data: { content: string; parentToolCallId?: string };
    };

export interface CompactResult {
  success: boolean;
  tokensRemoved: number;
  messagesRemoved: number;
}

export interface PlanInfo {
  exists: boolean;
  content: string | null;
  path: string | null;
}

export type SessionMode = "interactive" | "plan" | "autopilot";

export interface McpServerStatus {
  name: string;
  source: string;
  enabled: boolean;
  skipped: boolean;
}

export interface SendAttachment {
  path: string;
  displayName?: string;
  kind?: "image" | "file";
  /** Binary files remain on disk; never inline them as UTF-8. */
  binary?: boolean;
}

export interface SendMessageOptions {
  /** Host-owned cancellation for active generation and shutdown. */
  signal?: AbortSignal;
  /** Rebuild host context before retrying a turn in a replacement native session. */
  onSessionRecovery?: () => string;
  /** Host-selected transport. Omitted preserves the Discord compatibility profile. */
  transportContext?: TransportContext;
  contextProfile?: ContextProfile;
  /** Host-selected cap; never extends the provider timeout. */
  timeoutMs?: number;
  onProgress?: (update: { elapsedMs: number; message: string }) => void | Promise<void>;
  /** Host-owned, permission-checked Discord lookup; credentials never reach providers. */
  /** Host-bound current-channel reader. Never supplied by the model or persisted across turns. */
  resolveChannelHistory?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
  resolveArtifactMessage?: (url: string) => Promise<ArtifactMessage>;
  /** Host-observed webpage results and source-backed summaries for scheduled lookups. */
  onLookup?: (record: LookupRecord) => void;
  /** Host-captured Discord permissions shared by ruleset and contribution tools. Never model-supplied. */
  rulesetContext?: {
    requester: AccessSubject;
    access: AccessPolicy;
    guildId?: string | null;
  };
  /** Host-bound schedule service, requester, destination, and trusted defaults. Never model-supplied. */
  scheduleContext?: ScheduleToolContext;
  /** Active Discord speaker whose admin-configured rulesets should affect this turn. */
  userInstructionContext?: UserInstructionContext;
}

export interface ArtifactCandidate {
  url: string;
  name?: string;
  contentType?: string | null;
  size?: number;
  sourceMessage?: string;
}

export interface ArtifactMessage {
  candidates: ArtifactCandidate[];
}

export interface ResponseAttachment {
  data: Buffer;
  displayName: string;
}

export interface AgentResponse {
  content: string;
  attachments: ResponseAttachment[];
}

export class RunTimeoutError extends Error {
  constructor(
    readonly provider: string,
    readonly timeoutMs: number,
    readonly cancellationConfirmed: boolean,
  ) {
    super(`${provider} exceeded its ${timeoutMs}ms hard timeout${cancellationConfirmed ? " and was cancelled" : "; cancellation could not be confirmed"}.`);
    this.name = "RunTimeoutError";
  }
}

/**
 * Provider-agnostic session manager contract. Every slash command handler and
 * the Discord bot talk only to this interface, so a provider can be swapped
 * (Copilot, Codex, OpenCode, …) purely via configuration.
 *
 * Methods a provider cannot implement should throw `UnsupportedError`, which
 * handlers render as a friendly in-Discord message instead of a crash.
 */
export interface Provider {
  /** Stable identifier, e.g. "copilot", "codex", "opencode". */
  readonly name: ProviderName | string;
  /** Human-facing name for /status etc., e.g. "GitHub Copilot". */
  readonly displayName: string;

  sendMessage(userId: string, prompt: string, imagePaths?: SendAttachment[], options?: SendMessageOptions): Promise<AgentResponse>;
  /** Isolated classification: no conversation state or artifact tools. */
  evaluateParticipation?(prompt: string, options: { model?: string; connectionModel?: string; effort: "none" | "low"; timeoutMs: number }): Promise<string>;
  getStatus(): Promise<StatusInfo>;
  getHistory(userId: string): Promise<HistoryEvent[] | null>;
  listModels(): Promise<ModelInfo[]>;
  setModel(userId: string, model: string): Promise<void>;
  getCurrentModel(key: string): Promise<string | undefined>;

  listReasoningEfforts(): Promise<string[]>;
  setReasoningEffort(key: string, effort: string): Promise<void>;
  getCurrentReasoningEffort(key: string): Promise<string>;

  listAgents(key: string): Promise<AgentInfo[]>;
  getCurrentAgent(key: string): Promise<AgentInfo | null>;
  selectAgent(key: string, name: string): Promise<AgentInfo>;
  deselectAgent(key: string): Promise<void>;

  getMode(key: string): Promise<SessionMode>;
  setMode(key: string, mode: SessionMode): Promise<void>;
  compact(key: string): Promise<CompactResult>;
  startFleet(key: string, prompt?: string): Promise<boolean>;
  readPlan(key: string): Promise<PlanInfo>;
  updatePlan(key: string, content: string): Promise<void>;
  deletePlan(key: string): Promise<void>;

  listWorkspaceFiles(key: string): Promise<string[]>;
  readWorkspaceFile(key: string, filePath: string): Promise<string>;
  createWorkspaceFile(key: string, filePath: string, content: string): Promise<void>;

  resetSession(key: string): Promise<void>;
  forgetSession?(key: string): Promise<void>;
  setSessionWorkingDir(key: string, dir: string): void;
  getSessionWorkingDir(key: string): string | undefined;
  setSessionMcpEnabled(key: string, serverName: string, enabled: boolean): void;
  getMcpStatus(key: string): McpServerStatus[];

  shutdown(): Promise<void>;
}

/** Canonical list of reasoning-effort levels shared across providers that support it. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";
