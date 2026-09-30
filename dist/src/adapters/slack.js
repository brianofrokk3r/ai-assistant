import { fetchSlackFile, prepareSlackFiles } from './slackAttachments.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { ConversationService, FileTurnJournal, historyBlock, historyRange, retrieveHistory } from '../application/conversationService.js';
import { TEXT_CAPABILITIES, sessionKey } from '../core/conversation.js';
import { createTextEngine } from '../composition/textEngine.js';
import { configuredSecurityMode } from '../common/providerSecurity.js';
/** Credentials remain in this host client, never in provider context or persisted turns. */
export class SlackWebApi {
    token;
    constructor(token) {
        this.token = token;
    }
    downloadFile(url, signal) { return fetchSlackFile(this.token, url, signal); }
    uploadFile(url, data, signal) {
        const bytes = new Uint8Array(data);
        return fetch(slackUploadUrl(url), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes.buffer,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    }
    async call(method, args = {}, signal) {
        const response = await fetch('https://slack.com/api/' + method, {
            method: 'POST', headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(args), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        });
        if (response.status === 429)
            throw new Error('Slack rate limited; retry after ' + (response.headers.get('retry-after') ?? 'unknown') + ' seconds.');
        if (!response.ok)
            throw new Error('Slack request failed.');
        const data = await response.json();
        if (!data.ok)
            throw new Error('Slack API rejected request: ' + (data.error ?? 'unknown'));
        return data;
    }
}
export function slackPosition(value) {
    if (typeof value !== 'string' || !/^\d{10,}\.[0-9]{6}$/.test(value))
        throw new Error('Invalid Slack message timestamp.');
    return value;
}
/** Slack upload tickets must be first-party HTTPS URLs; tokens never accompany this request. */
export function slackUploadUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password || !url.pathname.startsWith('/upload/v1/')) {
        throw new Error('Invalid Slack upload URL.');
    }
    return url;
}
export function slackOutputName(value) {
    if (typeof value !== 'string')
        throw new Error('Invalid attachment name.');
    // Match the provider artifact sanitizer: retain valid Unicode and punctuation,
    // while removing transport-breaking controls at this independently trusted boundary.
    const name = value.replace(/[\r\n\0]/g, '_').trim();
    if (name.includes('/') || name.includes('\\'))
        throw new Error('Invalid attachment name.');
    if (!name || name === '.' || name === '..')
        throw new Error('Invalid attachment name.');
    return name;
}
export function comparePosition(a, b) {
    const left = BigInt(slackPosition(a).replace('.', '')), right = BigInt(slackPosition(b).replace('.', ''));
    return left < right ? -1 : left > right ? 1 : 0;
}
export class SlackHistory {
    api;
    origin;
    authorize;
    excluded;
    constructor(api, origin, authorize, excluded = new Set()) {
        this.api = api;
        this.origin = origin;
        this.authorize = authorize;
        this.excluded = excluded;
    }
    hasMore(result) { return Boolean(result.has_more || result.response_metadata?.next_cursor); }
    includeAuthor(id) { return !this.excluded.has(id); }
    resolveMessageReference(url, resource) {
        try {
            const parsed = new URL(url);
            const m = parsed.pathname.match(/^\/archives\/([^/]+)\/p(\d{10,})(\d{6})$/);
            if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.slack\.com$/.test(parsed.hostname) || !m || m[1] !== resource.channelId)
                return;
            return m[2] + '.' + m[3];
        }
        catch {
            return;
        }
    }
    async page(resource, before, cursor, signal, range) {
        if (resource.platform !== 'slack' || resource.tenantId !== this.origin.tenantId || resource.installationId !== this.origin.installationId
            || resource.channelId !== this.origin.channelId || (resource.threadId && resource.threadId !== this.origin.threadId)
            || !await this.authorize(signal))
            throw new Error('History access denied.');
        const args = { channel: resource.channelId, latest: before, inclusive: 'false', limit: '100', ...(cursor ? { cursor } : {}) };
        if (resource.threadId)
            args.ts = resource.threadId;
        let result = await this.api.call(resource.threadId ? 'conversations.replies' : 'conversations.history', args, signal);
        if (resource.threadId && !cursor && range?.kind === 'recent' && this.hasMore(result)) {
            // Replies are oldest-first. Search newest time intervals first; never present
            // a truncated oldest page as the recent end. Keep the root separately.
            const records = (Array.isArray(result.messages) ? result.messages : []);
            const collected = records.filter(m => m.ts === resource.threadId);
            const micros = (ts) => BigInt(slackPosition(ts).replace('.', ''));
            const stamp = (n) => (n / 1000000n).toString() + '.' + (n % 1000000n).toString().padStart(6, '0');
            const windows = [[micros(resource.threadId), micros(before)]];
            let calls = 1;
            while (windows.length && calls < 10 && collected.filter(m => m.ts !== resource.threadId).length < range.count) {
                signal.throwIfAborted();
                if (!await this.authorize(signal))
                    throw new Error('History access denied.');
                const [low, high] = windows.pop();
                const page = await this.api.call('conversations.replies', { ...args, oldest: stamp(low), latest: stamp(high) }, signal);
                calls++;
                if (this.hasMore(page)) {
                    if (high - low <= 1n) {
                        windows.push([low, high]);
                        break;
                    }
                    const mid = (low + high) / 2n;
                    // The shared boundary is included by the older half (exclusive API bounds).
                    windows.push([low, mid + 1n], [mid, high]);
                }
                else {
                    const batch = (Array.isArray(page.messages) ? page.messages : []);
                    collected.push(...batch.filter(m => typeof m.ts === 'string' && micros(m.ts) > low && micros(m.ts) < high));
                }
            }
            result = { ok: true, messages: collected, has_more: windows.length > 0 };
        }
        const messages = (Array.isArray(result.messages) ? result.messages : []).flatMap((raw) => {
            if (typeof raw.ts !== 'string' || typeof raw.text !== 'string' || typeof raw.user !== 'string' || comparePosition(raw.ts, before) >= 0)
                return [];
            if (raw.subtype && !['thread_broadcast', 'bot_message'].includes(String(raw.subtype)))
                return [];
            if (!resource.threadId && raw.thread_ts && raw.thread_ts !== raw.ts)
                return [];
            if (resource.threadId && raw.ts !== resource.threadId && raw.thread_ts !== resource.threadId)
                return [];
            return [{ id: JSON.stringify(['slack', resource.tenantId, resource.channelId, raw.ts]), position: raw.ts,
                    authorId: raw.user, text: raw.text, timestamp: Number(raw.ts) * 1000,
                    threadId: typeof raw.thread_ts === 'string' ? raw.thread_ts : undefined,
                    revision: JSON.stringify(raw.edited ?? null),
                    url: 'https://app.slack.com/archives/' + resource.channelId + '/p' + raw.ts.replace('.', ''),
                }];
        });
        const next = result.response_metadata?.next_cursor || undefined;
        return { messages, cursor: next, truncated: Boolean(result.has_more && !next) };
    }
}
function contextOverBudget(state) {
    return state.represented.length + Object.keys(state.seen).length + Object.keys(state.positions).length + Object.keys(state.scopes ?? {}).length > 4000;
}
function fingerprint(message) {
    return createHash('sha256').update(JSON.stringify([message.authorId, message.text, message.revision ?? 'null'])).digest('hex');
}
function historyScope(resource) { return JSON.stringify([resource.channelId, resource.threadId ?? null]); }
/** Transport-independent Slack event normalization; Socket Mode is only an ingress. */
export class SlackAdapter {
    config;
    api;
    historyApi;
    engine;
    service;
    maxSessions;
    fallbackContextIdentity = randomUUID();
    sessions = new Set();
    constructor(config, api, historyApi, engine, service, maxSessions = 1000) {
        this.config = config;
        this.api = api;
        this.historyApi = historyApi;
        this.engine = engine;
        this.service = service;
        this.maxSessions = maxSessions;
        mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
        for (const file of readdirSync(config.stateDirectory))
            if (/^[a-f0-9]{64}\.json$/.test(file))
                this.sessions.add(join(config.stateDirectory, file));
    }
    normalize(payload) {
        if (payload.team_id !== this.config.teamId || typeof payload.event_id !== 'string')
            return;
        const e = payload.event;
        if (!e || e.type !== 'app_mention' || e.bot_id || (e.subtype && e.subtype !== 'file_share') || e.user === this.config.botUserId
            || typeof e.user !== 'string' || typeof e.channel !== 'string' || !this.config.channels.has(e.channel)
            || !this.config.users.has(e.user) || typeof e.text !== 'string' || !e.text.includes('<@' + this.config.botUserId + '>'))
            return;
        const ts = slackPosition(e.ts), thread = e.thread_ts ? slackPosition(e.thread_ts) : undefined;
        return { eventId: payload.event_id, sourceMessageId: ts, text: e.text.split('<@' + this.config.botUserId + '>').join('').trim(),
            receivedAt: new Date(Number(ts) * 1000).toISOString(), actor: { platform: 'slack', tenantId: this.config.teamId, userId: e.user },
            conversation: { platform: 'slack', tenantId: this.config.teamId, installationId: this.config.installationId, channelId: e.channel, ...(thread ? { threadId: thread, kind: 'thread' } : { kind: 'channel' }) } };
    }
    async audience(input, signal) {
        signal?.throwIfAborted();
        const info = await this.api.call('conversations.info', { channel: input.conversation.channelId }, signal);
        const channel = info.channel;
        // Shared/external channels and DMs require a separate visibility policy.
        if (!channel || channel.is_im || channel.is_mpim || channel.is_ext_shared || channel.is_org_shared || !channel.is_member)
            return;
        const members = new Set();
        let cursor;
        for (let page = 0; page < 20; page++) {
            signal?.throwIfAborted();
            const result = await this.api.call('conversations.members', { channel: input.conversation.channelId, limit: '200', ...(cursor ? { cursor } : {}) }, signal);
            for (const id of result.members ?? [])
                members.add(id);
            cursor = result.response_metadata?.next_cursor || undefined;
            if (!cursor)
                break;
        }
        if (cursor)
            throw new Error('Cannot establish the complete channel audience.');
        if (!members.has(input.actor.userId) || !members.has(this.config.botUserId))
            return;
        return createHash('sha256').update(JSON.stringify([...members].sort())).digest('hex');
    }
    stateFile(key) { return join(this.config.stateDirectory, createHash('sha256').update(key).digest('hex') + '.json'); }
    load(key) {
        try {
            return JSON.parse(readFileSync(this.stateFile(key), 'utf8'));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
            return { represented: [], seen: {}, positions: {} };
        }
    }
    save(key, state) {
        // Compact metadata now; discard the matching provider history before the next turn.
        if (contextOverBudget(state))
            state = { resetRequired: true, represented: [], seen: {}, positions: {}, scopes: {} };
        const p = this.stateFile(key);
        if (!this.sessions.has(p) && this.sessions.size >= this.maxSessions)
            throw new Error('Slack session capacity reached; reconcile inactive context and provider mappings with the adapter stopped.');
        writeFileSync(p + '.tmp', JSON.stringify(state), { mode: 0o600 });
        renameSync(p + '.tmp', p);
        this.sessions.add(p);
    }
    async receive(payload) {
        const input = this.normalize(payload);
        if (!input)
            return;
        const source = payload.event;
        return this.submit(input, fingerprint({ authorId: input.actor.userId, text: String(source.text), revision: JSON.stringify(source.edited ?? null) }), source.files ?? (source.subtype === 'file_share' ? null : undefined));
    }
    /** Replay only generated output: acknowledged Socket Mode events need not return. */
    async recover(signal) {
        for (const input of this.service.pendingDeliveries()) {
            signal?.throwIfAborted();
            const conversation = input.conversation;
            if (conversation.platform !== 'slack' || conversation.tenantId !== this.config.teamId
                || conversation.installationId !== this.config.installationId || conversation.kind !== 'thread'
                || !this.config.channels.has(conversation.channelId) || !this.config.users.has(input.actor.userId))
                continue;
            const handle = await this.submit(input);
            const result = await handle.completion;
            if (result.state !== 'delivered')
                console.error('[slack] Recovered delivery ' + result.state + ': ' + result.error);
        }
    }
    submit(input, sourceFingerprint, files) {
        const key = sessionKey(input, 'shared');
        let audience;
        const authorized = async (signal) => {
            const current = await this.audience(input, signal);
            return current !== undefined && (audience === undefined || current === audience);
        };
        const port = new SlackHistory(this.historyApi, input.conversation, authorized, this.config.excludedAuthors);
        return this.service.submit(input, {
            platform: 'slack', tenantId: this.config.teamId, installationId: this.config.installationId,
            audience: 'shared', capabilities: { ...TEXT_CAPABILITIES, history: true, attachments: true, progress: false },
            retryGeneratedDelivery: true,
            authorize: async (_i, stage, output, signal) => {
                if (stage === 'ingress')
                    return true;
                if (output) {
                    const current = await this.audience(input, signal);
                    return Boolean(output.audienceTag && current === output.audienceTag);
                }
                return authorized(signal);
            },
            prepare: async (_i, session, signal) => {
                audience = await this.audience(input, signal);
                if (!audience)
                    throw new Error('Conversation access denied.');
                const state = this.load(session);
                state.represented ??= [];
                state.scopes ??= {};
                // Reserve a bounded persistent slot before any provider mapping can be created.
                if (!this.sessions.has(this.stateFile(session)))
                    this.save(session, state);
                const resource = input.conversation.threadId === input.sourceMessageId
                    ? { ...input.conversation, kind: 'channel', threadId: undefined } : input.conversation;
                const result = await retrieveHistory(port, input, resource, { kind: 'recent', count: 50 }, AbortSignal.any([signal, AbortSignal.timeout(15_000)]), { messages: 50, characters: 8_000, pages: 10, scanned: 1000 }, Boolean(resource.threadId));
                signal.throwIfAborted();
                const fingerprints = Object.fromEntries(result.messages.map(m => [m.id, fingerprint(m)]));
                const observed = result.observed;
                const observedIds = new Set(observed?.messages.map(m => m.id));
                const changed = observed?.messages.some(m => (state.seen[m.id] && state.seen[m.id] !== fingerprint(m)) || (state.represented.includes(m.position) && !state.seen[m.id]));
                const removed = observed?.complete && Object.entries(state.positions).some(([id, pos]) => state.scopes[id] === historyScope(resource) && comparePosition(pos, input.sourceMessageId) < 0 && !observedIds.has(id));
                const exclusionPolicy = JSON.stringify([...this.config.excludedAuthors].sort());
                const contextIdentity = this.engine.contextIdentity?.(session) ?? this.fallbackContextIdentity;
                if (state.resetRequired || contextOverBudget(state) || result.coverage.status === 'unavailable' || state.exclusionPolicy !== exclusionPolicy || state.contextIdentity !== contextIdentity || state.audience !== audience || changed || removed) {
                    await this.engine.resetSession(session);
                    state.seen = {};
                    state.positions = {};
                    state.represented = [];
                    state.scopes = {};
                }
                const fresh = result.messages.filter(m => !state.seen[m.id] && !state.represented.includes(m.position));
                // Commit inclusion only after provider success. Failed turns may require explicit reset.
                const next = { exclusionPolicy, represented: [...state.represented, input.sourceMessageId], audience, seen: { ...state.seen, ...fingerprints }, positions: { ...state.positions, ...Object.fromEntries(result.messages.map(m => [m.id, m.position])) }, scopes: { ...state.scopes, ...Object.fromEntries(result.messages.map(m => [m.id, historyScope(resource)])) } };
                const prompt = historyBlock({ ...result, messages: fresh, coverage: { ...result.coverage, included: fresh.length, reasons: [...result.coverage.reasons, ...(fresh.length !== result.messages.length ? ['Previously supplied records retained in this provider session.'] : [])] } }) + '\n\nCurrent speaker (host-verified): ' + JSON.stringify(input.actor) + '\nCurrent request:\n' + input.text;
                const uploads = await prepareSlackFiles(files, this.api, signal);
                const attachmentWarning = uploads.warnings.length ? '\n\n[Slack attachment warnings: ' + uploads.warnings.join('; ') + ']' : '';
                return { prompt: prompt + attachmentWarning, next, coverage: result.coverage, history: result, scope: historyScope(resource), uploads, attachmentWarning, cleanup: uploads.cleanup };
            },
            generate: async (prepared, session, signal, onProgress) => {
                if (!sourceFingerprint)
                    throw new Error('Recovered turns may only deliver persisted output.');
                if (prepared.uploads.fileAttachments.length && !await authorized(signal))
                    throw new Error('Conversation access denied.');
                const response = await this.engine.sendMessage(session, prepared.prompt, prepared.uploads.fileAttachments.length ? prepared.uploads.fileAttachments : undefined, {
                    transportContext: { platform: 'slack', history: true, attachments: true }, signal, onProgress,
                    onSessionRecovery: () => {
                        signal.throwIfAborted();
                        prepared.next.represented = [input.sourceMessageId];
                        prepared.next.seen = Object.fromEntries(prepared.history.messages.map(m => [m.id, fingerprint(m)]));
                        prepared.next.positions = Object.fromEntries(prepared.history.messages.map(m => [m.id, m.position]));
                        prepared.next.scopes = Object.fromEntries(prepared.history.messages.map(m => [m.id, prepared.scope]));
                        return historyBlock(prepared.history) + '\n\nCurrent speaker (host-verified): ' + JSON.stringify(input.actor) + '\nCurrent request:\n' + input.text + prepared.attachmentWarning;
                    },
                    resolveChannelHistory: async (args, signal) => {
                        if (args.scope && !['channel', 'thread'].includes(String(args.scope)))
                            throw new Error('Unsupported history scope.');
                        const resource = args.scope === 'channel' ? { ...input.conversation, kind: 'channel', threadId: undefined } : input.conversation;
                        const range = historyRange(args, input, port, resource);
                        const result = await retrieveHistory(port, input, resource, range, signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000));
                        for (const message of result.messages) {
                            prepared.next.seen[message.id] = fingerprint(message);
                            prepared.next.positions[message.id] = message.position;
                            prepared.next.scopes[message.id] = historyScope(resource);
                        }
                        return historyBlock(result);
                    },
                });
                // Do not suppress the current turn until it has actually been accepted by the provider.
                const id = JSON.stringify(['slack', input.conversation.tenantId, input.conversation.channelId, input.sourceMessageId]);
                prepared.next.positions[id] = input.sourceMessageId;
                prepared.next.seen[id] = sourceFingerprint;
                prepared.next.scopes[id] = historyScope(input.conversation);
                prepared.next.contextIdentity = this.engine.contextIdentity?.(session) ?? this.fallbackContextIdentity;
                this.save(session, prepared.next);
                response.audienceTag = audience;
                response.content += prepared.attachmentWarning;
                if (prepared.coverage.status === 'partial' || prepared.coverage.status === 'unavailable')
                    response.content += '\n\n[Surrounding discussion context is ' + prepared.coverage.status + ': ' + prepared.coverage.reasons.join('; ') + ']';
                return response;
            },
            deliver: async (output, deliveryKey, _session, signal) => {
                const text = output.content;
                const chars = Array.from(text || (output.attachments.length ? '' : '(No text response)'));
                const ids = [];
                const sent = [];
                for (let offset = 0; offset < chars.length; offset += 3000) {
                    signal.throwIfAborted();
                    const result = await this.api.call('chat.postMessage', { channel: input.conversation.channelId, ...(input.conversation.threadId ? { thread_ts: input.conversation.threadId } : {}),
                        text: chars.slice(offset, offset + 3000).join(''), parse: 'none', unfurl_links: 'false', unfurl_media: 'false',
                        client_msg_id: createHash('sha256').update(deliveryKey + ':' + offset).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5') });
                    if (typeof result.ts === 'string') {
                        ids.push(result.ts);
                        sent.push({ position: result.ts, text: chars.slice(offset, offset + 3000).join('') });
                    }
                }
                if (output.attachments.length) {
                    if (!this.api.uploadFile)
                        throw new Error('Slack file uploads are unavailable.');
                    const tickets = [];
                    for (const attachment of output.attachments) {
                        signal.throwIfAborted();
                        if (!Buffer.isBuffer(attachment.data) || attachment.data.length === 0)
                            throw new Error('Empty Slack attachment.');
                        const name = slackOutputName(attachment.displayName);
                        const ticket = await this.api.call('files.getUploadURLExternal', { filename: name, length: String(attachment.data.length) }, signal);
                        if (typeof ticket.upload_url !== 'string' || typeof ticket.file_id !== 'string' || !ticket.file_id)
                            throw new Error('Incomplete Slack upload ticket.');
                        if (tickets.some(existing => existing.id === ticket.file_id))
                            throw new Error('Incomplete Slack upload ticket.');
                        tickets.push({ id: ticket.file_id, title: name, uploadUrl: slackUploadUrl(ticket.upload_url).href, data: attachment.data });
                    }
                    for (const ticket of tickets) {
                        signal.throwIfAborted();
                        const response = await this.api.uploadFile(ticket.uploadUrl, ticket.data, signal);
                        if (!response.ok)
                            throw new Error('Slack file transfer failed (HTTP ' + response.status + ').');
                    }
                    signal.throwIfAborted();
                    const completed = await this.api.call('files.completeUploadExternal', { channel_id: input.conversation.channelId,
                        ...(input.conversation.threadId ? { thread_ts: input.conversation.threadId } : {}), files: JSON.stringify(tickets.map(file => ({ id: file.id, title: file.title }))) }, signal);
                    const completedFiles = Array.isArray(completed.files) ? completed.files : [];
                    if (completedFiles.length !== tickets.length)
                        throw new Error('Incomplete Slack upload completion.');
                    const returned = new Set(completedFiles.map(file => typeof file.id === 'string' ? file.id : ''));
                    if (returned.size !== tickets.length || tickets.some(ticket => !returned.has(ticket.id)))
                        throw new Error('Incomplete Slack upload completion.');
                    ids.push(...tickets.map(ticket => 'file:' + ticket.id));
                }
                const state = this.load(key);
                state.represented = [...(state.represented ?? []), ...ids];
                state.scopes ??= {};
                for (const message of sent) {
                    const id = JSON.stringify(['slack', input.conversation.tenantId, input.conversation.channelId, message.position]);
                    state.seen[id] = fingerprint({ authorId: this.config.botUserId, text: message.text });
                    state.positions[id] = message.position;
                    state.scopes[id] = historyScope(input.conversation);
                }
                this.save(key, state);
                return { messageIds: ids };
            },
        });
    }
}
function required(name) { const value = process.env[name]?.trim(); if (!value)
    throw new Error(name + ' is required.'); return value; }
export async function startSlack(signal) {
    signal?.throwIfAborted();
    if (configuredSecurityMode() !== 'shared')
        throw new Error('Slack requires shared provider security mode.');
    const api = new SlackWebApi(required('SLACK_BOT_TOKEN'));
    const connections = new SlackWebApi(required('SLACK_APP_TOKEN'));
    const historyApi = process.env.SLACK_HISTORY_TOKEN ? new SlackWebApi(process.env.SLACK_HISTORY_TOKEN) : api;
    const teamId = required('SLACK_TEAM_ID');
    const auth = await api.call('auth.test', undefined, signal);
    if (auth.team_id !== teamId || typeof auth.user_id !== 'string')
        throw new Error('Slack bot identity does not match configured workspace.');
    const historyAuth = await historyApi.call('auth.test', undefined, signal);
    if (historyAuth.team_id !== teamId)
        throw new Error('Slack history credential belongs to a different workspace.');
    const list = (name) => new Set(required(name).split(',').map(s => s.trim()).filter(Boolean));
    const channels = list('SLACK_ALLOWED_CHANNELS'), users = list('SLACK_ALLOWED_USERS');
    if (!channels.size || !users.size)
        throw new Error('Slack channel and user allowlists cannot be empty.');
    signal?.throwIfAborted();
    const directory = process.env.AI_ASSISTANT_STATE_DIR ?? join(homedir(), '.config', 'ai-assistant', 'adapters');
    const journal = new FileTurnJournal(join(directory, 'slack-turns'));
    let service;
    let engine;
    let stopped = false, socket, retry;
    let connecting = false;
    let stopping;
    const stop = () => {
        if (stopping)
            return stopping;
        stopped = true;
        clearTimeout(retry);
        stopping = Promise.resolve().then(async () => {
            try {
                socket?.close();
            }
            finally {
                try {
                    if (service)
                        await service.shutdown();
                    else
                        journal.close();
                }
                finally {
                    await engine?.shutdown();
                }
            }
        });
        return stopping;
    };
    try {
        service = new ConversationService(journal);
        engine = await createTextEngine(process.env.PROVIDER || 'copilot', join(directory, 'slack-provider-state'));
        signal?.throwIfAborted();
        const adapter = new SlackAdapter({ teamId, installationId: process.env.SLACK_INSTALLATION_ID || 'default', botUserId: auth.user_id,
            channels, users, excludedAuthors: new Set((process.env.SLACK_EXCLUDED_CONTEXT_USERS ?? '').split(',').filter(Boolean)), stateDirectory: join(directory, 'slack-context') }, api, historyApi, engine, service);
        const reconnect = () => { if (!stopped && !signal?.aborted && !retry)
            retry = setTimeout(() => { retry = undefined; void connect(); }, 5000); };
        async function connect() {
            if (stopped || connecting || signal?.aborted)
                return;
            connecting = true;
            try {
                const result = await connections.call('apps.connections.open', undefined, signal);
                if (typeof result.url !== 'string')
                    throw new Error('Missing Socket Mode URL.');
                const url = new URL(result.url);
                if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com'))
                    throw new Error('Invalid Socket Mode endpoint.');
                if (stopped || signal?.aborted)
                    return;
                const ws = new WebSocket(url);
                socket = ws;
                ws.addEventListener('message', event => {
                    void (async () => {
                        const envelope = JSON.parse(String(event.data));
                        if (envelope.type === 'disconnect') {
                            ws.close();
                            return;
                        }
                        if (typeof envelope.envelope_id !== 'string')
                            return;
                        if (envelope.type !== 'events_api') {
                            ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
                            return;
                        }
                        const handle = await adapter.receive(envelope.payload);
                        // Durable service admission happens before success acknowledgement.
                        ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
                        if (handle)
                            void handle.completion.then(record => {
                                if (record.state !== 'delivered')
                                    console.error('[slack] Turn ' + record.state + ': ' + record.error);
                            });
                    })().catch(() => console.error('[slack] Event not accepted; source may retry.'));
                });
                ws.addEventListener('close', reconnect);
                ws.addEventListener('error', () => { ws.close(); reconnect(); });
            }
            catch {
                if (!stopped && !signal?.aborted) {
                    console.error('[slack] Connection failed; retrying.');
                    reconnect();
                }
            }
            finally {
                connecting = false;
            }
        }
        await adapter.recover(signal);
        signal?.throwIfAborted();
        await connect();
        signal?.throwIfAborted();
        return { stop };
    }
    catch (error) {
        try {
            await stop();
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Slack startup and cleanup failed.');
        }
        throw error;
    }
}
