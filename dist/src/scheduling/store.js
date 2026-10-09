import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nextOccurrences, scheduleHasEnded, scheduleHasStarted } from "./cron.js";
import { scheduleDestination, scheduleOwnerKey, schedulePlatform, scheduleTenantKey } from "./types.js";
export class SchedulerLeaseHeldError extends Error {
}
const LEGACY_RESTART_PAUSE = "Interrupted by restart. Inspect before resuming; execution or delivery may have occurred.";
const LEGACY_SAVED_OUTPUT = "Output was saved before restart. Retry delivery if it is still wanted.";
/** One active scheduler per database. A lease fences stale workers before external delivery. */
export class ScheduleStore {
    db;
    owner = randomUUID();
    constructor(file) {
        if (file !== ":memory:")
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.db = new Database(file);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.db.pragma("busy_timeout = 5000");
        const initialized = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get());
        if (!initialized) {
            this.db.exec(`
        CREATE TABLE scheduler_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL, next_run INTEGER NOT NULL, data TEXT NOT NULL, platform TEXT NOT NULL, owner_key TEXT NOT NULL, tenant_key TEXT NOT NULL);
        CREATE INDEX tasks_due ON tasks(enabled, next_run);
        CREATE INDEX tasks_platform_due ON tasks(platform, enabled, next_run);
        CREATE INDEX tasks_owner_key ON tasks(owner_key);
        CREATE INDEX tasks_tenant_key ON tasks(tenant_key);
        CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, occurrence TEXT NOT NULL, state TEXT NOT NULL, started INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(task_id, occurrence));
        CREATE INDEX runs_task ON runs(task_id, started);
        CREATE TABLE schedule_proposals (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, conversation_key TEXT NOT NULL, payload_hash TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL, consumed_result TEXT);
        PRAGMA user_version=2;
      `);
        }
        else {
            try {
                this.migrate(file);
            }
            catch (error) {
                this.db.close();
                throw error;
            }
        }
    }
    migrate(file) {
        const version = this.db.pragma("user_version", { simple: true });
        if (version >= 2)
            return;
        const lock = this.db.prepare("SELECT expires FROM scheduler_lock WHERE id=1").get();
        if (lock && lock.expires > Date.now())
            throw new SchedulerLeaseHeldError("Cannot migrate schedules while another scheduler lease is active.");
        if (file !== ":memory:" && !fs.existsSync(file + ".pre-v2-backup")) {
            this.db.pragma("wal_checkpoint(TRUNCATE)");
            fs.copyFileSync(file, file + ".pre-v2-backup", fs.constants.COPYFILE_EXCL);
            for (const suffix of ["-wal", "-shm"])
                if (fs.existsSync(file + suffix))
                    fs.copyFileSync(file + suffix, file + ".pre-v2-backup" + suffix, fs.constants.COPYFILE_EXCL);
        }
        this.db.transaction(() => {
            const currentLock = this.db.prepare("SELECT expires FROM scheduler_lock WHERE id=1").get();
            if (currentLock && currentLock.expires > Date.now())
                throw new SchedulerLeaseHeldError("Cannot migrate schedules while another scheduler lease is active.");
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const names = new Set(columns.map(column => column.name));
            if (!names.has("platform"))
                this.db.exec("ALTER TABLE tasks ADD COLUMN platform TEXT NOT NULL DEFAULT 'discord'");
            if (!names.has("owner_key"))
                this.db.exec("ALTER TABLE tasks ADD COLUMN owner_key TEXT NOT NULL DEFAULT ''");
            if (!names.has("tenant_key"))
                this.db.exec("ALTER TABLE tasks ADD COLUMN tenant_key TEXT NOT NULL DEFAULT ''");
            const rows = this.db.prepare("SELECT id, data FROM tasks").all();
            for (const row of rows) {
                const task = JSON.parse(row.data);
                task.destination = scheduleDestination(task);
                task.guildId ||= task.destination.tenantId;
                task.channelId ||= task.destination.channelId;
                this.db.prepare("UPDATE tasks SET platform=?, owner_key=?, tenant_key=?, data=? WHERE id=?")
                    .run(schedulePlatform(task), scheduleOwnerKey(task), scheduleTenantKey(task), JSON.stringify(task), row.id);
            }
            const runs = this.db.prepare("SELECT id, data FROM runs").all();
            for (const row of runs) {
                const run = JSON.parse(row.data);
                const task = this.get(run.taskId);
                if (task && !run.destination)
                    run.destination = scheduleDestination(task);
                this.db.prepare("UPDATE runs SET data=? WHERE id=?").run(JSON.stringify(run), row.id);
            }
            this.db.exec("CREATE INDEX IF NOT EXISTS tasks_platform_due ON tasks(platform, enabled, next_run); CREATE INDEX IF NOT EXISTS tasks_owner_key ON tasks(owner_key); CREATE INDEX IF NOT EXISTS tasks_tenant_key ON tasks(tenant_key); CREATE TABLE IF NOT EXISTS schedule_proposals (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, conversation_key TEXT NOT NULL, payload_hash TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL, consumed_result TEXT); PRAGMA user_version=2");
        }).exclusive();
    }
    acquire(now) {
        const result = this.db.prepare(`INSERT INTO scheduler_lock VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE scheduler_lock.expires <= ?`).run(this.owner, now + 60_000, now);
        if (!result.changes)
            throw new SchedulerLeaseHeldError("Another scheduler owns this database. Wait for its 60-second lease to expire.");
    }
    renew(now) {
        const result = this.db.prepare("UPDATE scheduler_lock SET expires=? WHERE owner=? AND expires>?").run(now + 60_000, this.owner, now);
        if (!result.changes)
            throw new Error("Scheduler lease lost; restart required.");
    }
    assertLease(now = Date.now()) {
        if (!this.db.prepare("SELECT 1 FROM scheduler_lock WHERE owner=? AND expires>?").get(this.owner, now))
            throw new Error("Scheduler lease lost; restart required.");
    }
    close() {
        if (!this.db.open)
            return;
        this.db.prepare("DELETE FROM scheduler_lock WHERE owner=?").run(this.owner);
        this.db.close();
    }
    saveProposal(proposal) {
        this.db.prepare("INSERT INTO schedule_proposals (id,owner_key,conversation_key,payload_hash,data,expires,consumed_result) VALUES (?,?,?,?,?,?,NULL)")
            .run(proposal.id, proposal.ownerKey, proposal.conversationKey, proposal.payloadHash, proposal.data, proposal.expires);
    }
    getProposal(id) {
        const row = this.db.prepare("SELECT id,owner_key AS ownerKey,conversation_key AS conversationKey,payload_hash AS payloadHash,data,expires,consumed_result AS consumedResult FROM schedule_proposals WHERE id=?").get(id);
        return row ?? undefined;
    }
    consumeProposal(id, result) {
        return Boolean(this.db.prepare("UPDATE schedule_proposals SET consumed_result=? WHERE id=? AND consumed_result IS NULL").run(result, id).changes);
    }
    deleteProposal(id) { this.db.prepare("DELETE FROM schedule_proposals WHERE id=? AND consumed_result IS NULL").run(id); }
    get(id) {
        const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
        return row ? JSON.parse(row.data) : undefined;
    }
    list(guildId, platform) {
        const rows = (guildId && platform ? this.db.prepare("SELECT data FROM tasks WHERE tenant_key=? AND platform=? ORDER BY next_run").all(JSON.stringify([platform, guildId]), platform)
            : guildId ? this.db.prepare("SELECT data FROM tasks WHERE guild_id=? ORDER BY next_run").all(guildId)
                : platform ? this.db.prepare("SELECT data FROM tasks WHERE platform=? ORDER BY next_run").all(platform)
                    : this.db.prepare("SELECT data FROM tasks ORDER BY next_run").all());
        return rows.map(row => JSON.parse(row.data));
    }
    save(task) {
        task.destination = scheduleDestination(task);
        this.db.prepare(`INSERT INTO tasks (id,guild_id,owner_id,enabled,next_run,data,platform,owner_key,tenant_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, next_run=excluded.next_run, data=excluded.data, platform=excluded.platform, owner_key=excluded.owner_key, tenant_key=excluded.tenant_key`).run(task.id, task.guildId, task.ownerId, Number(task.enabled), task.nextRunAt, JSON.stringify(task), schedulePlatform(task), scheduleOwnerKey(task), scheduleTenantKey(task));
    }
    create(task, maxOwner, maxGuild) {
        this.db.transaction(() => {
            const owner = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE owner_key=?").get(scheduleOwnerKey(task));
            const guild = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE tenant_key=?").get(scheduleTenantKey(task));
            if (owner.n >= maxOwner || guild.n >= maxGuild)
                throw new Error("Schedule limit reached. Delete an existing task first.");
            this.save(task);
        }).immediate();
    }
    createFromProposal(task, maxOwner, maxGuild, proposalId) {
        return this.db.transaction(() => {
            const proposal = this.getProposal(proposalId);
            if (!proposal)
                throw new Error("Schedule proposal not found.");
            if (proposal.consumedResult)
                return { created: false, resultId: proposal.consumedResult };
            const owner = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE owner_key=?").get(scheduleOwnerKey(task));
            const tenant = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE tenant_key=?").get(scheduleTenantKey(task));
            if (owner.n >= maxOwner || tenant.n >= maxGuild)
                throw new Error("Schedule limit reached. Delete an existing task first.");
            this.save(task);
            if (!this.consumeProposal(proposalId, task.id))
                throw new Error("Schedule proposal was already consumed.");
            return { created: true, resultId: task.id };
        }).immediate();
    }
    delete(id) { this.db.prepare("DELETE FROM tasks WHERE id=?").run(id); }
    pause(id, reason) {
        const task = this.get(id);
        if (task)
            this.save({ ...task, enabled: false, revision: task.revision + 1, pauseReason: reason });
    }
    expire(id, now) {
        const task = this.get(id);
        if (!task || !scheduleHasEnded(task, now))
            return false;
        if (task.enabled)
            this.pause(id, "Schedule reached its end date.");
        return true;
    }
    runs(taskId) {
        const rows = this.db.prepare("SELECT data FROM runs WHERE task_id=? ORDER BY started DESC LIMIT 20").all(taskId);
        return rows.map(row => JSON.parse(row.data));
    }
    getRun(id) {
        const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id);
        return row ? JSON.parse(row.data) : undefined;
    }
    saveRun(run) {
        this.db.prepare("UPDATE runs SET state=?, data=? WHERE id=?").run(run.state, JSON.stringify(run), run.id);
    }
    busy(taskId) {
        return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE task_id=? AND state IN ('queued','running','ready','sending')").get(taskId));
    }
    pendingRuns(platform) {
        const rows = (platform ? this.db.prepare("SELECT r.data FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.state IN ('queued','ready') AND t.platform=? ORDER BY r.started").all(platform)
            : this.db.prepare("SELECT data FROM runs WHERE state IN ('queued','ready') ORDER BY started").all());
        return rows.map(row => JSON.parse(row.data));
    }
    claim(taskId, now, minimumMs, manual = false, platform) {
        return this.db.transaction(() => {
            this.assertLease(now);
            if (this.expire(taskId, now))
                return;
            const task = this.get(taskId);
            if (!task || (platform && schedulePlatform(task) !== platform) || !task.enabled || !scheduleHasStarted(task, now) || (!manual && task.nextRunAt > now))
                return;
            if (this.busy(taskId) || (task.lastStartedAt !== undefined && now - task.lastStartedAt < minimumMs)) {
                if (!manual) {
                    task.nextRunAt = nextOccurrences(task.cron, task.timezone, now, 1)[0];
                    this.save(task);
                }
                return;
            }
            const occurrence = manual ? `manual:${randomUUID()}` : String(task.nextRunAt);
            const run = { id: randomUUID(), taskId, channelId: task.channelId, destination: scheduleDestination(task), taskRevision: task.revision, occurrence, startedAt: now, state: "running", parts: [], messageIds: [] };
            this.db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)").run(run.id, taskId, occurrence, run.state, now, JSON.stringify(run));
            task.nextRunAt = nextOccurrences(task.cron, task.timezone, now, 1)[0];
            task.lastStartedAt = now;
            this.save(task);
            // Keep the latest 20 runs, including unresolved outcomes; never delete an active run.
            this.db.prepare(`DELETE FROM runs WHERE task_id=? AND state IN ('succeeded','failed','cancelled','delivery_failed','uncertain') AND id NOT IN (SELECT id FROM runs WHERE task_id=? ORDER BY started DESC LIMIT 20)`).run(taskId, taskId);
            return { task, run };
        }).immediate();
    }
    recover(now, platform) {
        this.db.transaction(() => {
            this.assertLease(now);
            // Repair only the exact automatic pause made by older versions. A subsequent
            // edit/user pause changes the revision or reason and must remain respected.
            for (const task of this.list(undefined, platform)) {
                if (task.enabled || task.pauseReason !== LEGACY_RESTART_PAUSE || scheduleHasEnded(task, now))
                    continue;
                const run = this.runs(task.id)[0];
                if (!run || run.state !== "uncertain" || run.error !== LEGACY_RESTART_PAUSE || task.revision !== run.taskRevision + 1)
                    continue;
                task.enabled = true;
                task.pauseReason = undefined;
                task.revision++;
                this.save(task);
                run.taskRevision = task.revision;
                // The old recovery code retained parts, so empty output identifies generation.
                run.state = run.parts.length || run.messageIds.length ? "sending" : "running";
                this.saveRun(run);
            }
            const interrupted = (platform ? this.db.prepare(`SELECT r.data FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.platform=? AND (r.state IN ('queued','running','ready','sending')
        OR (r.state='delivery_failed' AND json_extract(r.data, '$.error')=?))`).all(platform, LEGACY_SAVED_OUTPUT)
                : this.db.prepare(`SELECT data FROM runs WHERE state IN ('queued','running','ready','sending') OR (state='delivery_failed' AND json_extract(data, '$.error')=?)`).all(LEGACY_SAVED_OUTPUT));
            for (const row of interrupted) {
                const run = JSON.parse(row.data);
                const task = this.get(run.taskId);
                if (run.state === "sending") {
                    run.state = "uncertain";
                    run.error = "Delivery was interrupted by restart and may have occurred. This run will not be replayed.";
                }
                else if (!task?.enabled || task.revision !== run.taskRevision || !scheduleHasStarted(task, now) || scheduleHasEnded(task, now)) {
                    run.state = "cancelled";
                    run.parts = [];
                    run.error = "Interrupted run cancelled because the schedule was paused, changed, or is outside its dates.";
                }
                else if (run.state === "running") {
                    run.recoveryAttempts = (run.recoveryAttempts ?? 0) + 1;
                    run.state = run.recoveryAttempts <= 3 ? "queued" : "failed";
                    run.error = run.state === "queued" ? "Generation interrupted by restart; queued to run again."
                        : "Generation interrupted too many times. This occurrence was skipped; future occurrences continue.";
                }
                else if (run.state !== "queued") {
                    run.state = "ready";
                    run.error = "Resuming saved output after restart.";
                }
                this.saveRun(run);
            }
            for (const task of this.list(undefined, platform)) {
                if (this.expire(task.id, now))
                    continue;
                if (task.enabled && task.nextRunAt <= now) {
                    task.nextRunAt = nextOccurrences(task.cron, task.timezone, now, 1)[0];
                    this.save(task);
                }
            }
        }).immediate();
    }
}
