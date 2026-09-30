import fs from "fs";
import { ParticipationProcessRunner } from "./participationProcess.js";
import { createRequire } from "node:module";
import os from "os";
import path from "path";
import { Codex } from "@openai/codex-sdk";
import { SessionStore } from "../common/sessionStore.js";
import { McpConfigLoader } from "../common/mcpConfig.js";
import { providerSystemPrompt } from "../common/systemPrompt.js";
import { contextFingerprint, resolveSessionContext, sameContext, withContextTurn } from "../common/sessionContext.js";
import { codexHandoffOptions, summarizeHandoff, withHandoff } from "./codexHandoff.js";
import { captureAgentArtifacts, withArtifactOutputPrompt } from "../common/agentResponse.js";
import { ArtifactToolSessions, artifactInputPrompt } from "../common/artifactToolBridge.js";
import { RulesetToolSessions, rulesetToolPrompt } from "../common/rulesetToolBridge.js";
import { GitHubContributionSessions, githubContributionPrompt } from "../common/githubContributionToolBridge.js";
import { codexHostMcpOverride, codexHostMcpOverrides } from "../common/hostMcpConfig.js";
import { UserVisibleError } from "../common/userVisibleError.js";
import { configuredMilliseconds, providerTimeout, startProgressUpdates } from "../common/runLifecycle.js";
import { CODEX_WEB_SEARCH_MODES, configuredSecurityMode, configuredSitesEnabled, configuredCodexWebSearchMode, ensureProviderWorkingDirectory, providerChildEnvironment, resolveConfiguredWorkspace, SENSITIVE_DIRECTORY_DENY_GLOBS, SENSITIVE_DIRECTORY_NAME_LIST, SENSITIVE_FILE_DENY_GLOBS, SENSITIVE_PATH_ALLOW_GLOBS, secureSystemPrompt, } from "../common/providerSecurity.js";
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS, UnsupportedError, RunTimeoutError, } from "./types.js";
import { readFile, stat } from "node:fs/promises";
const require = createRequire(import.meta.url);
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_INLINE_ATTACHMENT_BYTES = 200_000;
const MAX_CODEX_INLINE_ATTACHMENT_BYTES = 1_000_000;
// Codex app policy keys are catalog connector IDs, not tool namespace/display names.
export const CODEX_SITES_CONNECTOR_ID = "connector_20205bf7d4e99a89d7154bb849718324";
export const CODEX_SITES_GIT_HOST = "git.chatgpt-team.site";
export const CODEX_PACKAGE_HOST = "registry.npmjs.org";
export { CODEX_WEB_SEARCH_MODES, configuredCodexWebSearchMode };
export const CODEX_GITHUB_READ_ONLY_TOOLS = [
    "get_repo",
    "fetch",
    "fetch_file",
    "search_repositories",
];
const CODEX_PERMISSION_PROFILE = "discord-bot";
const CODEX_DEVELOPMENT_INSTRUCTIONS = [
    "Keep edited source in the assigned workspace. For builds and tests, copy current source and dependency manifests into a fresh directory under the session TMPDIR.",
    "This private scratch supports npm's hidden files and executable dependencies without relaxing workspace credential restrictions.",
    "Use npm ci --include=dev --no-audit --no-fund --fetch-retries=0 followed by npm run check when available. Only registry.npmjs.org is allowed for package downloads.",
    "For other local test commands, use NO_PROXY=localhost,127.0.0.1,::1 so test servers stay inside the Linux sandbox's loopback namespace. Use temporary test state and never production credentials.",
    "Report actual build and test results; parsing or stripping TypeScript is not type checking. Copy deliverables back into the workspace before cleanup; session scratch is removed on reset or shutdown.",
].join(" ");
export function createCodexSessionTemporaryDirectory() {
    const root = process.env.AI_ASSISTANT_CODEX_TMPDIR?.trim() || os.tmpdir();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(root, "ai-assistant-codex-"));
    fs.chmodSync(directory, 0o700);
    return directory;
}
export function prepareCodexWorkingDirectory(directory) {
    if (configuredSecurityMode() !== "shared")
        return;
    const workspace = resolveConfiguredWorkspace(directory);
    // Codex 0.159.2 protects credential directories even when absent. Explicit
    // denials can otherwise mask missing paths as files, colliding with directory
    // mounts in Bubblewrap. Establish missing paths as directories while preserving
    // existing regular files (including legacy denial placeholders). The policy
    // denies both types; symlinks and special files remain rejected.
    for (const name of SENSITIVE_DIRECTORY_NAME_LIST) {
        const sensitiveDirectory = path.join(workspace, name);
        try {
            fs.mkdirSync(sensitiveDirectory, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const existing = fs.lstatSync(sensitiveDirectory);
            if (!existing.isDirectory() && !existing.isFile())
                throw error;
        }
    }
}
export function codexFilesystemPermissionOverride(sitesEnabled = false) {
    const sensitiveRules = [
        ...SENSITIVE_FILE_DENY_GLOBS.map((glob) => `${JSON.stringify(glob)}="deny"`),
        ...SENSITIVE_PATH_ALLOW_GLOBS.map((glob) => `${JSON.stringify(glob)}="write"`),
        ...(sitesEnabled
            ? [".openai", ".openai/**"]
                .map((glob) => `${JSON.stringify(glob)}="write"`)
            : []),
        // Directory denials come last so no nested filename exception can override them.
        ...SENSITIVE_DIRECTORY_DENY_GLOBS.map((glob) => `${JSON.stringify(glob)}="deny"`),
    ].join(",");
    return `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={":root"="deny",":minimal"="read",":tmpdir"="write",glob_scan_max_depth=8,":workspace_roots"={"."="write",${sensitiveRules}}}`;
}
export function codexNetworkPermissionOverride(sitesEnabled = false) {
    const hosts = [CODEX_PACKAGE_HOST, ...(sitesEnabled ? [CODEX_SITES_GIT_HOST] : [])];
    const domains = hosts.map(host => `${JSON.stringify(host)}="allow"`).join(",");
    // On Linux, Unix sockets stay confined by the filesystem and isolated network namespace.
    // Codex otherwise blocks even sockets created by tests inside private scratch.
    return `permissions.${CODEX_PERMISSION_PROFILE}.network={enabled=true,mode="${sitesEnabled ? "full" : "limited"}",allow_local_binding=false,allow_upstream_proxy=false,dangerously_allow_all_unix_sockets=${process.platform === "linux"},domains={${domains}}}`;
}
export function codexThreadSecurityOptions(source = process.env) {
    return configuredSecurityMode(source) === "unrestricted"
        ? { sandboxMode: "danger-full-access", networkAccessEnabled: true }
        : {};
}
export function codexShellEnvironment(workingDirectory, childEnvironment) {
    const allowedNames = new Set([
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
        "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "NPM_CONFIG_NODEDIR",
    ]);
    const result = Object.fromEntries(Object.entries(childEnvironment).filter(([name]) => allowedNames.has(name.toUpperCase())));
    result.HOME = workingDirectory;
    result.USERPROFILE = workingDirectory;
    // Keep npm state out of denied dotfiles and never read an operator's npm login.
    result.NPM_CONFIG_CACHE = path.join(childEnvironment.TMPDIR, "npm-cache");
    result.NPM_CONFIG_USERCONFIG = os.devNull;
    return result;
}
/** Host-owned settings that Discord prompts and project config cannot relax. */
export function codexClientOptions(temporaryDirectory, artifacts, rulesets, systemPrompt = secureSystemPrompt(providerSystemPrompt()), github, sitesEnabled = configuredSitesEnabled(), textTransport = false) {
    if (configuredSecurityMode() === "unrestricted") {
        return {
            ...(process.env.CODEX_EXECUTABLE_PATH?.trim()
                ? { codexPathOverride: process.env.CODEX_EXECUTABLE_PATH.trim() }
                : {}),
            ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
            ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
            config: { developer_instructions: systemPrompt, ...(textTransport ? { apps: { [CODEX_SITES_CONNECTOR_ID]: { enabled: false } }, features: { plugins: false } } : {}) },
            ...(artifacts || rulesets || github ? { configOverrides: codexHostMcpOverrides(artifacts, rulesets, false, github) } : {}),
        };
    }
    if (!temporaryDirectory) {
        throw new Error("Shared Codex clients require an isolated temporary directory.");
    }
    const workingDirectory = ensureProviderWorkingDirectory();
    const childEnvironment = Object.fromEntries(Object.entries(providerChildEnvironment("codex"))
        .filter(([name]) => !["TEMP", "TMP", "TMPDIR"].includes(name.toUpperCase())));
    childEnvironment.TEMP = temporaryDirectory;
    childEnvironment.TMP = temporaryDirectory;
    childEnvironment.TMPDIR = temporaryDirectory;
    const tools = Object.fromEntries(CODEX_GITHUB_READ_ONLY_TOOLS.map((tool) => [tool, { enabled: true, approval_mode: "approve" }]));
    return {
        ...(process.env.CODEX_EXECUTABLE_PATH?.trim()
            ? { codexPathOverride: process.env.CODEX_EXECUTABLE_PATH.trim() }
            : {}),
        ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
        env: childEnvironment,
        config: {
            developer_instructions: `${systemPrompt}\n\n${CODEX_DEVELOPMENT_INSTRUCTIONS}`,
            ...(!process.env.OPENAI_API_KEY ? { forced_login_method: "chatgpt" } : {}),
            default_permissions: CODEX_PERMISSION_PROFILE,
            features: {
                apps: true,
                network_proxy: true,
                hooks: false,
                plugins: sitesEnabled,
                remote_plugin: false,
                memories: false,
                computer_use: false,
                browser_use: false,
                browser_use_external: false,
                shell_snapshot: false,
                skill_mcp_dependency_install: false,
                workspace_dependencies: false,
            },
            shell_environment_policy: {
                inherit: "none",
                ignore_default_excludes: false,
                experimental_use_profile: false,
                set: codexShellEnvironment(workingDirectory, childEnvironment),
            },
            apps: {
                _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
                github: {
                    enabled: true,
                    default_tools_enabled: false,
                    destructive_enabled: false,
                    open_world_enabled: false,
                    tools,
                },
                ...(sitesEnabled
                    ? {
                        [CODEX_SITES_CONNECTOR_ID]: {
                            enabled: true,
                            default_tools_enabled: true,
                            default_tools_approval_mode: "approve",
                            destructive_enabled: false,
                            open_world_enabled: true,
                        },
                    }
                    : {}),
            },
        },
        configOverrides: [
            codexHostMcpOverride(artifacts, rulesets, github),
            codexFilesystemPermissionOverride(sitesEnabled),
            codexNetworkPermissionOverride(sitesEnabled),
        ],
    };
}
function configuredInlineAttachmentLimit() {
    return Math.min(configuredMilliseconds("CODEX_MAX_INLINE_ATTACHMENT_BYTES", DEFAULT_CODEX_INLINE_ATTACHMENT_BYTES, 1), MAX_CODEX_INLINE_ATTACHMENT_BYTES);
}
async function readCodexTextAttachment(attachment) {
    const displayName = attachment.displayName ?? path.basename(attachment.path);
    const limit = configuredInlineAttachmentLimit();
    const metadata = await stat(attachment.path);
    if (metadata.size > limit) {
        throw new UserVisibleError(`Attachment \`${displayName}\` is too large to send to Codex as text (${metadata.size} bytes; limit ${limit}).`);
    }
    const text = await readFile(attachment.path, "utf8");
    if (text.length > limit) {
        throw new UserVisibleError(`Attachment \`${displayName}\` is too large to send to Codex as text (${text.length} characters; limit ${limit}).`);
    }
    return text;
}
function normalizedEventKind(value) {
    return typeof value === "string" ? value.replace(/[^a-z]/gi, "").toLowerCase() : "";
}
export function codexGeneratedImagePaths(event) {
    const paths = new Set();
    const visit = (value, imageContext = false, completedContext = false) => {
        if (!value || typeof value !== "object")
            return;
        if (Array.isArray(value)) {
            for (const item of value)
                visit(item, imageContext, completedContext);
            return;
        }
        const record = value;
        const descriptors = [record.type, record.name, record.kind, record.event].map(normalizedEventKind);
        const isImage = imageContext || descriptors.some((kind) => kind.includes("imagegeneration"));
        const isCompleted = completedContext
            || record.status === "completed"
            || descriptors.includes("itemcompleted");
        if (isImage && isCompleted && typeof record.savedPath === "string")
            paths.add(record.savedPath);
        for (const child of Object.values(record))
            visit(child, isImage, isCompleted);
    };
    visit(event);
    return [...paths];
}
function configuredCodexModel() {
    return process.env.CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL;
}
function configuredCodexReasoningEffort() {
    const configured = process.env.CODEX_REASONING_EFFORT?.trim().toLowerCase();
    if (!configured)
        return DEFAULT_REASONING_EFFORT;
    if (!REASONING_EFFORTS.includes(configured)) {
        throw new Error(`Invalid CODEX_REASONING_EFFORT: ${configured} (expected ${REASONING_EFFORTS.join(", ")})`);
    }
    return configured;
}
function isThreadNotFoundError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /(thread|session).*(not found|missing|unknown)/i.test(message);
}
function isCachedCodexModel(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function codexGeneratedImagesRoot() {
    return path.join(path.resolve(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex")), "generated_images");
}
function generatedImageThreadDirectory(threadId) {
    if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId))
        return undefined;
    return path.join(codexGeneratedImagesRoot(), threadId);
}
function snapshotThreadGeneratedImages(threadId) {
    const directory = generatedImageThreadDirectory(threadId);
    const snapshot = new Map();
    if (!directory)
        return snapshot;
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    }
    catch {
        return snapshot;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !/\.(?:gif|jpe?g|png|webp)$/i.test(entry.name))
            continue;
        try {
            const metadata = fs.lstatSync(path.join(directory, entry.name));
            if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
                continue;
            snapshot.set(entry.name, `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`);
        }
        catch {
            // A concurrently removed file cannot be a completed output for this turn.
        }
    }
    return snapshot;
}
function newThreadGeneratedImages(threadId, before) {
    const directory = generatedImageThreadDirectory(threadId);
    if (!directory)
        return [];
    const after = snapshotThreadGeneratedImages(threadId);
    return [...after]
        .filter(([name, identity]) => before.get(name) !== identity)
        .map(([name]) => path.join(directory, name));
}
async function runCodexCapturingEvents(thread, input, signal, onStarted) {
    const threadIdBeforeRun = thread.id;
    const generatedImagesBeforeRun = snapshotThreadGeneratedImages(threadIdBeforeRun);
    const filesystemGeneratedImages = () => {
        const threadIdAfterRun = thread.id;
        const before = threadIdBeforeRun === threadIdAfterRun ? generatedImagesBeforeRun : new Map();
        return newThreadGeneratedImages(threadIdAfterRun, before);
    };
    if (typeof thread.runStreamed !== "function") {
        const result = await thread.run(input, { signal });
        onStarted();
        return {
            finalResponse: result.finalResponse,
            items: result.items,
            generatedImagePaths: [...new Set([
                    ...codexGeneratedImagePaths(result.items),
                    ...filesystemGeneratedImages(),
                ])],
        };
    }
    const streamed = await thread.runStreamed(input, { signal });
    const items = [];
    const generatedImagePaths = new Set();
    let finalResponse = "";
    for await (const event of streamed.events) {
        signal.throwIfAborted();
        if (thread.id)
            onStarted();
        for (const savedPath of codexGeneratedImagePaths(event))
            generatedImagePaths.add(savedPath);
        const record = event;
        if (record.type === "item.completed" && record.item) {
            items.push(record.item);
            if (record.item.type === "agent_message")
                finalResponse = record.item.text;
        }
        else if (record.type === "turn.failed") {
            throw new Error(record.error?.message || "Codex turn failed.");
        }
    }
    for (const savedPath of filesystemGeneratedImages())
        generatedImagePaths.add(savedPath);
    return { finalResponse, items, generatedImagePaths: [...generatedImagePaths] };
}
/**
 * Session manager backed by the OpenAI Codex SDK. Each Provider method maps to
 * a Codex thread; features the SDK does not expose throw `UnsupportedError`.
 */
