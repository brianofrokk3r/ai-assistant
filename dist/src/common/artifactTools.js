import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { artifactOutputLimits, artifactValidationBudget, normalizePreviewableImage, validateArtifactFile } from "./agentResponse.js";
import { pathIsWithin, workspacePathIsAllowed } from "./providerSecurity.js";
import { artifactFilename, fetchPublicArtifact, inputByteLimit } from "../utils/fetchArtifact.js";
import { discordMessageLocation } from "../utils/artifactMessage.js";
import { transcodeVideo } from "./mediaTranscode.js";
import { fetchWebpage, lookupUrl } from "../utils/fetchWebpage.js";
import { ARTIFACT_TOOLS } from "./artifactToolDefinitions.js";
export { ARTIFACT_TOOLS } from "./artifactToolDefinitions.js";
export class ArtifactTools {
    run;
    options;
    download;
    readWebpage;
    id;
    controller = new AbortController();
    queue = Promise.resolve();
    calls = 0;
    historyCalls = 0;
    downloadedBytes = 0;
    candidates = new Map();
    downloads = new Map();
    registered = new Map();
    validationBudget = artifactValidationBudget();
    filenames = new Map();
    normalizedExtensions = new Map();
    transientFiles = new Set();
    retained = 0;
    webpages = new Map();
    webpageReads = new Map();
    providerSourceRoot;
    constructor(run, options, download = fetchPublicArtifact, readWebpage = fetchWebpage) {
        this.run = run;
        this.options = options;
        this.download = download;
        this.readWebpage = readWebpage;
        this.id = path.basename(run.directory);
        run.cleanup = () => this.close();
    }
    async cancel() { this.controller.abort(); await this.queue.catch(() => { }); }
    async close() {
        await this.cancel();
        for (const file of this.transientFiles) {
            // Never recursively delete an agent-writable directory. Check the complete
            // path and unlink only files created by this run's staging operations.
            if (!workspacePathIsAllowed(this.run.workingDirectory, file))
                continue;
            await fs.unlink(file).catch((error) => {
                if (error.code !== "ENOENT")
                    console.warn("[artifacts] Could not remove a transient input:", error);
            });
        }
        this.transientFiles.clear();
    }
    call(name, args) {
        const operation = this.queue.catch(() => { }).then(async () => {
            this.controller.signal.throwIfAborted();
            if (this.options?.transportContext && !(name === 'fetch_webpage' || (name === 'fetch_channel_history' && this.options.transportContext.history) || (name === 'attach_file' && this.options.transportContext.attachments)))
                throw new Error('Tool unavailable for this transport.');
            if (args.run_id !== this.id)
                throw new Error("This artifact run has expired or belongs to another response.");
            if (++this.calls > 80)
                throw new Error("Artifact tool call limit reached for this response.");
            const schema = ARTIFACT_TOOLS.find((tool) => tool.name === name)?.inputSchema;
            if (!schema || Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)))
                throw new Error("Invalid artifact tool arguments.");
            for (const key of schema.required)
                if (typeof args[key] !== "string" || !args[key].trim())
                    throw new Error(`Missing ${key}.`);
            for (const value of Object.values(args))
                if (typeof value !== "string" || value.length > 8192)
                    throw new Error("Tool arguments must be short strings.");
            if (name === "fetch_channel_history") {
                if (!this.options?.resolveChannelHistory || this.options.contextProfile === "scheduled" || this.options.contextProfile === "ephemeral")
                    throw new Error("Channel history is unavailable for this run.");
                if (++this.historyCalls > 3)
                    throw new Error("Channel history call limit reached for this response.");
                return abortable(this.options.resolveChannelHistory(args, this.controller.signal), this.controller.signal);
            }
            if (name === "fetch_webpage")
                return this.webpage(args);
            if (name === "report_lookup")
                return this.reportLookup(args);
            if (name === "fetch_artifact")
                return this.fetch(args);
            if (name === "attach_file")
                return this.attach(String(args.path), args.filename);
            if ((process.env.DISCORD_ATTACHMENT_MODE ?? "native").trim().toLowerCase() !== "native")
                throw new Error("Video processing requires DISCORD_ATTACHMENT_MODE=native.");
            if (!["av1", "h264", "hevc"].includes(String(args.codec)))
                throw new Error("Unsupported target codec.");
            const data = await this.readInput(String(args.path));
            const output = await transcodeVideo(data, args.codec, this.controller.signal);
            return this.save(output, `converted-${args.codec}.mp4`, "video/mp4");
        });
        this.queue = operation;
        return operation;
    }
    async webpage(args) {
        const url = lookupUrl(String(args.url));
        const mode = args.mode ?? "auto";
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        if (mode !== "auto" && mode !== "browser")
            throw new Error("Use auto or browser mode.");
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 192_000)
            throw new Error("Text offset must be between 0 and 191999.");
        const key = JSON.stringify([url, mode]);
        const cached = this.webpageReads.get(key);
        const chunk = (result) => {
            if (result.status !== "available")
                return result;
            const nextOffset = offset + 24_000 < result.text.length ? String(offset + 24_000) : undefined;
            return { ...result, text: result.text.slice(offset, offset + 24_000), nextOffset, truncated: result.truncated || nextOffset !== undefined };
        };
        if (cached)
            return chunk(cached);
        if (this.webpageReads.size >= 24)
            throw new Error("The 24-page read budget is exhausted. Use hosted article reading or the evidence already collected.");
        // Keep one bounded document snapshot: continuation reads neither refetch changing
        // news nor spend another browser launch or source slot.
        const result = await this.readWebpage(url, this.controller.signal, undefined, { mode, textLimit: 192_000 });
        this.controller.signal.throwIfAborted();
        this.webpageReads.set(key, result);
        this.webpages.set(url, result);
        this.options?.onLookup?.({ url, checkedAt: result.fetchedAt,
            status: result.status === "available" ? "fetched" : "unavailable",
            ...(result.status === "unavailable" ? { errorCode: result.errorCode, summary: result.message } : {}) });
        return chunk(result);
    }
    reportLookup(args) {
        if (!this.options?.onLookup)
            throw new Error("Lookup reporting is only available for scheduled runs.");
        if (!["verified", "unavailable"].includes(String(args.status)))
            throw new Error("Use verified or unavailable.");
        const url = lookupUrl(String(args.url));
        const page = this.webpages.get(url);
        if (!page)
            throw new Error("Call fetch_webpage for this URL before reporting its result.");
        if (args.status === "verified" && page.status !== "available")
            throw new Error("An unavailable page cannot verify a lookup.");
        const summary = String(args.summary).trim();
        if (summary.length > 2000)
            throw new Error("Keep lookup summaries within 2000 characters.");
        this.options.onLookup({ url, checkedAt: page.fetchedAt, status: args.status, summary: page.status === "unavailable" ? page.message : summary,
            ...(args.status === "unavailable" ? { errorCode: page.status === "unavailable" ? page.errorCode : "missing_data" } : {}) });
        return { status: "recorded" };
    }
    /** Give every provider an accessible workspace copy, including binary inputs. */
    async stageInputs(files) {
        const staged = [];
        for (const file of files) {
            this.controller.signal.throwIfAborted();
            const data = await readRegularFile(file.path, inputByteLimit());
            const saved = await this.save(data, file.displayName ?? path.basename(file.path), "application/octet-stream");
            staged.push({ ...file, path: saved.path });
        }
        return staged;
    }
    async save(data, name, contentType) {
        this.controller.signal.throwIfAborted();
        if (++this.retained > 20 || this.downloadedBytes + data.length > inputByteLimit() * 2)
            throw new Error("This response's input storage budget is exhausted.");
        if (!workspacePathIsAllowed(this.run.workingDirectory, this.run.directory))
            throw new Error("Artifact directory is no longer valid.");
        const normalized = normalizePreviewableImage(data, artifactFilename(name));
        const filePath = path.join(this.run.directory, `${randomUUID()}-${normalized.displayName}`);
        await fs.writeFile(filePath, normalized.data, { flag: "wx", mode: 0o600 });
        this.transientFiles.add(filePath);
        this.filenames.set(filePath, normalized.displayName);
        if (path.extname(normalized.displayName).toLowerCase() !== path.extname(name).toLowerCase()) {
            this.normalizedExtensions.set(filePath, path.extname(normalized.displayName));
        }
        this.downloadedBytes += normalized.data.length;
        return { artifact_id: path.basename(filePath), path: filePath, filename: normalized.displayName, bytes: normalized.data.length, content_type: contentType };
    }
    sourceRoot(file) {
        const resolved = path.resolve(this.run.workingDirectory, file);
        if (workspacePathIsAllowed(this.run.workingDirectory, resolved)) {
            const relative = path.relative(this.run.workingDirectory, resolved);
            if (relative.split(path.sep).some((part) => part.startsWith(".") && part !== ".env.example"))
                throw new Error("Hidden workspace files cannot be exported.");
            const artifactRoot = path.join(this.run.workingDirectory, "ai-assistant-artifacts");
            if (pathIsWithin(artifactRoot, resolved) && !pathIsWithin(this.run.directory, resolved))
                throw new Error("Files from another artifact run are unavailable.");
            return { root: this.run.workingDirectory, file: resolved };
        }
        const providerRoot = this.providerSourceRoot?.();
        if (providerRoot && workspacePathIsAllowed(providerRoot, resolved))
            return { root: providerRoot, file: resolved };
        throw new Error("File must be in this workspace or the current provider thread's generated output directory.");
    }
    async readInput(file) {
        const source = this.sourceRoot(file);
        return readRegularFile(source.file, inputByteLimit());
    }
    async attach(file, filename) {
        // Even a failed explicit selection suppresses heuristic delivery of an unrelated file.
        this.run.registeredAttachments ??= [];
        const source = this.sourceRoot(file);
        const attachment = await validateArtifactFile(source.root, source.file, this.validationBudget);
        const identity = createHash("sha256").update(attachment.data).digest("hex");
        if (this.registered.has(identity))
            return this.registered.get(identity);
        const limits = artifactOutputLimits();
        if (this.run.registeredAttachments.length >= limits.count)
            throw new Error(`Only ${limits.count} attachments fit in a response.`);
        if (this.run.registeredAttachments.reduce((total, item) => total + item.data.length, 0) + attachment.data.length > limits.bytes)
            throw new Error(`Response attachments exceed ${limits.bytes} bytes.`);
        const safeName = artifactFilename(filename ?? this.filenames.get(source.file) ?? attachment.displayName);
        // Preserve an extension changed by normalization (e.g. SVG → PNG), but let
        // callers name extensionless/generic downloads for their intended delivery.
        const extension = path.extname(attachment.displayName);
        const normalizedExtension = this.normalizedExtensions.get(source.file)
            ?? (path.extname(source.file).toLowerCase() !== extension.toLowerCase() ? extension : undefined);
        attachment.displayName = normalizedExtension ? `${path.parse(safeName).name}${normalizedExtension}` : safeName;
        const saved = await this.save(attachment.data, attachment.displayName, "application/octet-stream");
        this.controller.signal.throwIfAborted();
        this.run.registeredAttachments.push(attachment);
        this.transientFiles.delete(saved.path);
        const result = { artifact_id: saved.artifact_id, filename: attachment.displayName, bytes: attachment.data.length, status: "ready" };
        this.registered.set(identity, result);
        return result;
    }
    async fetch(args) {
        let candidate;
        if (args.candidate_id) {
            if (args.url)
                throw new Error("Provide url or candidate_id, not both.");
            const selected = this.candidates.get(String(args.candidate_id));
            if (!selected)
                throw new Error("Unknown candidate_id for this response.");
            candidate = selected;
        }
        else {
            if (typeof args.url !== "string")
                throw new Error("Provide a URL or a candidate_id.");
            candidate = { url: args.url };
        }
        if (discordMessageLocation(candidate.url)) {
            if (!this.options?.resolveArtifactMessage)
                throw new Error("Discord message retrieval is unavailable for this run.");
            const seen = new Set();
            const queue = [{ url: candidate.url, depth: 0 }];
            const files = new Map();
            const warnings = [];
            while (queue.length && seen.size < 10) {
                this.controller.signal.throwIfAborted();
                const next = queue.shift();
                const location = discordMessageLocation(next.url);
                const identity = `${location.guild}/${location.channel}/${location.message}`;
                if (seen.has(identity))
                    continue;
                seen.add(identity);
                try {
                    const message = await abortable(this.options.resolveArtifactMessage(next.url), this.controller.signal);
                    for (const file of message.candidates.slice(0, 20)) {
                        if (discordMessageLocation(file.url)) {
                            if (next.depth < 3)
                                queue.push({ url: file.url, depth: next.depth + 1 });
                            else
                                warnings.push("Discord message link depth limit reached.");
                        }
                        else if (files.size < 20)
                            files.set(file.url, file);
                    }
                }
                catch (error) {
                    warnings.push(error instanceof Error ? error.message : "Message lookup failed.");
                }
            }
            if (queue.length)
                warnings.push("Discord message lookup limit reached.");
            const candidates = [...files.values()];
            if (!candidates.length)
                throw new Error(warnings.join(" ") || "No files or media links found in this Discord message.");
            if (candidates.length > 1) {
                return { candidates: candidates.map((file) => {
                        const id = randomUUID();
                        this.candidates.set(id, file);
                        return { candidate_id: id, ...file };
                    }), warnings };
            }
            candidate = candidates[0];
        }
        if (this.downloads.has(candidate.url))
            return this.downloads.get(candidate.url);
        if (candidate.size && candidate.size > inputByteLimit())
            throw new Error(`Input exceeds the ${inputByteLimit()}-byte limit.`);
        const fetched = await this.download(candidate.url, this.controller.signal);
        if ((process.env.DISCORD_ATTACHMENT_MODE ?? "native").trim().toLowerCase() !== "native") {
            const head = fetched.data.subarray(0, 12);
            if (!head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
                && !(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
                && !/^GIF8[79]a/.test(head.toString("ascii"))
                && !(head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP")) {
                throw new Error("Text mode permits downloads of raster images only.");
            }
        }
        const result = await this.save(fetched.data, candidate.name ?? fetched.filename, fetched.contentType);
        const sourced = { ...result, source_url: candidate.url, source_message: candidate.sourceMessage };
        this.downloads.set(candidate.url, sourced);
        return sourced;
    }
}
function abortable(operation, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error("Artifact operation cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted)
            abort();
    });
}
async function readRegularFile(file, limit) {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
        throw new Error(`Input must be a regular file no larger than ${limit} bytes.`);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink !== 1)
            throw new Error("Input changed while opening.");
        const data = Buffer.alloc(opened.size + 1);
        let offset = 0;
        while (offset < data.length) {
            const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
            if (!bytesRead)
                break;
            offset += bytesRead;
        }
        if (offset !== opened.size)
            throw new Error("Input changed while reading.");
        return data.subarray(0, offset);
    }
    finally {
        await handle.close();
    }
}
