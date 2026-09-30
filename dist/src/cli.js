#!/usr/bin/env node
import { createInterface } from "readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolve, dirname, join } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { setupCodexWebSearchMode, setupSecurityMode, setupSitesEnabled } from "./common/providerSecurity.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename);
// Config dir: ~/.ai-assistant/ or override via AI_ASSISTANT_CONFIG_DIR
const CONFIG_DIR = process.env.AI_ASSISTANT_CONFIG_DIR
    ? resolve(process.env.AI_ASSISTANT_CONFIG_DIR)
    : resolve(homedir(), ".ai-assistant");
const ENV_FILE = resolve(CONFIG_DIR, ".env");
// Package root = two directories up from dist/src/cli.js
const PACKAGE_ROOT = resolve(__dirname_local, "../..");
// ─── Helpers ───────────────────────────────────────────────────────────────
function question(rl, prompt) {
    return new Promise((res) => rl.question(prompt, res));
}
function parseEnvFile(path) {
    if (!existsSync(path))
        return {};
    return dotenv.parse(readFileSync(path, "utf-8"));
}
async function promptVar(rl, label, key, existing, required) {
    const current = existing[key] ?? "";
    // Mask sensitive values in the hint
    const isSensitive = key.toLowerCase().includes("token");
    const hint = current
        ? ` [${isSensitive ? current.slice(0, 6) + "..." : current}]`
        : "";
    const suffix = required ? "" : " (optional, Enter to skip)";
    const answer = await question(rl, `${label}${hint}${suffix}: `);
    return answer.trim() || current;
}
// ─── Commands ──────────────────────────────────────────────────────────────
async function setup() {
    if (!existsSync(CONFIG_DIR))
        mkdirSync(CONFIG_DIR, { recursive: true });
    const existing = parseEnvFile(ENV_FILE);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n🤖  AI Assistant Setup");
    console.log(`Config directory: ${CONFIG_DIR}\n`);
    const token = await promptVar(rl, "Discord Bot Token", "DISCORD_TOKEN", existing, true);
    const appId = await promptVar(rl, "Discord Application ID", "DISCORD_APP_ID", existing, true);
    const guildId = await promptVar(rl, "Discord Guild ID (for slash command registration)", "DISCORD_GUILD_ID", existing, true);
    const provider = await promptVar(rl, "AI provider (copilot | codex | opencode)", "PROVIDER", existing, false) || "copilot";
    const validProviders = ["copilot", "codex", "opencode"];
    if (!validProviders.includes(provider)) {
        console.error(`\n❌ Invalid provider "${provider}". Choose one of: ${validProviders.join(", ")}.`);
        rl.close();
        process.exit(1);
    }
    const freeChannels = await promptVar(rl, "Free channel IDs (comma-separated, bot replies without @mention)", "DISCORD_FREE_CHANNELS", existing, false);
    const allowedUsers = await promptVar(rl, "Allowed user IDs (comma-separated, leave empty to allow all users)", "DISCORD_ALLOWED_USERS", existing, false);
    const adminUsers = await promptVar(rl, "Admin user IDs (comma-separated, leave empty to use allowed users)", "DISCORD_ADMIN_USERS", existing, false);
    const systemPrompt = await promptVar(rl, "Bot system prompt (optional operator instructions)", "AI_ASSISTANT_SYSTEM_PROMPT", existing, false);
    const systemPromptFile = await promptVar(rl, "System prompt file path (optional; takes precedence over inline prompt)", "AI_ASSISTANT_SYSTEM_PROMPT_FILE", existing, false);
    const requestedSecurityMode = await promptVar(rl, "Provider security mode (shared | unrestricted)", "AI_ASSISTANT_SECURITY_MODE", existing, false);
    const requestedSitesEnabled = await promptVar(rl, "Enable ChatGPT Sites in shared mode (true | false)", "AI_ASSISTANT_ENABLE_SITES", existing, false);
    const requestedWorkspaceRoot = await promptVar(rl, "Shared-mode workspace root", "AI_ASSISTANT_WORKSPACE_ROOT", existing, false);
    let securityMode;
    let sitesEnabled;
    const workspaceRoot = resolve(requestedWorkspaceRoot || join(CONFIG_DIR, "workspaces"));
    try {
        securityMode = setupSecurityMode(requestedSecurityMode);
        sitesEnabled = setupSitesEnabled(requestedSitesEnabled);
    }
    catch (err) {
        console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
        rl.close();
        process.exit(1);
    }
    if (!token || !appId || !guildId) {
        console.error("\n❌ DISCORD_TOKEN, DISCORD_APP_ID, and DISCORD_GUILD_ID are required.");
        rl.close();
        process.exit(1);
    }
    const lines = [
        `DISCORD_TOKEN=${token}`,
        `DISCORD_APP_ID=${appId}`,
        `DISCORD_GUILD_ID=${guildId}`,
        `PROVIDER=${provider}`,
        freeChannels ? `DISCORD_FREE_CHANNELS=${freeChannels}` : "# DISCORD_FREE_CHANNELS=",
        allowedUsers ? `DISCORD_ALLOWED_USERS=${allowedUsers}` : "# DISCORD_ALLOWED_USERS=",
        adminUsers ? `DISCORD_ADMIN_USERS=${adminUsers}` : "# DISCORD_ADMIN_USERS=",
        systemPrompt
            ? `AI_ASSISTANT_SYSTEM_PROMPT=${JSON.stringify(systemPrompt)}`
            : "# AI_ASSISTANT_SYSTEM_PROMPT=",
        systemPromptFile
            ? `AI_ASSISTANT_SYSTEM_PROMPT_FILE=${JSON.stringify(systemPromptFile)}`
            : "# AI_ASSISTANT_SYSTEM_PROMPT_FILE=",
        `AI_ASSISTANT_SECURITY_MODE=${securityMode}`,
        `AI_ASSISTANT_ENABLE_SITES=${sitesEnabled}`,
        `AI_ASSISTANT_WORKSPACE_ROOT=${JSON.stringify(workspaceRoot)}`,
    ];
    if (provider === "codex") {
        const openaiKey = await promptVar(rl, "OpenAI API Key (optional if Codex CLI is logged in)", "OPENAI_API_KEY", existing, false);
        const codexModel = await promptVar(rl, "Default Codex model (e.g. gpt-5.6-sol)", "CODEX_MODEL", existing, false);
        const codexTimeout = await promptVar(rl, "Codex hard timeout in ms (default 3600000)", "CODEX_TIMEOUT_MS", existing, false);
        const requestedWebSearchMode = await promptVar(rl, "Codex hosted web search (disabled | cached | indexed | live; default cached)", "CODEX_WEB_SEARCH_MODE", existing, false);
        let webSearchMode;
        try {
            webSearchMode = setupCodexWebSearchMode(requestedWebSearchMode);
        }
        catch (err) {
            console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
            rl.close();
            process.exit(1);
        }
        lines.push(openaiKey ? `OPENAI_API_KEY=${openaiKey}` : "# OPENAI_API_KEY=");
        if (codexModel)
            lines.push(`CODEX_MODEL=${codexModel}`);
        if (codexTimeout)
            lines.push(`CODEX_TIMEOUT_MS=${codexTimeout}`);
        lines.push(`CODEX_WEB_SEARCH_MODE=${webSearchMode}`);
    }
    else if (provider === "opencode") {
        const opencodeModel = await promptVar(rl, "Default OpenCode model (provider/model, e.g. openrouter/...)", "OPENCODE_MODEL", existing, false);
        const opencodeTimeout = await promptVar(rl, "OpenCode hard timeout in ms (default 3600000)", "OPENCODE_TIMEOUT_MS", existing, false);
        if (opencodeModel)
            lines.push(`OPENCODE_MODEL=${opencodeModel}`);
        if (opencodeTimeout)
            lines.push(`OPENCODE_TIMEOUT_MS=${opencodeTimeout}`);
    }
    else {
        const copilotTimeout = await promptVar(rl, "Copilot hard timeout in ms (default 3600000)", "COPILOT_TIMEOUT_MS", existing, false);
        if (copilotTimeout)
            lines.push(`COPILOT_TIMEOUT_MS=${copilotTimeout}`);
    }
    // Do not erase a Codex choice when editing an installation that currently
    // selects another provider. It is intentionally not validated until Codex
    // is selected, so an irrelevant stale value cannot block non-Codex setup.
    if (provider !== "codex" && existing.CODEX_WEB_SEARCH_MODE !== undefined) {
        lines.push(`CODEX_WEB_SEARCH_MODE=${existing.CODEX_WEB_SEARCH_MODE}`);
    }
    const progressInterval = await promptVar(rl, "Long-run progress update interval in ms (default 60000)", "AI_PROGRESS_INTERVAL_MS", existing, false);
    if (progressInterval)
        lines.push(`AI_PROGRESS_INTERVAL_MS=${progressInterval}`);
    if (securityMode === "shared")
        mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(ENV_FILE, lines.join("\n") + "\n");
    console.log(`\n✅ Config saved to ${ENV_FILE}`);
    console.log(`✅ Provider set to: ${provider}`);
    const doRegister = await question(rl, "\nRegister Discord slash commands now? [Y/n] ");
    rl.close();
    if (!doRegister.trim() || doRegister.trim().toLowerCase() === "y") {
        console.log("Registering slash commands...");
        process.chdir(CONFIG_DIR);
        await import("../scripts/register-commands.js");
    }
    console.log("\nSetup complete! Next steps:");
    console.log("  ai-assistant start            # start the bot");
    console.log("  ai-assistant install-service  # optional: run as a systemd service");
}
async function start() {
    if (!existsSync(ENV_FILE)) {
        console.error(`❌ Config not found at ${ENV_FILE}\nRun: ai-assistant setup`);
        process.exit(1);
    }
    // chdir so dotenv.config() in index.ts picks up the right .env
    process.chdir(CONFIG_DIR);
    await import("./index.js");
}
async function register() {
    if (!existsSync(ENV_FILE)) {
        console.error(`❌ Config not found at ${ENV_FILE}\nRun: ai-assistant setup`);
        process.exit(1);
    }
    process.chdir(CONFIG_DIR);
    await import("../scripts/register-commands.js");
}
async function installService() {
    const templatePath = resolve(PACKAGE_ROOT, "ai-assistant.service");
    if (!existsSync(templatePath)) {
        console.error(`❌ Service template not found at ${templatePath}`);
        process.exit(1);
    }
    // Prefer SUDO_USER so service runs as the calling user, not as root
    const user = process.env.SUDO_USER ?? process.env.USER ?? "root";
    if (user === "root") {
        console.warn("⚠️  Installing service to run as root. Run as a non-root user or set SUDO_USER.");
    }
    const nodePath = process.execPath;
    const cliPath = resolve(__dirname_local, "cli.js");
    const patched = readFileSync(templatePath, "utf-8")
        .replace(/%%USER%%/g, user)
        .replace(/%%CONFIG_DIR%%/g, CONFIG_DIR)
        .replace(/%%NODE_PATH%%/g, nodePath)
        .replace(/%%CLI_PATH%%/g, cliPath);
    // Write to a unique temp dir (not predictable /tmp path) to avoid TOCTOU before sudo cp
    const tmpDir = mkdtempSync(join(tmpdir(), "ai-assistant-"));
    const tmpPath = join(tmpDir, "ai-assistant.service");
    writeFileSync(tmpPath, patched, { mode: 0o600 });
    console.log("Installing /etc/systemd/system/ai-assistant.service ...");
    const cp = spawnSync("sudo", ["cp", tmpPath, "/etc/systemd/system/ai-assistant.service"], {
        stdio: "inherit",
    });
    rmSync(tmpDir, { recursive: true, force: true });
    if (cp.status !== 0) {
        console.error("❌ Failed to copy service file (sudo cp failed).");
        process.exit(1);
    }
    const reload = spawnSync("sudo", ["systemctl", "daemon-reload"], { stdio: "inherit" });
    if (reload.status !== 0) {
        console.error("❌ systemctl daemon-reload failed.");
        process.exit(1);
    }
    const enable = spawnSync("sudo", ["systemctl", "enable", "ai-assistant"], { stdio: "inherit" });
    if (enable.status !== 0) {
        console.error("❌ systemctl enable failed.");
        process.exit(1);
    }
    console.log("\n✅ Service installed and enabled.");
    console.log("  sudo systemctl start ai-assistant   # start now");
    console.log("  sudo systemctl restart ai-assistant # restart after update");
    console.log("  sudo journalctl -u ai-assistant -f  # view logs");
}
function update() {
    console.log("To update to the latest version:");
    console.log("  npm install -g --install-links github:Rubiss-Projects/ai-assistant");
    console.log("\nTo pin a specific version:");
    console.log("  npm install -g --install-links github:Rubiss-Projects/ai-assistant#v1.0.0");
}
function help() {
    console.log("Usage: ai-assistant <command>\n");
    console.log("Commands:");
    console.log("  setup            Interactive setup wizard — creates ~/.ai-assistant/.env");
    console.log("  start            Start configured network adapters");
    console.log("  cli              Local conversation (--provider fake, --message, --json)");
    console.log("  register         Register Discord slash commands with the Discord API");
    console.log("  install-service  Install and enable as a systemd service");
    console.log("  update           Print update instructions");
    console.log("\nEnvironment:");
    console.log("  AI_ASSISTANT_CONFIG_DIR  Override config directory (default: ~/.ai-assistant)");
}
// ─── Dispatch ──────────────────────────────────────────────────────────────
const cmd = process.argv[2];
switch (cmd) {
    case "cli":
        try {
            if (existsSync(ENV_FILE)) {
                dotenv.config({ path: ENV_FILE, quiet: true });
                process.chdir(CONFIG_DIR);
            }
            await (await import("./adapters/cli/run.js")).runCli();
        }
        catch {
            const error = "CLI failed. Check arguments, local state ownership and provider configuration.";
            console.error(error);
            if (process.argv.slice(3).includes('--json'))
                process.stdout.write(JSON.stringify({ status: 'failed', error }) + '\n');
            process.exitCode = 1;
        }
        break;
    case "setup":
        await setup();
        break;
    case "start":
        await start();
        break;
    case "register":
        await register();
        break;
    case "install-service":
        await installService();
        break;
    case "update":
        update();
        break;
    case "help":
    case "--help":
    case "-h":
        help();
        break;
    default:
        help();
        if (cmd !== undefined)
            process.exit(1);
}
