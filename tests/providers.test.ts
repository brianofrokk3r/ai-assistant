import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, isUnsupported } from "../src/sessionManager.js";
import { createProvider } from "../src/providers/index.js";
import { CopilotProvider } from "../src/providers/copilot.js";
import type { Thread } from "@openai/codex-sdk";
import { SessionStore } from "../src/common/sessionStore.js";
import { CodexProvider } from "../src/providers/codex.js";
import { OpenCodeProvider } from "../src/providers/opencode.js";
import { RunTimeoutError, UnsupportedError } from "../src/providers/types.js";
import { ProviderStore } from "../src/common/providerStore.js";
import { SENSITIVE_DIRECTORY_NAME_LIST } from "../src/common/providerSecurity.js";

for (const cooperative of [true, false]) test(`Codex host cancellation settles generation (cooperative=${cooperative})`, { timeout: 3000 }, async t => {
  const previous = process.env.AI_CANCELLATION_GRACE_MS;
  process.env.AI_CANCELLATION_GRACE_MS = '20';
  t.after(() => { if (previous === undefined) delete process.env.AI_CANCELLATION_GRACE_MS; else process.env.AI_CANCELLATION_GRACE_MS = previous; });
  const provider = testCodex();
  t.after(() => provider.shutdown());
  const controller = new AbortController();
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let signal!: AbortSignal;
  (provider as any).sessions.set('cancel', { id: 'cancel-thread', run: (_input: unknown, options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      if (cooperative) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      began();
    });
  } });
  const rejected = assert.rejects(provider.sendMessage('cancel', 'work', undefined, { signal: controller.signal }), /host stopped/);
  await started;
  controller.abort(new Error('host stopped'));
  await rejected;
  assert.equal(signal.aborted, true);
  if (!cooperative) assert.equal((provider as any).sessions.has('cancel'), false);
});

test('Copilot host cancellation invokes abort and does not wait for the provider deadline', { timeout: 3000 }, async t => {
  const provider = new CopilotProvider();
  const controller = new AbortController();
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let aborted = 0;
  let unsubscribed = 0;
  const session = { on: () => () => { unsubscribed++; }, send: async () => { began(); }, abort: async () => { aborted++; } };
  (provider as any).withLiveSession = async (_key: string, action: (session: unknown) => Promise<unknown>) => action(session);
  (provider as any).abandonTimedOutSession = () => {};
  t.after(() => provider.shutdown());
  const rejected = assert.rejects(provider.sendMessage('cancel', 'work', undefined, { signal: controller.signal }), /host stopped/);
  await started;
  controller.abort(new Error('host stopped'));
  await rejected;
  assert.equal(aborted, 1);
  assert.equal(unsubscribed, 1);
});

