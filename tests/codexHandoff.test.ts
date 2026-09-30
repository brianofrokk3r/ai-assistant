import assert from "node:assert/strict";
import test from "node:test";
import type { Thread, ThreadItem } from "@openai/codex-sdk";
import { HANDOFF_SCHEMA, parseHandoff, summarizeHandoff } from "../src/providers/codexHandoff.js";

test("handoffs accept the production overage and enforce the hard boundary", () => {
  for (const length of [12_000, 12_857, 16_000]) {
    const summary = "x".repeat(length);
    assert.equal(parseHandoff(JSON.stringify({ summary })), summary);
  }
  assert.throws(() => parseHandoff(JSON.stringify({ summary: "x".repeat(16_001) })), /exceeds 16000/);
});

test("completed handoffs tolerate non-fatal diagnostics while retaining validation and tool guards", async () => {
  const diagnostic: ThreadItem = { id: "notice", type: "error", message: "Non-fatal runtime diagnostic" };
  const signal = new AbortController().signal;
  const summarize = (finalResponse: string, items: ThreadItem[] = [diagnostic]) => summarizeHandoff({
    run: async () => ({ finalResponse, items, usage: null }),
  }, signal);
  const valid = JSON.stringify({ summary: "Keep PROJECT_ORCHID." });
  assert.equal(await summarize(valid), "Keep PROJECT_ORCHID.");
  await assert.rejects(summarize("invalid JSON"), SyntaxError);
  await assert.rejects(summarize(valid, [diagnostic, {
    id: "tool", type: "command_execution", command: "echo unsafe", aggregated_output: "", status: "completed", exit_code: 0,
  }]), /tool operation/);
  await assert.rejects(summarizeHandoff({ run: async () => { throw new Error("Codex turn failed"); } }, signal), /Codex turn failed/);
});

test("oversized handoffs shorten once on the same thread with the same schema and abort signal", async () => {
  const signal = new AbortController().signal;
  const prompts: string[] = [];
  const thread: Pick<Thread, "run"> = {
    run: async (input, options) => {
      assert.equal(typeof input, "string");
      prompts.push(String(input));
      assert.equal(options?.signal, signal);
      assert.equal(options?.outputSchema, HANDOFF_SCHEMA);
      return { finalResponse: JSON.stringify({ summary: prompts.length === 1 ? "x".repeat(16_001) : "Keep PROJECT_ORCHID." }), items: [], usage: null };
    },
  };
  assert.equal(await summarizeHandoff(thread, signal), "Keep PROJECT_ORCHID.");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /at most 12000 characters/);
  assert.match(prompts[1], /Shorten it to at most 12000 characters/);
  assert.match(prompts[1], /Do not perform any tasks or use tools/);
});

test("shortening still rejects tool attempts and honors cancellation", async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    const thread: Pick<Thread, "run"> = {
      run: async () => {
        calls++;
        if (calls === 1) return { finalResponse: JSON.stringify({ summary: "x".repeat(16_001) }), items: [], usage: null };
        if (cancelled) controller.abort(new Error("Request deadline reached"));
        const items: ThreadItem[] = cancelled ? [] : [{ id: "tool", type: "command_execution", command: "echo unsafe", aggregated_output: "", status: "completed", exit_code: 0 }];
        return { finalResponse: JSON.stringify({ summary: "Short enough." }), items, usage: null };
      },
    };
    await assert.rejects(summarizeHandoff(thread, controller.signal), cancelled ? /deadline reached/ : /tool operation/);
    assert.equal(calls, 2);
  }
});
