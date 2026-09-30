import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_CLASSIFICATIONS,
  CHAT_FORMS,
  CHAT_PLATFORMS,
  chatClassificationInstructions,
  classifyChat,
  isChatForm,
  isChatPlatform,
  UnsupportedChatFormError,
} from "../src/common/chatClassification.js";
import { JEV_CHOICES } from "../src/common/participationEvaluator.js";
import { resolveSessionContext } from "../src/common/sessionContext.js";

test("every declared classification is a validated member of the evaluator's typed vocabulary", () => {
  const values = Object.values(CHAT_CLASSIFICATIONS);
  assert.deepEqual(values, ["direct_reply", "ignore"]);
  for (const value of values) {
    assert.ok(JEV_CHOICES.some((choice) => choice === value), value + " is outside the Jev choice vocabulary");
  }
});

for (const platform of CHAT_PLATFORMS) for (const form of CHAT_FORMS) {
  test(platform + " " + form + " chats classify to a typed Jev choice", () => {
    const classification = classifyChat({ platform, kind: form, ...(form === "thread" ? { threadId: "1700000001.000000" } : {}) });
    assert.deepEqual(Object.keys(classification).sort(), ["choice", "form", "platform"]);
    assert.equal(classification.platform, platform);
    assert.equal(classification.form, form);
    assert.ok(Object.values(CHAT_CLASSIFICATIONS).some(value => value === classification.choice));
  });
}

test("Slack classifies every admitted form as a directed request, Discord threads stay ambient", () => {
  assert.equal(classifyChat({ platform: "slack", kind: "direct" }).choice, "direct_reply");
  assert.equal(classifyChat({ platform: "slack", kind: "channel" }).choice, "direct_reply");
  assert.equal(classifyChat({ platform: "slack", kind: "thread", threadId: "1700000001.000000" }).choice, "direct_reply");
  assert.equal(classifyChat({ platform: "discord", kind: "thread", threadId: "1" }).choice, "ignore");
  assert.equal(classifyChat({ platform: "discord", kind: "direct" }).choice, "direct_reply");
});

for (const reference of [
  { platform: "slack", kind: "group" },
  { platform: "slack", kind: "direct_message" },
  { platform: "slack", kind: "" },
  { platform: "slack", kind: "thread" },
  { platform: "slack", kind: "thread", threadId: "" },
  { platform: "teams", kind: "channel" },
  { platform: "", kind: "channel" },
]) {
  test("unsupported or ambiguous form " + JSON.stringify(reference) + " is rejected explicitly", () => {
    assert.throws(() => classifyChat(reference), (error: unknown) => error instanceof UnsupportedChatFormError
      && /Unsupported chat form|Unsupported chat platform|requires its thread identity/.test(error.message));
  });
}

test("platform and form guards accept only declared values", () => {
  assert.equal(isChatPlatform("slack"), true);
  assert.equal(isChatPlatform("Slack"), false);
  assert.equal(isChatPlatform(undefined), false);
  assert.equal(isChatForm("thread"), true);
  assert.equal(isChatForm("threads"), false);
  assert.equal(isChatForm("direct_message"), false);
  assert.equal(isChatForm(null), false);
});

test("every transport statement stays separated from the next one", () => {
  for (const classification of [
    classifyChat({ platform: "slack", kind: "channel" }),
    classifyChat({ platform: "slack", kind: "thread", threadId: "1700000001.000000" }),
    classifyChat({ platform: "slack", kind: "direct" }),
  ]) {
    for (const transportContext of [
      { platform: "slack", history: true, attachments: true } as const,
      { platform: "slack", history: true, attachments: true, classification },
      { platform: "cli", history: false, attachments: false, classification },
    ]) {
      const { systemPrompt } = resolveSessionContext({ transportContext });
      const transport = systemPrompt.slice(systemPrompt.indexOf("You are responding through"), systemPrompt.indexOf("Retrieved messages"));
      assert.ok(transport.length > 0, "transport instructions are missing");
      assert.doesNotMatch(transport, /[.!?]\S/, "a transport statement is glued to the next one");
    }
  }
});

test("an admitted direct-message turn classifies as directed and stops claiming DMs are unavailable", () => {
  const direct = classifyChat({ platform: "slack", kind: "direct" });
  const context = resolveSessionContext({ transportContext: { platform: "slack", history: true, attachments: true, classification: direct } });
  assert.match(context.systemPrompt, /This slack direct message chat is classified direct_reply \(Jev\)/);
  assert.doesNotMatch(context.systemPrompt, /DMs, persistent memory/);
  assert.match(context.systemPrompt, /Persistent memory, schedules, ruleset management and GitHub contribution tools are unavailable\./);
  const channel = resolveSessionContext({ transportContext: { platform: "slack", history: true, attachments: true, classification: classifyChat({ platform: "slack", kind: "channel" }) } });
  assert.match(channel.systemPrompt, /DMs, persistent memory, schedules, ruleset management and GitHub contribution tools are unavailable\./);
});

test("the classification reaches the agent through the transport session context", () => {
  const thread = classifyChat({ platform: "slack", kind: "thread", threadId: "1700000001.000000" });
  const bare = resolveSessionContext({ transportContext: { platform: "slack", history: true, attachments: true } });
  const classified = resolveSessionContext({ transportContext: { platform: "slack", history: true, attachments: true, classification: thread } });
  assert.doesNotMatch(bare.systemPrompt, /classified/);
  assert.match(classified.systemPrompt, /This slack thread chat is classified direct_reply \(Jev\)/);
  assert.match(classified.systemPrompt, /always receives an answer/);
  assert.deepEqual(classified.transportContext?.classification, thread);
  assert.notEqual(classified.applied.capabilities, bare.applied.capabilities);
  assert.notEqual(classified.fingerprint, bare.fingerprint);
  assert.ok(classified.systemPrompt.includes(chatClassificationInstructions(thread)));
  const ambient = classifyChat({ platform: "discord", kind: "channel" });
  assert.equal(ambient.choice, CHAT_CLASSIFICATIONS.ambient);
  assert.equal(chatClassificationInstructions(ambient),
    "This discord channel chat is classified ignore (Jev): This is ambient conversation you were not addressed in; answer only when the request clearly addresses you.");
});
