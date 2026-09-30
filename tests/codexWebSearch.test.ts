import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexOptions, Thread, ThreadOptions } from "@openai/codex-sdk";
import { resolveSessionContext } from "../src/common/sessionContext.js";
import { SessionStore } from "../src/common/sessionStore.js";
import { CODEX_WEB_SEARCH_MODES, CodexProvider } from "../src/providers/codex.js";
import { SessionManager } from "../src/sessionManager.js";

function thread(id: string): Thread {
  return { id, run: async () => ({ finalResponse: "ready", items: [], usage: null }) } as unknown as Thread;
}

test("Codex resolves hosted web search once and passes it to new and resumed normal threads", async t => {
  const previous = {
    mode: process.env.AI_ASSISTANT_SECURITY_MODE,
    root: process.env.AI_ASSISTANT_WORKSPACE_ROOT,
    search: process.env.CODEX_WEB_SEARCH_MODE,
  };
  const root = mkdtempSync(join(tmpdir(), "codex-web-search-"));
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = root;
  process.env.CODEX_WEB_SEARCH_MODE = " InDeXeD ";
  t.after(() => {
    if (previous.mode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE; else process.env.AI_ASSISTANT_SECURITY_MODE = previous.mode;
    if (previous.root === undefined) delete process.env.AI_ASSISTANT_WORKSPACE_ROOT; else process.env.AI_ASSISTANT_WORKSPACE_ROOT = previous.root;
    if (previous.search === undefined) delete process.env.CODEX_WEB_SEARCH_MODE; else process.env.CODEX_WEB_SEARCH_MODE = previous.search;
    rmSync(root, { recursive: true, force: true });
  });

  const freshOptions: ThreadOptions[] = [];
  const fresh = new CodexProvider(() => ({
    startThread: options => { freshOptions.push(options ?? {}); return thread("fresh"); },
    resumeThread: () => { throw new Error("unexpected resume"); },
  }), new SessionStore("fresh", join(root, "fresh.json")));
  t.after(() => fresh.shutdown());
  process.env.CODEX_WEB_SEARCH_MODE = "disabled";
  await fresh.sendMessage("new", "hello");
  assert.equal(freshOptions[0].webSearchMode as string, "indexed");
  assert.equal((await fresh.getStatus()).providerSecurity?.hostedWebSearch, "indexed");

  process.env.CODEX_WEB_SEARCH_MODE = "live";
  const resumedStore = new SessionStore("resumed", join(root, "resumed.json"));
  resumedStore.set("existing", "saved-thread", resolveSessionContext().applied);
  let resumedOptions: ThreadOptions | undefined;
  const resumed = new CodexProvider(() => ({
    startThread: () => { throw new Error("unexpected start"); },
    resumeThread: (id, options) => { assert.equal(id, "saved-thread"); resumedOptions = options; return thread(id); },
  }), resumedStore);
  t.after(() => resumed.shutdown());
  await resumed.sendMessage("existing", "continue");
  assert.equal(resumedOptions?.webSearchMode, "live");
});

test("invalid Codex hosted web search mode fails provider construction", () => {
  const previous = process.env.CODEX_WEB_SEARCH_MODE;
  process.env.CODEX_WEB_SEARCH_MODE = "internet";
  try {
    assert.throws(
      () => new CodexProvider(),
      /Invalid CODEX_WEB_SEARCH_MODE: internet \(expected disabled, cached, indexed, live\)/,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_SEARCH_MODE;
    else process.env.CODEX_WEB_SEARCH_MODE = previous;
  }
});

test("non-Codex provider initialization ignores invalid Codex hosted web search mode", async t => {
  const previous = process.env.CODEX_WEB_SEARCH_MODE;
  const root = mkdtempSync(join(tmpdir(), "non-codex-web-search-"));
  process.env.CODEX_WEB_SEARCH_MODE = "not-a-mode";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_WEB_SEARCH_MODE;
    else process.env.CODEX_WEB_SEARCH_MODE = previous;
    rmSync(root, { recursive: true, force: true });
  });

  for (const provider of ["copilot", "opencode"] as const) {
    const sessions = new SessionManager(provider, undefined, join(root, provider));
    assert.equal(sessions.name, provider);
    await sessions.shutdown();
  }
});

test("handoff summarization stays search-disabled for every normal conversation mode", async t => {
  const previous = {
    mode: process.env.AI_ASSISTANT_SECURITY_MODE,
    root: process.env.AI_ASSISTANT_WORKSPACE_ROOT,
    search: process.env.CODEX_WEB_SEARCH_MODE,
  };
  const root = mkdtempSync(join(tmpdir(), "codex-web-search-handoff-"));
  process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
  process.env.AI_ASSISTANT_WORKSPACE_ROOT = root;
  t.after(() => {
    if (previous.mode === undefined) delete process.env.AI_ASSISTANT_SECURITY_MODE; else process.env.AI_ASSISTANT_SECURITY_MODE = previous.mode;
    if (previous.root === undefined) delete process.env.AI_ASSISTANT_WORKSPACE_ROOT; else process.env.AI_ASSISTANT_WORKSPACE_ROOT = previous.root;
    if (previous.search === undefined) delete process.env.CODEX_WEB_SEARCH_MODE; else process.env.CODEX_WEB_SEARCH_MODE = previous.search;
    rmSync(root, { recursive: true, force: true });
  });

  for (const mode of CODEX_WEB_SEARCH_MODES) {
    process.env.CODEX_WEB_SEARCH_MODE = mode;
    const store = new SessionStore(`handoff-${mode}`, join(root, `${mode}.json`));
    store.set("conversation", `old-${mode}`);
    const clientOptions: CodexOptions[] = [];
    let normalOptions: ThreadOptions | undefined;
    let handoffOptions: ThreadOptions | undefined;
    const provider = new CodexProvider(options => {
      clientOptions.push(options);
      if (clientOptions.length === 1) return {
        startThread: options => { normalOptions = options; return thread(`new-${mode}`); },
        resumeThread: () => { throw new Error("unexpected normal resume"); },
      };
      return {
        startThread: () => { throw new Error("unexpected handoff start"); },
        resumeThread: (_id, options) => {
          handoffOptions = options;
          return {
            id: `old-${mode}`,
            run: async () => ({ finalResponse: JSON.stringify({ summary: "Retained context." }), items: [], usage: null }),
          } as unknown as Thread;
        },
      };
    }, store);
    try {
      await provider.sendMessage("conversation", "continue");
      assert.equal(clientOptions[1]?.config?.web_search, "disabled");
      assert.equal(handoffOptions?.webSearchMode, "disabled");
      assert.equal(normalOptions?.webSearchMode as string, mode);
    } finally {
      await provider.shutdown();
    }
  }
});
