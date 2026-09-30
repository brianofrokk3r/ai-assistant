/**
 * Type-safe chat classification shared by every transport. A conversation form
 * is classified with the same typed Jev Choice vocabulary the participation
 * evaluator uses for Discord, so the host never invents a classification string.
 *
 * Classification is host-derived from transport identity, never from message
 * text, and never asked of a provider. Discord classifies a thread as ambient
 * because ambient participation also runs there; transports that only start a
 * turn from an explicit request classify every admitted form as directed.
 */
import type { JevParticipationChoice } from "./participationEvaluator.js";

/** Conversation forms, identical to the neutral conversation reference kinds. */
export const CHAT_FORMS = ["channel", "thread", "direct"] as const;
export type ChatForm = (typeof CHAT_FORMS)[number];
export const CHAT_PLATFORMS = ["discord", "slack", "cli"] as const;
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];

/**
 * Every classification is a member of the evaluator's typed vocabulary, checked
 * by the compiler here rather than asserted at each call site.
 */
export const CHAT_CLASSIFICATIONS = {
  /** The current speaker addressed the assistant, so the request always answers. */
  directed: "direct_reply",
  /** Ambient conversation the assistant was not addressed in. */
  ambient: "ignore",
} as const satisfies Record<string, JevParticipationChoice>;
export type ChatClassificationValue = (typeof CHAT_CLASSIFICATIONS)[keyof typeof CHAT_CLASSIFICATIONS];

export interface ChatClassification {
  platform: ChatPlatform;
  form: ChatForm;
  /** Established Jev choice. Never a free-form string. */
  choice: ChatClassificationValue;
}

/** A form the platform's own normalization cannot produce is never guessed at. */
export class UnsupportedChatFormError extends Error {
  override name = "UnsupportedChatFormError";
}

const PLATFORM_CHAT_CLASSIFICATIONS: Readonly<Record<ChatPlatform, Readonly<Record<ChatForm, ChatClassificationValue>>>> = {
  // Discord threads also host ambient participation, which is classified per message.
  discord: { channel: CHAT_CLASSIFICATIONS.ambient, thread: CHAT_CLASSIFICATIONS.ambient, direct: CHAT_CLASSIFICATIONS.directed },
  // Slack and CLI turns only begin from an explicit request addressed to the assistant.
  slack: { channel: CHAT_CLASSIFICATIONS.directed, thread: CHAT_CLASSIFICATIONS.directed, direct: CHAT_CLASSIFICATIONS.directed },
  cli: { channel: CHAT_CLASSIFICATIONS.directed, thread: CHAT_CLASSIFICATIONS.directed, direct: CHAT_CLASSIFICATIONS.directed },
};

const CHAT_FORM_LABELS: Readonly<Record<ChatForm, string>> = {
  channel: "channel", thread: "thread", direct: "direct message",
};

const CLASSIFICATION_INSTRUCTIONS: Readonly<Record<ChatClassificationValue, string>> = {
  [CHAT_CLASSIFICATIONS.directed]: "The request is addressed to you and always receives an answer.",
  [CHAT_CLASSIFICATIONS.ambient]: "This is ambient conversation you were not addressed in; answer only when the request clearly addresses you.",
};

/** The minimum host-derived identity a conversation reference must expose. */
export interface ChatReference {
  platform: string;
  kind: string;
  threadId?: string;
}

export function isChatPlatform(value: unknown): value is ChatPlatform {
  return typeof value === "string" && CHAT_PLATFORMS.some(platform => platform === value);
}

export function isChatForm(value: unknown): value is ChatForm {
  return typeof value === "string" && CHAT_FORMS.some(form => form === value);
}

function describe(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? JSON.stringify(value) : "an unsupported value";
}

/**
 * Classifies one conversation reference. Unsupported platforms, unknown forms and
 * thread forms without their thread identity are rejected explicitly instead of
 * falling back to an untyped classification.
 */
export function classifyChat(reference: ChatReference): ChatClassification {
  if (!isChatPlatform(reference.platform)) throw new UnsupportedChatFormError("Unsupported chat platform: " + describe(reference.platform) + ".");
  if (!isChatForm(reference.kind)) throw new UnsupportedChatFormError("Unsupported chat form: " + describe(reference.kind) + ".");
  if (reference.kind === "thread" && !reference.threadId) throw new UnsupportedChatFormError("Thread chat form requires its thread identity.");
  return { platform: reference.platform, form: reference.kind, choice: PLATFORM_CHAT_CLASSIFICATIONS[reference.platform][reference.kind] };
}

/** Host-derived statement of the current turn's classification for the agent. */
export function chatClassificationInstructions(classification: ChatClassification): string {
  return "This " + classification.platform + " " + CHAT_FORM_LABELS[classification.form]
    + " chat is classified " + classification.choice + " (Jev): " + CLASSIFICATION_INSTRUCTIONS[classification.choice];
}