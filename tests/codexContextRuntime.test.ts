import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { CodexProvider } from "../src/providers/codex.js";
import { SessionStore } from "../src/common/sessionStore.js";

interface ModelRequest {
  model: string;
  input: { role?: string; content?: { text?: string }[] }[];
  tools?: { type: string; name?: string }[];
  text?: { format?: { type?: string } };
}

test("real Codex runtime refreshes instructions through a restricted handoff and resumes after restart", { timeout: 90_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "codex-context-runtime-"));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  mkdirSync(home); mkdirSync(workspace);
  const keys = ["AI_ASSISTANT_SYSTEM_PROMPT", "AI_ASSISTANT_SYSTEM_PROMPT_FILE", "AI_ASSISTANT_SECURITY_MODE", "USER_INSTRUCTION_MODE", "CODEX_MODEL"] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  process.env.AI_ASSISTANT_SECURITY_MODE = "unrestricted";
  process.env.USER_INSTRUCTION_MODE = "off";
  process.env.CODEX_MODEL = "gpt-6-astra";
  delete process.env.AI_ASSISTANT_SYSTEM_PROMPT_FILE;
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_ALPHA";
  const requests: ModelRequest[] = [];
  let invalidHandoff = false;
  let attemptPatch = false;
  let failUserTurn = false;
  let compactTest = false;
  let reportLargeUsage = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
    requests.push(body);
    const handoff = body.text?.format?.type === "json_schema";
    if (!handoff && failUserTurn) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Test request rejected", type: "invalid_request_error" } }));
      return;
    }
    const text = handoff ? invalidHandoff ? "invalid handoff" : JSON.stringify({ summary: "Alice chose PROJECT_ORCHID. Pending: finish the report.".padEnd(12_857, ".") }) : "Ready.";
    const item = handoff && attemptPatch
      ? { type: "custom_tool_call", name: "apply_patch", id: "patch_attempt", call_id: "patch_attempt", input: `*** Begin Patch\n*** Add File: ${join(workspace, "handoff-forbidden.txt").replaceAll("\\", "/")}\n+must not be written\n*** End Patch` }
      : { type: "message", role: "assistant", id: "answer", content: [{ type: "output_text", text }] };
    if (handoff) attemptPatch = false;
    const inputTokens = reportLargeUsage ? 2_000 : 10;
    reportLargeUsage = false;
    const events = [
      { type: "response.created", response: { id: `response_${requests.length}` } },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { id: `response_${requests.length}`, usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } } },
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value && ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"].includes(key.toUpperCase()))) as Record<string, string>;
  Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, NO_PROXY: "127.0.0.1,localhost" });
  const makeClient = (options: CodexOptions) => new Codex({
    ...options, codexPathOverride: undefined, apiKey: undefined, baseUrl: undefined, env,
    config: {
      ...options.config,
      ...(compactTest ? { model_auto_compact_token_limit: 1_000, compact_prompt: "COMPACT_CONTEXT_HISTORY" } : {}),
      model_provider: "context_test", model_providers: { context_test: { name: "Local test", base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: "responses", requires_openai_auth: false, supports_websockets: false } },
      analytics: { enabled: false }, feedback: { enabled: false },
    },
  });
  const store = new SessionStore("test", join(directory, "sessions.json"));
  let provider = new CodexProvider(makeClient, store);
  t.after(() => provider.shutdown());
  provider.setSessionWorkingDir("conversation", workspace);
  await provider.sendMessage("conversation", "Alice chose PROJECT_ORCHID.", undefined, { timeoutMs: 20_000 });
  const firstId = store.get("conversation");
  const developerText = (request: ModelRequest) => request.input.filter(item => item.role === "developer").flatMap(item => item.content?.map(part => part.text) ?? []).join("\n");
  assert.match(developerText(requests[0]), /POLICY_ALPHA/);
  assert.equal(requests[0].model, "gpt-6-astra");

  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_BETA";
  process.env.CODEX_MODEL = "gpt-6.1-sol";
  invalidHandoff = true;
  await assert.rejects(provider.sendMessage("conversation", "Finish the report.", undefined, { timeoutMs: 20_000 }));
  assert.equal(store.get("conversation"), firstId);
  invalidHandoff = false;
  await provider.sendMessage("conversation", "Finish the report.", undefined, { timeoutMs: 20_000 });
  assert.notEqual(store.get("conversation"), firstId);
  const refreshed = requests.at(-1)!;
  assert.equal(refreshed.model, "gpt-6.1-sol");
  assert.match(developerText(refreshed), /POLICY_BETA/);
  assert.doesNotMatch(developerText(refreshed), /POLICY_ALPHA/);
  assert.match(JSON.stringify(refreshed.input), /PROJECT_ORCHID/);
  assert.equal(store.getState("conversation")?.handoff, undefined);
  const summaryRequests = requests.filter(request => request.text?.format?.type === "json_schema");
  assert.equal(summaryRequests.length, 2);
  // Codex exposes apply_patch based on model metadata, even with execution features disabled.
  // Its read-only permission policy must reject it; no other tools may be advertised.
  for (const request of summaryRequests) {
    assert.equal(request.model, "gpt-6.1-sol");
    assert.ok((request.tools ?? []).every(tool => tool.name === "apply_patch"));
  }

  const refreshedId = store.get("conversation");
  await provider.shutdown();
  provider = new CodexProvider(makeClient, new SessionStore("test", join(directory, "sessions.json")));
  provider.setSessionWorkingDir("conversation", workspace);
  await provider.sendMessage("conversation", "Continue.", undefined, { timeoutMs: 20_000 });
  assert.equal(new SessionStore("test", join(directory, "sessions.json")).get("conversation"), refreshedId);
  assert.equal(requests.filter(request => request.text?.format?.type === "json_schema").length, 2);
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_GAMMA";
  attemptPatch = true;
  await provider.sendMessage("conversation", "Continue.", undefined, { timeoutMs: 20_000 });
  assert.match(JSON.stringify(requests.at(-2)?.input), /reject|denied|not allowed|read.only/i);
  assert.equal(existsSync(join(workspace, "handoff-forbidden.txt")), false);

  const beforeFailure = new SessionStore("test", join(directory, "sessions.json")).get("conversation");
  process.env.AI_ASSISTANT_SYSTEM_PROMPT = "POLICY_DELTA";
  failUserTurn = true;
  await assert.rejects(provider.sendMessage("conversation", "Finish the report.", undefined, { timeoutMs: 20_000 }));
  const pending = new SessionStore("test", join(directory, "sessions.json")).getState("conversation");
  assert.notEqual(pending?.sessionId, beforeFailure);
  assert.match(pending?.handoff ?? "", /PROJECT_ORCHID/);
  await provider.shutdown();
  provider = new CodexProvider(makeClient, new SessionStore("test", join(directory, "sessions.json")));
  provider.setSessionWorkingDir("conversation", workspace);
  const summaryCount = requests.filter(request => request.text?.format?.type === "json_schema").length;
  failUserTurn = false;
  await provider.sendMessage("conversation", "Retry the report.", undefined, { timeoutMs: 20_000 });
  const recovered = new SessionStore("test", join(directory, "sessions.json")).getState("conversation");
  // Native resume can reject an interrupted first turn. The adapter may transfer
  // the saved handoff once more, without needing to summarize that broken thread.
  assert.ok(recovered?.sessionId);
  assert.equal(recovered?.handoff, undefined);
  assert.match(JSON.stringify(requests.at(-1)?.input), /PROJECT_ORCHID/);
  assert.match(developerText(requests.at(-1)!), /POLICY_DELTA/);
  assert.equal(requests.filter(request => request.text?.format?.type === "json_schema").length, summaryCount);

  // Force native auto-compaction and observe the next actual model request.
  compactTest = true;
  await provider.shutdown();
  provider = new CodexProvider(makeClient, new SessionStore("test", join(directory, "sessions.json")));
  provider.setSessionWorkingDir("conversation", workspace);
  const beforeCompaction = requests.length;
  reportLargeUsage = true;
  await provider.sendMessage("conversation", "Accumulate history.", undefined, { timeoutMs: 20_000 });
  await provider.sendMessage("conversation", "Continue after compaction.", undefined, { timeoutMs: 20_000 });
  assert.ok(requests.slice(beforeCompaction).some(request => JSON.stringify(request.input).includes("COMPACT_CONTEXT_HISTORY")));
  assert.match(developerText(requests.at(-1)!), /POLICY_DELTA/);
  assert.equal(new SessionStore("test", join(directory, "sessions.json")).get("conversation"), recovered?.sessionId);
});
