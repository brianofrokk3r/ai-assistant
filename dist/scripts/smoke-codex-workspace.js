import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SENSITIVE_DIRECTORY_NAME_LIST } from "../src/common/providerSecurity.js";
import { codexFilesystemPermissionOverride, createCodexSessionTemporaryDirectory, prepareCodexWorkingDirectory, } from "../src/providers/codex.js";
// Exercise the production sandbox without model calls, credentials, or Discord.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-smoke-"));
const temporary = createCodexSessionTemporaryDirectory();
const hostOnly = fs.mkdtempSync(path.join(os.tmpdir(), "github-host-only-"));
fs.writeFileSync(path.join(hostOnly, "publisher.pem"), "private key fixture, not a credential");
fs.writeFileSync(path.join(hostOnly, "contributions.json"), "host-owned contribution state fixture");
process.env.AI_ASSISTANT_SECURITY_MODE = "shared";
process.env.AI_ASSISTANT_WORKSPACE_ROOT = root;
try {
    const runs = path.join(root, ".scheduled-runs");
    fs.mkdirSync(runs);
    for (const [sites, existing] of [[false, false], [true, false], [false, true], [true, true]]) {
        const workspace = fs.mkdtempSync(path.join(runs, "run-"));
        if (existing) {
            for (const name of SENSITIVE_DIRECTORY_NAME_LIST) {
                fs.writeFileSync(path.join(workspace, name), "private fixture", { mode: 0o444 });
            }
        }
        prepareCodexWorkingDirectory(workspace);
        fs.writeFileSync(path.join(workspace, "visible.txt"), "visible fixture");
        fs.writeFileSync(path.join(workspace, ".env"), "denied fixture");
        const result = spawnSync(process.env.CODEX_EXECUTABLE_PATH || "codex", [
            "sandbox", "-C", workspace, "-P", "discord-bot",
            "-c", codexFilesystemPermissionOverride(sites),
            "-c", "permissions.discord-bot.network={enabled=false}",
            "--", "/bin/sh", "-c", [
                "set -eu",
                'test "$(cat visible.txt)" = "visible fixture"',
                "echo ok > output.txt",
                // ls can stat an unreadable regular file; check content access below.
                ...(!existing ? SENSITIVE_DIRECTORY_NAME_LIST.map(name => `if ls '${name}' >/dev/null 2>&1; then exit 20; fi`) : []),
                ...SENSITIVE_DIRECTORY_NAME_LIST.map(name => `if cat '${name}' >/dev/null 2>&1; then exit 25; fi`),
                ...SENSITIVE_DIRECTORY_NAME_LIST.map(name => `if (echo changed > '${name}') 2>/dev/null; then exit 26; fi`),
                "if cat .env >/dev/null 2>&1; then exit 21; fi",
                `if cat '${hostOnly}/publisher.pem' >/dev/null 2>&1; then exit 22; fi`,
                `if cat '${hostOnly}/contributions.json' >/dev/null 2>&1; then exit 23; fi`,
                `if echo corrupted > '${hostOnly}/contributions.json' 2>/dev/null; then exit 24; fi`,
            ].join("; "),
        ], {
            encoding: "utf8", timeout: 15_000,
            env: { PATH: process.env.PATH, HOME: root, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `Workspace sandbox (Sites=${sites}, existing files=${existing}): ${result.stderr}`);
        assert.equal(fs.readFileSync(path.join(workspace, "output.txt"), "utf8"), "ok\n");
        if (existing) {
            for (const name of SENSITIVE_DIRECTORY_NAME_LIST) {
                assert.equal(fs.readFileSync(path.join(workspace, name), "utf8"), "private fixture");
            }
        }
    }
    console.log("Fresh and existing Codex workspaces: writes succeed; credential paths, .env, host GitHub credentials and contribution state remain denied.");
}
finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(hostOnly, { recursive: true, force: true });
}
