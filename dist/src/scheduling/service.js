import { createHash, randomBytes, randomUUID } from "node:crypto";
import { nextOccurrences } from "./cron.js";
import { scheduleDestination } from "./types.js";
const stableHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const principalKey = (actor) => JSON.stringify([actor.platform, actor.tenantId, actor.userId]);
const conversationKey = (conversation) => JSON.stringify([conversation.platform, conversation.tenantId, conversation.installationId, conversation.channelId, conversation.threadId ?? null, conversation.kind]);
const subject = (actor) => ({ platform: actor.platform, tenantId: actor.tenantId, guildId: actor.platform === "discord" ? actor.tenantId : undefined, userId: actor.userId });
export class ScheduleService {
    scheduler;
    now;
    constructor(scheduler, now = Date.now) {
        this.scheduler = scheduler;
        this.now = now;
    }
    async proposeCreate(actor, conversation, input) {
        const id = "proposal_" + randomBytes(6).toString("hex");
        const task = await this.scheduler.prepareCreate(subject(actor), input, randomUUID());
        const payloadHash = stableHash(input);
        const expiresAt = this.now() + 10 * 60_000;
        this.scheduler.store.saveProposal({ id, ownerKey: principalKey(actor), conversationKey: conversationKey(conversation), payloadHash,
            data: JSON.stringify({ action: "create", input, taskId: task.id }), expires: expiresAt });
        return { id, expiresAt, task, summary: this.describe(task) };
    }
    async proposeEdit(actor, conversation, idToEdit, patch) {
        const before = this.scheduler.requireTask(subject(actor), idToEdit);
        if (!Object.keys(patch).length)
            throw new Error("Provide at least one field to edit.");
        const id = "proposal_" + randomBytes(6).toString("hex"), expiresAt = this.now() + 10 * 60_000;
        const proposed = { ...before, ...patch, revision: before.revision + 1 };
        const payload = { action: "edit", scheduleId: idToEdit, patch, baseRevision: before.revision };
        this.scheduler.store.saveProposal({ id, ownerKey: principalKey(actor), conversationKey: conversationKey(conversation), payloadHash: stableHash(payload), data: JSON.stringify(payload), expires: expiresAt });
        return { id, expiresAt, task: proposed, summary: this.describe(proposed) };
    }
    async confirm(actor, conversation, proposalId) {
        const proposal = this.scheduler.store.getProposal(proposalId);
        if (!proposal || proposal.ownerKey !== principalKey(actor) || proposal.conversationKey !== conversationKey(conversation))
            throw new Error("Schedule proposal not found for this actor and conversation.");
        if (proposal.expires < this.now())
            throw new Error("Schedule proposal expired; create a new proposal.");
        if (proposal.consumedResult) {
            const existing = this.scheduler.store.get(proposal.consumedResult);
            if (!existing)
                throw new Error("The confirmed schedule no longer exists.");
            return { task: existing, duplicate: true };
        }
        const data = JSON.parse(proposal.data);
        const payload = data.action === "create" ? data.input : data;
        if (stableHash(payload) !== proposal.payloadHash)
            throw new Error("Schedule proposal failed its integrity check.");
        if (data.action === "edit") {
            const current = this.scheduler.requireTask(subject(actor), data.scheduleId);
            if (current.revision !== data.baseRevision)
                throw new Error("Schedule changed since this proposal was created; create a new edit proposal.");
            const task = await this.scheduler.edit(subject(actor), data.scheduleId, data.patch);
            if (!this.scheduler.store.consumeProposal(proposalId, task.id))
                throw new Error("Schedule proposal was already consumed.");
            return { task, duplicate: false };
        }
        // Re-run every validation and live authorization check at confirmation.
        const task = await this.scheduler.prepareCreate(subject(actor), data.input, data.taskId);
        const committed = this.scheduler.commitPrepared(task, proposalId);
        return { task: committed, duplicate: committed.id !== task.id };
    }
    cancelProposal(actor, conversation, proposalId) {
        const proposal = this.scheduler.store.getProposal(proposalId);
        if (!proposal || proposal.ownerKey !== principalKey(actor) || proposal.conversationKey !== conversationKey(conversation) || proposal.consumedResult) {
            throw new Error("Active schedule proposal not found for this actor and conversation.");
        }
        this.scheduler.store.deleteProposal(proposalId);
    }
    list(actor) {
        return this.scheduler.store.list(actor.tenantId, actor.platform).filter(task => this.scheduler.canManage(subject(actor), task));
    }
    inspect(actor, conversation, id) {
        const task = this.scheduler.requireTask(subject(actor), id);
        const d = scheduleDestination(task);
        const sameAudience = d.channelId === conversation.channelId && (d.threadId ?? undefined) === (conversation.threadId ?? undefined);
        return { task: sameAudience ? task : { ...task, content: "[redacted: inspect from the saved destination]", lastVerifiedLookups: undefined },
            runs: sameAudience ? this.scheduler.store.runs(id) : [], redacted: !sameAudience };
    }
    pause(actor, id) { this.scheduler.pause(subject(actor), id); }
    resume(actor, id) { return this.scheduler.resume(subject(actor), id); }
    delete(actor, id) { this.scheduler.delete(subject(actor), id); }
    runNow(actor, id) { return this.scheduler.runNow(subject(actor), id); }
    retryDelivery(actor, id, runId) { return this.scheduler.retryDelivery(subject(actor), id, runId); }
    describe(task) {
        const d = scheduleDestination(task);
        const next = nextOccurrences(task.cron, task.timezone, this.now(), 3).filter(value => task.endAt === undefined || value < task.endAt);
        return [`Schedule: ${task.id}`, `Owner: ${task.ownerId}`, `Kind: ${task.kind}`, `Action: ${task.content}`, `Cadence: ${task.cron}`, `Timezone: ${task.timezone}`,
            `Dates: ${task.startAt ? new Date(task.startAt).toISOString() : "now"} to ${task.endAt ? new Date(task.endAt).toISOString() : "no end"}`,
            `Destination: ${d.channelId}${d.threadId ? ` thread ${d.threadId}` : ""}`, `Context messages: ${task.contextMessages}`,
            `Provider/model: ${task.kind === "ai" ? `${task.provider}/${task.model}${task.reasoning ? ` (${task.reasoning})` : ""}` : "not applicable"}`,
            `Next: ${next.map(value => new Date(value).toISOString()).join(", ") || "none"}`].join("\n");
    }
}
