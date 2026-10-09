import { randomUUID } from "node:crypto";
import { RunTimeoutError } from "../providers/types.js";
import { validateSchedule, nextOccurrences, scheduleHasStarted } from "./cron.js";
import { SCHEDULE_ENDED_PAUSE_REASON, SchedulerLeaseHeldError } from "./store.js";
import { schedulePlatform } from "./types.js";
import { retainVerifiedLookups } from "./lookups.js";
export function scheduleLimits(env = process.env) {
    const number = (key, fallback, min, max) => {
        const value = env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
        if (!Number.isSafeInteger(value) || value < min || value > max)
            throw new Error(`Invalid ${key}: expected ${min}–${max}.`);
        return value;
    };
    return {
        minimumMs: number("SCHEDULE_MIN_INTERVAL_MINUTES", 15, 1, 1440) * 60_000,
        maxOwner: number("SCHEDULE_MAX_PER_USER", 10, 1, 1000), maxGuild: number("SCHEDULE_MAX_PER_GUILD", 50, 1, 10000),
        concurrency: number("SCHEDULE_CONCURRENCY", 2, 1, 10), timeoutMs: number("SCHEDULE_AI_TIMEOUT_MS", 600_000, 1000, 3_600_000),
    };
}
export class ScheduleAccessError extends Error {
}
export class DeliveryRejectedError extends Error {
}
export class DeliveryUncertainError extends Error {
}
export class Scheduler {
    store;
    access;
    adapter;
    limits;
    now;
    active = new Map();
    timer;
    stopped = true;
    ownsLease = false;
    constructor(store, access, adapter, limits = scheduleLimits(), now = Date.now) {
        this.store = store;
        this.access = access;
        this.adapter = adapter;
        this.limits = limits;
        this.now = now;
    }
    get platform() { return this.adapter.platform ?? "discord"; }
    start() {
        if (!this.stopped)
            return;
        this.stopped = false;
        try {
            this.tick();
        }
        catch (error) {
            this.stopped = true;
            throw error;
        }
        if (!this.ownsLease)
            console.log("[scheduler] Waiting for the previous worker's lease to expire.");
        this.timer = setInterval(() => {
            try {
                if (this.ownsLease)
                    this.store.renew(this.now());
                this.tick();
            }
            catch (error) {
                this.stopped = true;
                clearInterval(this.timer);
                console.error("[scheduler] Stopped:", error);
            }
        }, 5000);
    }
    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        // Keep the lease alive while already-running providers drain.
        const heartbeat = setInterval(() => { try {
            if (this.ownsLease)
                this.store.renew(this.now());
        }
        catch { /* Delivery checks still fence this worker. */ } }, 5000);
        try {
            await Promise.allSettled(this.active.values());
        }
        finally {
            clearInterval(heartbeat);
            this.store.close();
        }
    }
    assertAvailable() {
        if (this.stopped)
            throw new Error("Scheduler is not running.");
        if (!this.ownsLease)
            throw new Error("Scheduler is waiting for the previous worker's lease to expire; it will start automatically.");
        this.store.assertLease(this.now());
    }
    canManage(subject, task) {
        return this.access.can(subject, "schedule.manage.tenant", task) || this.access.can(subject, "schedule.manage.guild", task) || this.access.can(subject, "schedule.manage.own", task);
    }
    requireManage(subject, task) {
        if (!this.canManage(subject, task))
            throw new ScheduleAccessError("You cannot manage this schedule.");
    }
    requireCreate(subject, task) {
        if (!this.access.can(subject, task.kind === "ai" ? "schedule.ai.create" : "schedule.message.create", task)) {
            throw new ScheduleAccessError(task.kind === "ai" ? "You do not have permission to create AI schedules." : "You do not have permission to create message schedules.");
        }
    }
    async create(subject, input) {
        const task = await this.prepareCreate(subject, input);
        this.store.create(task, this.limits.maxOwner, this.limits.maxGuild);
        return task;
    }
    async prepareCreate(subject, input, id = randomUUID()) {
        this.assertAvailable();
        this.requireCreate(subject, input);
        const task = { ...input, id, ownerId: subject.userId, createdAt: this.now(), revision: 1, enabled: true, nextRunAt: 0 };
        this.validate(task);
        await this.adapter.authorize(task, subject.userId);
        this.assertAvailable();
        this.validate(task);
        return task;
    }
    commitPrepared(task, proposalId) {
        this.assertAvailable();
        const result = this.store.createFromProposal(task, this.limits.maxOwner, this.limits.maxGuild, proposalId);
        return this.store.get(result.resultId) ?? task;
    }
    validate(task) {
        if (!["message", "ai"].includes(task.kind) || !task.content.trim() || task.content.length > 6000)
            throw new Error("Provide message text or a prompt of 1–6000 characters.");
        if (!Number.isInteger(task.contextMessages) || task.contextMessages < 0 || task.contextMessages > 100)
            throw new Error("Context messages must be between 0 and 100.");
        if (task.kind === "message" && task.contextMessages !== 0)
            throw new Error("Fixed messages cannot use AI context.");
        if (task.kind === "ai" && (!task.provider || !task.model))
            throw new Error("AI schedules require a saved provider and model.");
        if (task.startAt !== undefined && (!Number.isSafeInteger(task.startAt) || !Number.isFinite(new Date(task.startAt).getTime()))) {
            throw new Error("The start date must be a valid date and time.");
        }
        if (task.endAt !== undefined && (!Number.isSafeInteger(task.endAt) || !Number.isFinite(new Date(task.endAt).getTime()) || task.endAt <= this.now())) {
            throw new Error("The end date must be a valid date and time in the future. Edit or clear the end date to resume an ended schedule.");
        }
        if (task.startAt !== undefined && task.endAt !== undefined && task.endAt <= task.startAt) {
            throw new Error("The end date must be after the start date.");
        }
        task.nextRunAt = validateSchedule(task.cron, task.timezone, this.limits.minimumMs, this.now(), task.startAt);
    }
    async edit(subject, id, patch) {
        this.assertAvailable();
        const before = this.requireTask(subject, id);
        const reviveExpired = !before.enabled && before.pauseReason === SCHEDULE_ENDED_PAUSE_REASON
            && Object.prototype.hasOwnProperty.call(patch, "endAt");
        this.requireCreate(subject, before);
        const task = { ...before, ...patch, revision: before.revision + 1 };
        this.validate(task);
        await this.adapter.authorize(task, subject.userId);
        this.assertAvailable();
        const latest = this.store.get(id);
        if (latest?.revision !== before.revision)
            throw new Error("Schedule changed; try again.");
        this.validate(task);
        // Apply elapsed cutoffs to the saved revision before a patch can clear or extend them.
        // Do this after authorization so a rejected edit cannot mutate the owner's schedule.
        if (this.store.expire(id, this.now())) {
            const ended = this.store.get(id);
            task.enabled = false;
            task.pauseReason = ended.pauseReason;
            task.revision = ended.revision + 1;
        }
        if (reviveExpired) {
            task.enabled = true;
            task.pauseReason = undefined;
        }
        task.lastStartedAt = latest.lastStartedAt;
        task.lastVerifiedLookups = task.content === before.content ? latest.lastVerifiedLookups : undefined;
        this.store.save(task);
        return task;
    }
    requireTask(subject, id) {
        const task = this.store.get(id);
        if (!task || !this.canManage(subject, task))
            throw new ScheduleAccessError("Schedule not found or unavailable to you.");
        return task;
    }
    pause(subject, id) { this.assertAvailable(); this.requireTask(subject, id); this.store.pause(id, "Paused by a user."); }
    delete(subject, id) { this.assertAvailable(); this.requireTask(subject, id); this.store.delete(id); }
    async resume(subject, id) {
        this.assertAvailable();
        const task = this.requireTask(subject, id);
        this.requireCreate(subject, task);
        if (this.store.busy(id))
            throw new Error("Wait for the active run to finish before resuming.");
        await this.adapter.authorize(task, subject.userId);
        this.assertAvailable();
        if (this.store.get(id)?.revision !== task.revision)
            throw new Error("Schedule changed; try again.");
        this.validate(task);
        this.store.save({ ...task, enabled: true, pauseReason: undefined, revision: task.revision + 1 });
    }
    async authorizeManual(subject, id) {
        this.assertAvailable();
        const task = this.requireTask(subject, id);
        this.requireCreate(subject, task);
        // Reject the requester before claiming work or modifying a saved delivery.
        // Requester-only failures must not change the owner's recurring schedule.
        await this.adapter.authorize(task, subject.userId);
        this.assertAvailable();
        const latest = this.requireTask(subject, id);
        if (latest.revision !== task.revision)
            throw new Error("Schedule changed; try again.");
        this.assertWithinDates(latest);
        return latest;
    }
    async runNow(subject, id) {
        const task = await this.authorizeManual(subject, id);
        this.assertAvailable();
        if (this.store.get(id)?.revision !== task.revision)
            throw new Error("Schedule changed; try again.");
        this.assertWithinDates(task);
        if (!task.enabled)
            throw new Error(`Task is paused. Use /schedule resume id:${id} before running it.`);
        if (this.active.size >= this.limits.concurrency)
            throw new Error("Scheduler is busy; try again later.");
        if (schedulePlatform(task) !== this.platform)
            throw new ScheduleAccessError("This schedule belongs to a different platform worker.");
        const claimed = this.store.claim(id, this.now(), this.limits.minimumMs, true, this.platform);
        if (!claimed)
            throw new Error("Task is already running or within its minimum run interval.");
        this.launch(claimed.task, claimed.run);
        return claimed.run.id;
    }
    async retryDelivery(subject, id, runId) {
        const task = await this.authorizeManual(subject, id);
        this.assertAvailable();
        if (this.store.get(id)?.revision !== task.revision)
            throw new Error("Schedule changed; try again.");
        this.assertWithinDates(task);
        const run = this.store.getRun(runId);
        if (!run || run.taskId !== id || run.state !== "delivery_failed" || run.taskRevision !== task.revision) {
            throw new Error("Only a definitely rejected delivery from the current task revision can be retried. Uncertain sends need manual inspection.");
        }
        if (!task.enabled || this.store.busy(id) || this.active.size >= this.limits.concurrency)
            throw new Error("Task is paused or scheduler is busy.");
        run.state = "ready";
        run.error = undefined;
        this.store.saveRun(run);
        this.launch(task, run);
    }
    tick() {
        if (this.stopped)
            return;
        if (!this.ownsLease) {
            try {
                this.store.acquire(this.now());
            }
            catch (error) {
                if (error instanceof SchedulerLeaseHeldError)
                    return;
                throw error;
            }
            this.store.recover(this.now(), this.platform);
            this.ownsLease = true;
        }
        this.store.assertLease(this.now());
        for (const run of this.store.pendingRuns(this.platform)) {
            if (this.active.size >= this.limits.concurrency)
                break;
            if (this.active.has(run.id))
                continue;
            const task = this.store.get(run.taskId);
            if (task)
                this.launch(task, run);
        }
        for (const task of this.store.list(undefined, this.platform)) {
            if (this.store.expire(task.id, this.now()))
                continue;
            if (!task.enabled || !scheduleHasStarted(task, this.now()) || task.nextRunAt > this.now())
                continue;
            // Do not accumulate a backlog while all worker slots are occupied.
            if (this.active.size >= this.limits.concurrency) {
                this.store.save({ ...task, nextRunAt: nextOccurrences(task.cron, task.timezone, this.now(), 1)[0] });
                continue;
            }
            const claimed = this.store.claim(task.id, this.now(), this.limits.minimumMs, false, this.platform);
            if (claimed)
                this.launch(claimed.task, claimed.run);
        }
    }
    launch(task, run) {
        if (this.active.has(run.id))
            return;
        const pending = this.execute(task, run).catch(error => console.error("[scheduler] Run persistence failed:", error));
        this.active.set(run.id, pending);
        void pending.finally(() => this.active.delete(run.id));
    }
    async idle() { await Promise.all(this.active.values()); }
    assertWithinDates(task) {
        if (this.store.expire(task.id, this.now()))
            throw new ScheduleAccessError("Schedule has ended. Edit or clear its end date before resuming.");
        if (!scheduleHasStarted(task, this.now()))
            throw new ScheduleAccessError("Schedule has not started yet. Wait until its start date, or edit or clear the start date.");
    }
    current(task) {
        this.store.assertLease(this.now());
        const latest = this.store.get(task.id);
        const endedAfterClaim = latest?.enabled === false
            && latest.pauseReason === SCHEDULE_ENDED_PAUSE_REASON
            && latest.revision === task.revision + 1
            && latest.lastStartedAt === task.lastStartedAt
            && latest.endAt === task.endAt;
        // stop() rejects new work but drains claimed runs while retaining the lease.
        if (!latest || ((!latest.enabled || latest.revision !== task.revision) && !endedAfterClaim)) {
            throw new ScheduleAccessError("Task was paused, edited, or deleted.");
        }
    }
    async execute(task, run) {
        try {
            this.current(task);
            if (run.taskRevision !== task.revision)
                throw new ScheduleAccessError("Task was edited after this run was saved.");
            await this.adapter.authorize(task);
            this.current(task);
            if (run.state === "queued") {
                run.state = "running";
                run.error = undefined;
                this.store.saveRun(run);
            }
            if (run.state === "running") {
                run.parts = await this.adapter.generate(task, run, this.limits.timeoutMs);
                this.current(task);
                if (!run.parts.length || JSON.stringify(run.parts).length > 20_000_000)
                    throw new Error("Scheduled output is empty or exceeds the 20 MB run limit.");
                if (run.lookups?.some(record => record.status === "verified")) {
                    const latest = this.store.get(task.id);
                    latest.lastVerifiedLookups = retainVerifiedLookups(latest.lastVerifiedLookups, run.lookups);
                    this.store.save(latest);
                }
                run.state = "ready";
                this.store.saveRun(run);
            }
            for (const part of run.parts.slice(run.messageIds.length)) {
                await this.adapter.authorize(task);
                this.current(task);
                run.state = "sending";
                this.store.saveRun(run);
                const messageId = await this.adapter.send(task, part, `${run.id}:${run.messageIds.length}`, () => this.current(task));
                this.store.assertLease(this.now());
                run.messageIds.push(messageId);
                run.state = "ready";
                this.store.saveRun(run);
            }
            run.state = "succeeded";
            run.error = undefined;
            // IDs are enough for successful history; avoid retaining large attachment payloads.
            run.parts = [];
            this.store.saveRun(run);
        }
        catch (error) {
            // If another worker recovered this run, never overwrite its recovery decision.
            this.store.assertLease(this.now());
            run.error = error instanceof ScheduleAccessError ? error.message : "Run failed; see bot logs for details.";
            console.error(`[scheduler] Run ${run.id}:`, error);
            if (error instanceof ScheduleAccessError)
                run.state = "cancelled";
            else if (error instanceof DeliveryRejectedError)
                run.state = "delivery_failed";
            else if (error instanceof DeliveryUncertainError)
                run.state = "uncertain";
            else if (run.state === "sending" || (error instanceof RunTimeoutError && !error.cancellationConfirmed))
                run.state = "uncertain";
            else
                run.state = "failed";
            this.store.saveRun(run);
            const latest = this.store.get(task.id);
            if (latest?.revision === task.revision && run.taskRevision === task.revision && (error instanceof ScheduleAccessError
                || (error instanceof RunTimeoutError && !error.cancellationConfirmed)
                || this.store.runs(task.id).slice(0, 3).filter(previous => previous.state === "failed").length === 3)) {
                this.store.pause(task.id, run.error);
            }
        }
    }
}