test('OpenCode host cancellation terminates the active CLI process', { timeout: 5000 }, async t => {
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'opencode-cancel-'));
  const ready = join(dir, 'ready');
  const binary = join(dir, 'fake-opencode');
  writeFileSync(binary, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const previous = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = binary;
  const controller = new AbortController();
  const provider = new OpenCodeProvider();
  t.after(async () => {
    controller.abort(); await provider.shutdown();
    if (previous === undefined) delete process.env.OPENCODE_BIN; else process.env.OPENCODE_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const rejected = assert.rejects(provider.sendMessage('cancel', 'work', undefined, { signal: controller.signal }), /abort/i);
  for (let i = 0; !existsSync(ready) && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(ready), true);
  const pid = Number(readFileSync(ready, 'utf8'));
  controller.abort(new Error('host stopped'));
  await rejected;
  let alive = true;
  for (let i = 0; alive && i < 200; i++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
    catch { alive = false; }
  }
  assert.equal(alive, false);
});

// These transport/artifact tests inject threads directly. Context transitions have
// separate tests exercising the real session creation path and the Codex runtime.
function testCodex(): CodexProvider {
  const provider = new CodexProvider(undefined, new SessionStore("test", join(mkdtempSync(join(tmpdir(), "codex-provider-test-")), "sessions.json")));
  const internal = provider as unknown as {
    sessions: Map<string, Thread>;
    getOrCreateSession: (key: string, ...args: unknown[]) => Promise<Thread>;
  };
  const create = internal.getOrCreateSession.bind(provider);
  internal.getOrCreateSession = async (key, ...args) => internal.sessions.get(key) ?? create(key, ...args);
  return provider;
}

function makeStore(): ProviderStore {
  const dir = mkdtempSync(join(tmpdir(), "ai-provider-"));
  return new ProviderStore(join(dir, "providers.json"));
}

test("createProvider returns the matching provider implementation", () => {
  assert.ok(createProvider("copilot") instanceof CopilotProvider);
  assert.ok(createProvider("codex") instanceof CodexProvider);
  assert.ok(createProvider("opencode") instanceof OpenCodeProvider);
});

test("createProvider rejects unknown providers", () => {
  assert.throws(() => createProvider("does-not-exist"), /Unknown PROVIDER/);
});

test("SessionManager facade selects and exposes the active provider", () => {
  const codex = new SessionManager("codex");
  assert.equal(codex.name, "codex");
  assert.equal(codex.displayName, "OpenAI Codex");

  const opencode = new SessionManager("opencode");
  assert.equal(opencode.name, "opencode");
  assert.equal(opencode.displayName, "OpenCode");
});

test("Codex provider reports unsupported features via UnsupportedError", async () => {
  const codex = testCodex();
  const err = await codex.listAgents().catch((e: unknown) => e);
  assert.ok(err instanceof UnsupportedError);
  assert.ok(isUnsupported(err));
  assert.match((err as Error).message, /does not support/i);
});

test("Codex provider reads the default reasoning effort from the environment", async () => {
  const previous = process.env.CODEX_REASONING_EFFORT;
  process.env.CODEX_REASONING_EFFORT = "max";
  try {
    const codex = testCodex();
    assert.equal(await codex.getCurrentReasoningEffort("user-1"), "max");
  } finally {
    if (previous === undefined) delete process.env.CODEX_REASONING_EFFORT;
    else process.env.CODEX_REASONING_EFFORT = previous;
  }
});

test("Codex starts threads in fresh and legacy shared workspaces", async t => {
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const previousRoot = process.env.AI_ASSISTANT_WORKSPACE_ROOT;
  const root = mkdtempSync(join(tmpdir(), "codex-fresh-workspace-"));
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = root;
  let expectedWorkspace = root;
  let expectedLegacyFiles = false;
  const codex = new CodexProvider(() => ({
    startThread: options => {
      assert.equal(options?.workingDirectory, expectedWorkspace);
      for (const name of SENSITIVE_DIRECTORY_NAME_LIST) {
        const state = statSync(join(expectedWorkspace, name));
        assert.equal(state.isDirectory(), !expectedLegacyFiles);
        if (expectedLegacyFiles) assert.equal(state.size, 0);
      }
      return { run: async () => ({ finalResponse: "Ready", items: [] }) } as unknown as Thread;
    },
    resumeThread: () => { throw new Error("Unexpected resume"); },
  }), new SessionStore("test", join(root, "sessions.json")));
  t.after(async () => {
    await codex.shutdown();
    if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
    else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
    if (previousRoot === undefined) delete process.env.AI_ASSISTANT_WORKSPACE_ROOT;
    else process.env.AI_ASSISTANT_WORKSPACE_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });
  for (const key of ["default-workspace", "scheduled-workspace", "legacy-workspace"]) {
    const workspace = key === "default-workspace" ? root : join(root, ".scheduled-runs", key);
    if (key !== "default-workspace") {
      mkdirSync(workspace, { recursive: true });
      codex.setSessionWorkingDir(key, workspace);
    }
    expectedLegacyFiles = key === "legacy-workspace";
    if (expectedLegacyFiles) {
      for (const name of SENSITIVE_DIRECTORY_NAME_LIST) {
        writeFileSync(join(workspace, name), "", { mode: 0o444 });
      }
    }
    assert.equal(existsSync(join(workspace, ".codex")), expectedLegacyFiles);
    expectedWorkspace = workspace;
    assert.equal((await codex.sendMessage(key, "Check workspace")).content, "Ready");
  }
});

test("Codex long runs report progress and abort at the hard timeout", async () => {
  const previousProgress = process.env.AI_PROGRESS_INTERVAL_MS;
  const previousTimeout = process.env.CODEX_TIMEOUT_MS;
  process.env.AI_PROGRESS_INTERVAL_MS = "10";
  process.env.CODEX_TIMEOUT_MS = "40";
  try {
    const codex = testCodex();
    const internal = codex as unknown as {
      sessions: Map<string, { id: string; run: (_input: unknown, options: { signal: AbortSignal }) => Promise<never> }>;
    };
    let abortObserved = false;
    let progressCalls = 0;
    internal.sessions.set("long-codex-run", {
      id: "test-thread",
      run: (_input, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
    });

    const error = await codex.sendMessage("long-codex-run", "work", undefined, {
      onProgress: () => { progressCalls += 1; },
    }).catch((caught: unknown) => caught);
    assert.ok(error instanceof RunTimeoutError);
    assert.equal(error.cancellationConfirmed, true);
    assert.equal(abortObserved, true);
    assert.ok(progressCalls >= 1);
  } finally {
    if (previousProgress === undefined) delete process.env.AI_PROGRESS_INTERVAL_MS;
    else process.env.AI_PROGRESS_INTERVAL_MS = previousProgress;
    if (previousTimeout === undefined) delete process.env.CODEX_TIMEOUT_MS;
    else process.env.CODEX_TIMEOUT_MS = previousTimeout;
  }
});

test("Codex hard deadline releases the request when abort does not settle", async () => {
  const previousTimeout = process.env.CODEX_TIMEOUT_MS;
  const previousGrace = process.env.AI_CANCELLATION_GRACE_MS;
  process.env.CODEX_TIMEOUT_MS = "30";
  process.env.AI_CANCELLATION_GRACE_MS = "20";
  try {
    const codex = testCodex();
    const internal = codex as unknown as {
      sessions: Map<string, { id: string; run: () => Promise<never> }>;
    };
    internal.sessions.set("hung-codex-run", {
      id: "hung-thread",
      run: () => new Promise(() => {}),
    });

    const error = await codex.sendMessage("hung-codex-run", "work").catch((caught: unknown) => caught);
    assert.ok(error instanceof RunTimeoutError);
    assert.equal(error.cancellationConfirmed, false);
    assert.equal(internal.sessions.has("hung-codex-run"), false);
  } finally {
    if (previousTimeout === undefined) delete process.env.CODEX_TIMEOUT_MS;
    else process.env.CODEX_TIMEOUT_MS = previousTimeout;
    if (previousGrace === undefined) delete process.env.AI_CANCELLATION_GRACE_MS;
    else process.env.AI_CANCELLATION_GRACE_MS = previousGrace;
  }
});

test("Codex rejects oversized text attachments before invoking a turn", async () => {
  const previousLimit = process.env.CODEX_MAX_INLINE_ATTACHMENT_BYTES;
  process.env.CODEX_MAX_INLINE_ATTACHMENT_BYTES = "8";
  const directory = mkdtempSync(join(tmpdir(), "codex-large-attachment-"));
  const file = join(directory, "large.svg");
  writeFileSync(file, "x".repeat(20));
  try {
    const codex = testCodex();
    const internal = codex as unknown as { sessions: Map<string, { id: string; run: () => Promise<never> }> };
    let invoked = false;
    internal.sessions.set("large-file", { id: "thread", run: async () => { invoked = true; throw new Error(); } });
    await assert.rejects(
      () => codex.sendMessage("large-file", "inspect", [{ path: file, displayName: "large.svg", kind: "file" }]),
      /large\.svg.*too large.*20 bytes.*limit 8/,
    );
    assert.equal(invoked, false);
  } finally {
    if (previousLimit === undefined) delete process.env.CODEX_MAX_INLINE_ATTACHMENT_BYTES;
    else process.env.CODEX_MAX_INLINE_ATTACHMENT_BYTES = previousLimit;
  }
});

test("Codex receives a readable binary input path instead of UTF-8 video contents", async () => {
  const { readFileSync } = await import("node:fs");
  const codex = testCodex();
  const workspace = mkdtempSync(join(tmpdir(), "codex-binary-"));
  const input = join(workspace, "video.mp4");
  const video = Buffer.from([0, 255, 128, 0, 24, 102, 116, 121, 112]);
  writeFileSync(input, video);
  const internal = codex as unknown as { sessions: Map<string, unknown>; workingDirOverrides: Map<string, string> };
  internal.workingDirOverrides.set("binary", workspace);
  internal.sessions.set("binary", { id: "binary-thread", run: async (prompt: string) => {
    const inventory = JSON.parse(prompt.match(/\n(\[\{"filename".*\])\n<\/artifact-inputs>/)![1]);
    assert.equal(inventory[0].binary, true);
    assert.notEqual(inventory[0].path, input);
    assert.deepEqual(readFileSync(inventory[0].path), video);
    assert.ok(!prompt.includes("\ufffd"));
    return { finalResponse: "Input received", items: [] };
  } });
  try {
    const result = await codex.sendMessage("binary", "convert this", [{ path: input, displayName: "video.mp4", kind: "file", binary: true }]);
    assert.equal(result.content, "Input received");
  } finally { await codex.shutdown(); }
});

test("Codex captures completed image-generation paths without an artifact marker", async () => {
  const previousHome = process.env.CODEX_HOME;
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const codexHome = mkdtempSync(join(tmpdir(), "codex-generated-home-"));
  const generatedDirectory = join(codexHome, "generated_images", "run-1");
  mkdirSync(generatedDirectory, { recursive: true });
  const savedPath = join(generatedDirectory, "result.png");
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  writeFileSync(savedPath, png);
  process.env.CODEX_HOME = codexHome;
  process.env.AI_ASSISTANT_SECURITY_MODE = "unrestricted";
  try {
    const codex = testCodex();
    const internal = codex as unknown as { sessions: Map<string, unknown> };
    const workspace = mkdtempSync(join(tmpdir(), "codex-image-workspace-"));
    codex.setSessionWorkingDir("image-run", workspace);
    internal.sessions.set("image-run", {
      id: "thread",
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: "item.completed", item: { type: "imageGeneration", status: "completed", savedPath } };
          yield { type: "item.completed", item: { type: "agent_message", id: "answer", text: "Done." } };
          yield { type: "turn.completed", usage: {} };
        })(),
      }),
    });
    const response = await codex.sendMessage("image-run", "make an image");
    assert.equal(response.content, "Done.");
    assert.equal(response.attachments[0].displayName, "generated-image-1.png");
    assert.deepEqual(response.attachments[0].data, png);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
    else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
  }
});

