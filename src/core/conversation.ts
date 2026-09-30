/** Transport-neutral contracts. Native SDK objects must not cross this boundary. */
export interface Principal { platform: string; tenantId: string; userId: string }
export interface ConversationRef {
  platform: string; tenantId: string; installationId: string;
  channelId: string; threadId?: string; kind: 'channel' | 'thread' | 'direct';
}
export interface IncomingTurn {
  eventId: string; sourceMessageId?: string; actor: Principal;
  conversation: ConversationRef; text: string; receivedAt: string;
}
export interface Capabilities {
  threads: boolean; progress: boolean; attachments: boolean; history: boolean;
  messageLinks: boolean; memory: boolean; schedules: boolean; directMessages: boolean;
}
export const TEXT_CAPABILITIES: Capabilities = {
  threads: true, progress: true, attachments: false, history: false,
  messageLinks: false, memory: false, schedules: false, directMessages: false,
};
export interface TurnOutput { audienceTag?: string; content: string; attachments: Array<{ data: Buffer; displayName: string }> }
export interface ProgressUpdate { elapsedMs: number; message: string }
export interface DeliveryReceipt { messageIds: string[] }
export type TurnState = 'accepted' | 'running' | 'generated' | 'delivering' | 'delivered' | 'failed' | 'cancelled' | 'interrupted';
export interface TurnRecord {
  id: string; sessionKey: string; input: IncomingTurn; state: TurnState; updatedAt: string;
  output?: TurnOutput; receipt?: DeliveryReceipt; error?: string;
  retryGeneratedDelivery?: boolean;
}
export interface TurnHandle { id: string; completion: Promise<TurnRecord>; cancel(): void }
export interface PreparedTurn { prompt: string; cleanup?(): Promise<void> }
export interface TrustedAdapterContext<P extends PreparedTurn = PreparedTurn> {
  platform: string; tenantId: string; installationId: string;
  capabilities: Capabilities; audience: 'individual' | 'shared';
  /** Set only when the adapter can replay persisted output after a failed access lookup. */
  retryGeneratedDelivery?: boolean;
  /** Explicit compatibility binding, only set by the Discord adapter. */
  legacySessionKey?: string;
  /** Optional destination creation after durable admission, before execution. */
  resolveSession?(input: IncomingTurn): Promise<string>;
  /** Coordinate the resolved destination around queueing, preparation and delivery. */
  coordinate?(key: string, run: () => Promise<void>): Promise<void>;
  /** False denies access; a thrown check is unavailable. Replay-capable adapters retain generated output. */
  authorize(input: IncomingTurn, stage: "ingress" | "execution" | "delivery", output?: TurnOutput, signal?: AbortSignal): Promise<boolean>;
  prepare(input: IncomingTurn, key: string, signal: AbortSignal): Promise<P>;
  generate(prepared: P, key: string, signal: AbortSignal, progress: (p: ProgressUpdate) => Promise<void>): Promise<TurnOutput>;
  deliver(output: TurnOutput, deliveryKey: string, sessionKey: string, signal: AbortSignal): Promise<DeliveryReceipt>;
  onError?(error: unknown): void;
  progress?(update: ProgressUpdate): Promise<void>;
}
export function validateIdentity(input: IncomingTurn, host: Pick<TrustedAdapterContext, 'platform' | 'tenantId' | 'installationId'>): void {
  const c = input.conversation;
  if (c.platform !== host.platform || c.tenantId !== host.tenantId || c.installationId !== host.installationId
    || input.actor.platform !== c.platform || input.actor.tenantId !== c.tenantId
    || ![c.platform, c.tenantId, c.installationId, c.channelId, input.actor.userId, input.eventId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512)
    || (c.kind === 'thread' && !c.threadId) || !['channel', 'thread', 'direct'].includes(c.kind)
    || typeof input.text !== 'string' || input.text.length > 100_000 || !Number.isFinite(Date.parse(input.receivedAt))) {
    throw new Error('Invalid or mismatched conversation identity.');
  }
}
export function sessionKey(input: IncomingTurn, audience: 'individual' | 'shared'): string {
  const c = input.conversation;
  return JSON.stringify(['conversation-v1', c.platform, c.tenantId, c.installationId, c.channelId, c.kind,
    c.threadId ?? null, audience, audience === 'individual' ? input.actor.userId : null]);
}
export function eventKey(input: IncomingTurn): string {
  const c = input.conversation;
  return JSON.stringify([c.platform, c.tenantId, c.installationId, input.eventId]);
}

export interface HistoryMessage {
  id: string; authorId: string; text: string; timestamp: number; position: string;
  threadId?: string; url?: string; revision?: string;
}
export interface HistoryPage { messages: HistoryMessage[]; cursor?: string; truncated?: boolean }
export interface HistoryPort {
  /** Must enforce requester and response-audience visibility on every call. */
  page(resource: ConversationRef, before: string, cursor: string | undefined, signal: AbortSignal, range?: HistoryRange): Promise<HistoryPage>;
  includeAuthor(authorId: string): boolean;
  resolveMessageReference(url: string, resource: ConversationRef): string | undefined;
}
export type HistoryRange = { kind: 'recent'; count: number } | { kind: 'after'; position: string }
  | { kind: 'previous' } | { kind: 'time'; timestamp: number };
export interface HistoryResult {
  messages: HistoryMessage[];
  /** Host-only observations before context selection. Never serialize into provider prompts. */
  observed?: { messages: HistoryMessage[]; complete: boolean };
  coverage: { status: 'complete' | 'partial' | 'empty' | 'unavailable'; requested: HistoryRange;
    scanned: number; included: number; excluded: number; reasons: string[]; first?: string; last?: string; before: string };
}