export class CodexProvider {
    makeClient;
    store;
    githubTools;
    participationProcesses = new ParticipationProcessRunner();
    artifactTools = new ArtifactToolSessions();
    rulesetTools = new RulesetToolSessions();
    name = "codex";
    displayName = "OpenAI Codex";
    clients = new Map();
    temporaryDirectories = new Map();
    sessions = new Map();
    sessionOperationQueues = new Map();
    messageQueues = new Map();
    sessionContexts = new Map();
    handoffs = new Map();
    webSearchMode;
    constructor(makeClient = options => new Codex(options), store = new SessionStore("codex"), githubTools = new GitHubContributionSessions()) {
        this.makeClient = makeClient;
        this.store = store;
        this.githubTools = githubTools;
        // Resolve once so every normal thread in this provider instance has the
        // same startup-validated policy, even if process.env is later mutated.
        this.webSearchMode = configuredCodexWebSearchMode();
    }
    histories = new Map();
    workingDirOverrides = new Map();
    modelOverrides = new Map();
    reasoningEffortOverrides = new Map();
    mcpToolOverrides = new Map();
    clientFor(key, context, artifacts, rulesets, github) {
        // Connection bindings are private and transient: rebuild the client without rotating history.
        const fingerprint = contextFingerprint({ context: context.fingerprint, artifacts, rulesets, github });
        const existing = this.clients.get(key);
        if (existing?.fingerprint === fingerprint)
            return existing.client;
        let temporaryDirectory = this.temporaryDirectories.get(key);
        if (!temporaryDirectory) {
            temporaryDirectory = createCodexSessionTemporaryDirectory();
            this.temporaryDirectories.set(key, temporaryDirectory);
        }
        const client = this.makeClient(codexClientOptions(temporaryDirectory, artifacts, rulesets, context.systemPrompt, github, context.sitesEnabled, Boolean(context.transportContext)));
        this.clients.set(key, { fingerprint, client });
        this.sessions.delete(key);
        return client;
    }
    threadOptions(key) {
        const workingDirectory = this.workingDirOverrides.get(key) ?? ensureProviderWorkingDirectory();
        prepareCodexWorkingDirectory(workingDirectory);
        const options = {
            model: this.modelOverrides.get(key) ?? configuredCodexModel(),
            modelReasoningEffort: this.reasoningEffortOverrides.get(key) ?? configuredCodexReasoningEffort(),
            workingDirectory,
            skipGitRepoCheck: true,
            approvalPolicy: "never",
            // Codex supports indexed mode; the SDK runtime forwards this value even
            // though version 0.157.1's declaration still lists only three modes.
            webSearchMode: this.webSearchMode,
            ...codexThreadSecurityOptions(),
        };
        return options;
    }
    async getOrCreateSession(key, context, signal, forceNew = false) {
        signal.throwIfAborted();
        const previousClient = this.clients.get(key)?.client;
        const rulesets = context.rulesetsEnabled ? await this.rulesetTools.config(key) : undefined;
        const github = context.githubContributionsEnabled ? await this.githubTools.config(key) : undefined;
        const client = this.clientFor(key, context, await this.artifactTools.config(key, context.transportContext), rulesets, github);
        const existing = this.sessions.get(key);
        if (!forceNew && existing && sameContext(this.sessionContexts.get(key)?.applied, context.applied)
            && previousClient === client)
            return existing;
        let stored = forceNew ? undefined : this.store.getState(key);
        let handoff = forceNew ? this.handoffs.get(key) : stored?.handoff;
        if (stored && !sameContext(stored.context, context.applied)) {
            const summaryClient = this.makeClient(codexHandoffOptions(codexClientOptions(this.temporaryDirectories.get(key), undefined, undefined, context.systemPrompt, undefined, false)));
            const summaryThread = summaryClient.resumeThread(stored.sessionId, {
                ...this.threadOptions(key), sandboxMode: "read-only", networkAccessEnabled: false, webSearchMode: "disabled",
            });
            try {
                handoff = await summarizeHandoff(summaryThread, signal);
            }
            catch (error) {
                signal.throwIfAborted();
                if (!isThreadNotFoundError(error))
                    throw error;
                console.warn(`[CodexProvider] Handoff source for ${key} no longer exists; starting a fresh thread.`);
                stored = undefined;
                // A previously saved handoff is still useful if a replacement thread vanished.
            }
        }
        signal.throwIfAborted();
        const thread = stored && sameContext(stored.context, context.applied)
            ? client.resumeThread(stored.sessionId, this.threadOptions(key))
            : client.startThread(this.threadOptions(key));
        if (handoff)
            this.handoffs.set(key, handoff);
        else
            this.handoffs.delete(key);
        this.sessionContexts.set(key, context);
        this.sessions.set(key, thread);
        return thread;
    }
    evictCachedSession(key, thread) {
        if (this.sessions.get(key) === thread)
            this.sessions.delete(key);
    }
    abandonTimedOutSession(key, retainStored = false) {
        this.sessions.delete(key);
        this.sessionOperationQueues.delete(key);
        if (!retainStored)
            this.store.delete(key);
    }
    enqueueSessionOperation(key, operation) {
        const tail = this.sessionOperationQueues.get(key) ?? Promise.resolve();
        const next = tail.catch(() => { }).then(operation);
        const queueTail = next.catch(() => { });
        this.sessionOperationQueues.set(key, queueTail);
        queueTail.finally(() => {
            if (this.sessionOperationQueues.get(key) === queueTail) {
                this.sessionOperationQueues.delete(key);
            }
        });
        return next;
    }
    async runWithSessionRecovery(key, context, signal, thread, operation) {
        try {
            return await operation(thread);
        }
        catch (err) {
            const handoff = this.handoffs.get(key);
            // Some native runtimes cannot resume an interrupted thread's first turn.
            // A saved handoff lets us recover without reading or rewriting native history.
            const incompleteHistory = handoff && err instanceof Error
                && /list_turns is not supported yet|failed to load a bounded thread history page/i.test(err.message);
            if (!isThreadNotFoundError(err) && !incompleteHistory)
                throw err;
            console.warn(`[CodexProvider] Cached Codex history for ${key} is unavailable; starting a new thread.`);
            this.evictCachedSession(key, thread);
            // Keep the previous mapping and pending summary durable until the new ID
            // is acknowledged. Even failure during replacement startup must be recoverable.
            const fresh = await this.getOrCreateSession(key, context, signal, true);
            return operation(fresh);
        }
    }
    async sendMessage(userId, prompt, imagePaths, options) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(async () => {
            options?.signal?.throwIfAborted();
            const files = imagePaths?.filter((attachment) => attachment.kind === "file" && !attachment.binary) ?? [];
            const fileContext = await Promise.all(files.map(async (attachment) => {
                const text = await readCodexTextAttachment(attachment);
                return `[Discord attachment: ${attachment.displayName ?? "file"}]\n${text}\n[/Discord attachment]`;
            }));
            const resolvedPrompt = fileContext.length ? `${prompt}\n\n${fileContext.join("\n\n")}` : prompt;
            const previousSessionId = this.store.get(userId);
            this.appendHistory(userId, { type: "user.message", data: { content: prompt } });
            const context = resolveSessionContext({ transportContext: options?.transportContext, profile: options?.contextProfile, userInstructionContext: options?.userInstructionContext });
            const workingDirectory = this.workingDirOverrides.get(userId) ?? ensureProviderWorkingDirectory();
            const runWithRulesetTools = (action) => context.rulesetsEnabled
                ? this.rulesetTools.run(userId, options, (rulesetRuntime) => action(rulesetRuntime))
                : action();
            const response = await this.githubTools.run(userId, options, context.githubContributionsEnabled, githubRun => runWithRulesetTools(async (rulesetRuntime) => captureAgentArtifacts(workingDirectory, (artifactRun) => this.artifactTools.run(userId, artifactRun, imagePaths, options, async (runtime, staged) => {
                runtime.providerSourceRoot = () => generatedImageThreadDirectory(this.sessions.get(userId)?.id ?? null);
                const images = staged.filter((attachment) => attachment.kind !== "file");
                const inputFor = (handoff, recovered = false) => {
                    const recoveryPrompt = recovered ? options?.onSessionRecovery?.() : undefined;
                    const turnPrompt = recoveryPrompt === undefined ? resolvedPrompt
                        : fileContext.length ? `${recoveryPrompt}\n\n${fileContext.join("\n\n")}` : recoveryPrompt;
                    const basePrompt = withArtifactOutputPrompt(artifactInputPrompt(withContextTurn(turnPrompt, { userInstructionContext: options?.userInstructionContext }), staged), artifactRun, options?.transportContext);
                    const artifactPrompt = githubContributionPrompt(rulesetRuntime ? rulesetToolPrompt(basePrompt, rulesetRuntime) : basePrompt, githubRun);
                    return images.length > 0
                        ? [
                            { type: "text", text: withHandoff(artifactPrompt, handoff) },
                            ...images.map((a) => ({ type: "local_image", path: a.path })),
                        ]
                        : withHandoff(artifactPrompt, handoff);
                };
                const timeoutMs = providerTimeout("CODEX_TIMEOUT_MS", options);
                const controller = new AbortController();
                let timedOut = false;
                let userTurnStarted = false;
                let startedThreadId = null;
                const stopProgress = startProgressUpdates(options);
                let abortGrace;
                let timeout;
                const cancellationGraceMs = configuredMilliseconds("AI_CANCELLATION_GRACE_MS", 5_000);
                let result;
                let cancelHost = () => { };
                let hostAbortGrace;
                const cancelled = new Promise((_resolve, reject) => {
                    cancelHost = () => {
                        controller.abort(options?.signal?.reason);
                        hostAbortGrace = setTimeout(() => {
                            this.abandonTimedOutSession(userId, !userTurnStarted || this.handoffs.has(userId));
                            reject(options?.signal?.reason ?? new Error('Generation cancelled.'));
                        }, cancellationGraceMs);
                    };
                });
                options?.signal?.addEventListener('abort', cancelHost, { once: true });
                if (options?.signal?.aborted)
                    cancelHost();
                try {
                    const run = this.enqueueSessionOperation(userId, async () => {
                        const thread = await this.getOrCreateSession(userId, context, controller.signal);
                        return this.runWithSessionRecovery(userId, context, controller.signal, thread, current => runCodexCapturingEvents(current, inputFor(this.handoffs.get(userId), current !== thread || Boolean(previousSessionId && current.id !== previousSessionId)), controller.signal, () => {
                            controller.signal.throwIfAborted();
                            if (!current.id || current.id === startedThreadId)
                                return;
                            this.store.set(userId, current.id, context.applied, this.handoffs.get(userId));
                            startedThreadId = current.id;
                            userTurnStarted = true;
                        }));
                    });
                    const deadline = new Promise((_resolve, reject) => {
                        timeout = setTimeout(() => {
                            timedOut = true;
                            controller.abort();
                            abortGrace = setTimeout(() => {
                                this.abandonTimedOutSession(userId, !userTurnStarted || this.handoffs.has(userId));
                                reject(new RunTimeoutError(this.displayName, timeoutMs, false));
                            }, cancellationGraceMs);
                        }, timeoutMs);
                    });
                    result = await Promise.race([run, deadline, cancelled]);
                    options?.signal?.throwIfAborted();
                    if (timedOut) {
                        this.abandonTimedOutSession(userId, !userTurnStarted || this.handoffs.has(userId));
                        throw new RunTimeoutError(this.displayName, timeoutMs, true);
                    }
                }
                catch (error) {
                    if (timedOut && !(error instanceof RunTimeoutError)) {
                        this.abandonTimedOutSession(userId, !userTurnStarted || this.handoffs.has(userId));
                        throw new RunTimeoutError(this.displayName, timeoutMs, true);
                    }
                    throw error;
                }
                finally {
                    options?.signal?.removeEventListener("abort", cancelHost);
                    clearTimeout(hostAbortGrace);
                    clearTimeout(timeout);
                    clearTimeout(abortGrace);
                    stopProgress();
                }
                if (result && this.sessions.get(userId)?.id) {
                    this.store.set(userId, this.sessions.get(userId).id, context.applied);
                    this.handoffs.delete(userId);
                }
                const finalResponse = result.finalResponse || this.extractFinalResponse(result.items) || "(no response)";
                const generatedRoot = codexGeneratedImagesRoot();
                return {
                    content: finalResponse,
                    fallbackArtifacts: result.generatedImagePaths.map((savedPath, index) => ({
                        path: savedPath,
                        trustedRoot: generatedRoot,
                        displayName: `generated-image-${index + 1}${path.extname(savedPath)}`,
                    })),
                };
            }))));
            this.appendHistory(userId, { type: "assistant.message", data: { content: response.content } });
            return response;
        });
        this.messageQueues.set(userId, next.catch(() => { }));
        return next;
    }
    appendHistory(key, event) {
        const history = this.histories.get(key) ?? [];
        history.push(event);
        this.histories.set(key, history.slice(-100));
    }
    extractFinalResponse(items) {
        const agentMessages = items
            .filter((item) => item.type === "agent_message")
            .map((item) => item.text)
            .filter(Boolean);
        return agentMessages.at(-1) ?? null;
    }
    async evaluateParticipation(prompt, options) {
        const directory = createCodexSessionTemporaryDirectory();
        try {
            const stdout = await this.participationProcesses.run(process.env.CODEX_EXECUTABLE_PATH?.trim() || "codex", [
                "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
                "--sandbox", "read-only", "--json", "--model", options.model ?? "gpt-5.6-luna",
                "-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`,
                "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
                "-c", "mcp_servers={}", "-c", "project_doc_max_bytes=0",
                ...["shell_tool", "unified_exec", "apps", "hooks", "plugins", "remote_plugin", "memories", "multi_agent",
                    "computer_use", "browser_use", "browser_use_external", "image_generation", "view_image", "request_permissions_tool", "shell_snapshot",
                    "skill_mcp_dependency_install", "workspace_dependencies", "code_mode", "goals"].flatMap(feature => ["-c", `features.${feature}=false`]),
                "-c", 'developer_instructions="You are a classification function. Use no tools. Return only decision JSON."',
                "-",
            ], { cwd: directory, env: {
                    ...providerChildEnvironment("codex", { ...process.env, AI_ASSISTANT_SECURITY_MODE: "shared" }),
                    ...(process.env.OPENAI_API_KEY ? { CODEX_API_KEY: process.env.OPENAI_API_KEY } : {}),
                }, timeoutMs: options.timeoutMs, stdin: prompt });
            let result = "";
            for (const line of stdout.split("\n")) {
                try {
                    const event = JSON.parse(line);
                    if (event.type === "item.completed" && event.item?.type === "agent_message")
                        result = event.item.text;
                }
                catch { /* Non-JSON diagnostic line. */ }
            }
            return result;
        }
        finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
    async getStatus() {
        let version = "unknown";
        try {
            const pkg = require("@openai/codex/package.json");
            version = pkg.version ? `@openai/codex ${pkg.version}` : version;
        }
        catch (err) {
            console.warn("[CodexProvider] Failed to read Codex package version:", err);
        }
        return {
            status: { version },
            providerSecurity: {
                hostedWebSearch: this.webSearchMode,
                sandboxedCommandNetwork: configuredSecurityMode() === "shared"
                    ? `restricted (${configuredSitesEnabled() ? "package registry and ChatGPT Sites source pushes" : "package registry only"})`
                    : "enabled by unrestricted sandbox mode",
            },
            authStatus: {
                isAuthenticated: Boolean(process.env.OPENAI_API_KEY),
                login: process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : undefined,
                authType: process.env.OPENAI_API_KEY ? "api-key" : "Codex CLI login or OPENAI_API_KEY",
                host: process.env.OPENAI_BASE_URL ?? "api.openai.com",
                statusMessage: process.env.OPENAI_API_KEY
                    ? undefined
                    : "Codex may still use an existing CLI login; no OPENAI_API_KEY is set in this process.",
            },
        };
    }
    async getHistory(userId) {
        return this.histories.get(userId) ?? null;
    }
    async listModels() {
        const modelsById = new Map();
        for (const model of this.readCachedCodexModels()) {
            modelsById.set(model.id, model);
        }
        const configured = [configuredCodexModel(), ...this.modelOverrides.values()].filter((model) => Boolean(model));
        for (const id of configured) {
            if (!modelsById.has(id))
                modelsById.set(id, { id, name: id });
        }
        return Array.from(modelsById.values());
    }
    readCachedCodexModels() {
        const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
        const cachePath = path.join(codexHome, "models_cache.json");
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        }
        catch {
            return [];
        }
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) {
            return [];
        }
        const models = parsed.models
            .filter(isCachedCodexModel)
            .filter((model) => typeof model.slug === "string")
            .filter((model) => model.visibility !== "hide")
            .sort((a, b) => {
            const aPriority = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
            const bPriority = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
            return aPriority - bPriority;
        });
        return models.map((model) => {
            const id = model.slug;
            return {
                id,
                name: typeof model.display_name === "string" ? model.display_name : id,
            };
        });
    }
    async setModel(userId, model) {
        this.modelOverrides.set(userId, model);
        this.sessions.delete(userId);
    }
    async getCurrentModel(key) {
        return this.modelOverrides.get(key) ?? configuredCodexModel();
    }
    async listReasoningEfforts() {
        return [...REASONING_EFFORTS];
    }
    async setReasoningEffort(key, effort) {
        const level = effort;
        if (!REASONING_EFFORTS.includes(level)) {
            throw new Error(`Invalid reasoning effort: ${effort}.`);
        }
        this.reasoningEffortOverrides.set(key, level);
        this.sessions.delete(key);
    }
    async getCurrentReasoningEffort(key) {
        return this.reasoningEffortOverrides.get(key) ?? configuredCodexReasoningEffort();
    }
    async listAgents() {
        throw new UnsupportedError(this.displayName, "custom agent listing");
    }
    async getCurrentAgent() {
        throw new UnsupportedError(this.displayName, "custom agent selection");
    }
    async selectAgent() {
        throw new UnsupportedError(this.displayName, "custom agent selection");
    }
    async deselectAgent() {
        throw new UnsupportedError(this.displayName, "custom agent selection");
    }
    async getMode() {
        throw new UnsupportedError(this.displayName, "session mode switching");
    }
    async setMode() {
        throw new UnsupportedError(this.displayName, "session mode switching");
    }
    async compact() {
        throw new UnsupportedError(this.displayName, "history compaction");
    }
    async startFleet() {
        throw new UnsupportedError(this.displayName, "fleet mode");
    }
    async readPlan() {
        throw new UnsupportedError(this.displayName, "plan management");
    }
    async updatePlan() {
        throw new UnsupportedError(this.displayName, "plan management");
    }
    async deletePlan() {
        throw new UnsupportedError(this.displayName, "plan management");
    }
    async listWorkspaceFiles() {
        throw new UnsupportedError(this.displayName, "workspace file listing");
    }
    async readWorkspaceFile() {
        throw new UnsupportedError(this.displayName, "workspace file reading");
    }
    async createWorkspaceFile() {
        throw new UnsupportedError(this.displayName, "workspace file creation");
    }
    async forgetSession(key) {
        await this.resetSession(key);
        this.workingDirOverrides.delete(key);
        this.modelOverrides.delete(key);
        this.reasoningEffortOverrides.delete(key);
        this.mcpToolOverrides.delete(key);
    }
    async resetSession(key) {
        await this.artifactTools.reset(key);
        await this.rulesetTools.reset(key);
        await this.githubTools.reset(key);
        this.sessions.delete(key);
        this.sessionOperationQueues.delete(key);
        this.messageQueues.delete(key);
        this.histories.delete(key);
        this.store.delete(key);
        this.clients.delete(key);
        this.sessionContexts.delete(key);
        this.handoffs.delete(key);
        const temporaryDirectory = this.temporaryDirectories.get(key);
        this.temporaryDirectories.delete(key);
        if (temporaryDirectory)
            fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    setSessionWorkingDir(key, dir) {
        const canonical = resolveConfiguredWorkspace(dir);
        this.workingDirOverrides.set(key, canonical);
        this.sessions.delete(key);
    }
    getSessionWorkingDir(key) {
        return this.workingDirOverrides.get(key);
    }
    setSessionMcpEnabled(key, serverName, enabled) {
        const overrides = this.mcpToolOverrides.get(key) ?? {};
        overrides[serverName] = enabled ? ["*"] : [];
        this.mcpToolOverrides.set(key, overrides);
    }
    getMcpStatus(key) {
        const workingDir = this.workingDirOverrides.get(key);
        const overrides = this.mcpToolOverrides.get(key) ?? {};
        const statusList = McpConfigLoader.status(workingDir);
        return statusList.map((s) => {
            const skipped = !s.enabled;
            if (skipped)
                return { ...s, enabled: false, skipped: true };
            if (s.name in overrides)
                return { ...s, enabled: overrides[s.name].length > 0, skipped: false };
            return { ...s, skipped: false };
        });
    }
    async shutdown() {
        await this.participationProcesses.shutdown();
        await this.artifactTools.shutdown();
        await this.rulesetTools.shutdown();
        await this.githubTools.shutdown();
        this.sessions.clear();
        this.clients.clear();
        this.sessionContexts.clear();
        this.handoffs.clear();
        for (const directory of this.temporaryDirectories.values())
            fs.rmSync(directory, { recursive: true, force: true });
        this.temporaryDirectories.clear();
        this.sessionOperationQueues.clear();
        this.messageQueues.clear();
    }
}