test("Codex delivers the selected final artifact instead of discovered intermediate images", async () => {
  const previousHome = process.env.CODEX_HOME;
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const codexHome = mkdtempSync(join(tmpdir(), "codex-generated-home-"));
  const generatedDirectory = join(codexHome, "generated_images", "thread-final");
  mkdirSync(generatedDirectory, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.AI_ASSISTANT_SECURITY_MODE = "unrestricted";
  try {
    const codex = testCodex();
    const internal = codex as unknown as { sessions: Map<string, unknown> };
    const workspace = mkdtempSync(join(tmpdir(), "codex-image-workspace-"));
    codex.setSessionWorkingDir("selected-output", workspace);
    internal.sessions.set("selected-output", {
      id: "thread-final",
      runStreamed: async (input: string) => {
        const directory = input.match(/Save outputs under (.+?)\/\./)![1];
        writeFileSync(join(workspace, directory, "final.png"), "final edited image");
        const savedPath = join(generatedDirectory, "intermediate.png");
        writeFileSync(savedPath, "intermediate image");
        writeFileSync(join(generatedDirectory, "another.png"), "another intermediate");
        return {
          events: (async function* () {
            yield { type: "item.completed", item: { type: "imageGeneration", status: "completed", savedPath } };
            yield { type: "item.completed", item: {
              type: "agent_message", id: "answer", text: `Done.\n[[artifact:${directory}/final.png]]`,
            } };
            yield { type: "turn.completed", usage: {} };
          })(),
        };
      },
    });
    const response = await codex.sendMessage("selected-output", "make an image");
    assert.equal(response.content, "Done.");
    assert.deepEqual(response.attachments.map((file) => file.displayName), ["final.png"]);
    assert.equal(response.attachments[0].data.toString(), "final edited image");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
    else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
  }
});

test("Codex finds new thread-scoped generated images omitted from the SDK stream", async () => {
  const previousHome = process.env.CODEX_HOME;
  const previousMode = process.env.AI_ASSISTANT_SECURITY_MODE;
  const codexHome = mkdtempSync(join(tmpdir(), "codex-generated-home-"));
  const threadId = "thread-fallback";
  const generatedDirectory = join(codexHome, "generated_images", threadId);
  const otherThreadDirectory = join(codexHome, "generated_images", "other-thread");
  mkdirSync(generatedDirectory, { recursive: true });
  mkdirSync(otherThreadDirectory, { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  writeFileSync(join(generatedDirectory, "older.png"), png);
  writeFileSync(join(otherThreadDirectory, "unrelated.png"), png);
  process.env.CODEX_HOME = codexHome;
  process.env.AI_ASSISTANT_SECURITY_MODE = "unrestricted";
  try {
    const codex = testCodex();
    const internal = codex as unknown as { sessions: Map<string, unknown> };
    const workspace = mkdtempSync(join(tmpdir(), "codex-image-workspace-"));
    codex.setSessionWorkingDir("image-fallback", workspace);
    internal.sessions.set("image-fallback", {
      id: threadId,
      runStreamed: async () => {
        writeFileSync(join(generatedDirectory, "fresh.png"), png);
        return {
          events: (async function* () {
            yield { type: "item.completed", item: { type: "agent_message", id: "answer", text: "Done." } };
            yield { type: "turn.completed", usage: {} };
          })(),
        };
      },
    });

    const response = await codex.sendMessage("image-fallback", "make an image");
    assert.equal(response.content, "Done.");
    assert.equal(response.attachments.length, 1);
    assert.equal(response.attachments[0].displayName, "generated-image-1.png");
    assert.deepEqual(response.attachments[0].data, png);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousMode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE;
    else process.env.AI_ASSISTANT_SECURITY_MODE = previousMode;
  }
});

test("OpenCode provider reports unsupported features via UnsupportedError", async () => {
  const opencode = new OpenCodeProvider();
  const err = await opencode.compact().catch((e: unknown) => e);
  assert.ok(err instanceof UnsupportedError);
  assert.ok(isUnsupported(err));
});

test("OpenCode provider returns empty MCP status (not configured via this bot)", async () => {
  const opencode = new OpenCodeProvider();
  assert.deepEqual(opencode.getMcpStatus("user-1"), []);
});

test("SessionManager switches active provider per key and falls back to default", async () => {
  const sm = new SessionManager("codex", makeStore());
  assert.equal(sm.activeProviderName("user-9"), "codex");
  await sm.setSessionProvider("user-9", "opencode");
  assert.equal(sm.activeProviderName("user-9"), "opencode");
  assert.equal(sm.activeProviderDisplayName("user-9"), "OpenCode");
  // Other keys unaffected, fall back to the default provider.
  assert.equal(sm.activeProviderName("unrelated-key"), "codex");
});

test("setting a session provider to the default clears the override", async () => {
  const sm = new SessionManager("codex", makeStore());
  await sm.setSessionProvider("user-9", "opencode");
  assert.equal(sm.activeProviderName("user-9"), "opencode");
  await sm.setSessionProvider("user-9", "codex"); // default provider
  assert.equal(sm.activeProviderName("user-9"), "codex");
});

test("setSessionProvider rejects unknown providers", () => {
  const sm = new SessionManager("codex", makeStore());
  assert.throws(() => sm.setSessionProvider("user-9", "does-not-exist"), /Unknown provider/);
});

test("SessionManager rejects an invalid default provider", () => {
  assert.throws(() => new SessionManager("nope"), /Unknown PROVIDER/);
});

test("session provider override persists across SessionManager instances", async () => {
  const store = makeStore();
  const first = new SessionManager("codex", store);
  await first.setSessionProvider("user-9", "opencode");

  const second = new SessionManager("codex", store);
  assert.equal(second.activeProviderName("user-9"), "opencode");
});
