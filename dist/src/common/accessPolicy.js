import fs from "node:fs";
import path from "node:path";
import { configuredWorkspaceRoot, pathIsWithin } from "./providerSecurity.js";
import { configuredUserInstructionMode } from "./userInstructionStore.js";
import { githubContributionAccess } from "./githubContributionConfig.js";
export const CAPABILITIES = [
    "chat.use", "ask.use", "session.configure", "workspace.manage", "mcp.manage", "bot.manage",
    "ruleset.manage", "github.contribute", "github.merge", "github.release", "schedule.message.create", "schedule.ai.create", "schedule.manage.own", "schedule.manage.guild", "schedule.manage.tenant",
];
const PRESETS = {
    member: ["chat.use"],
    contributor: ["chat.use", "github.contribute"],
    scheduler: ["chat.use", "schedule.message.create", "schedule.manage.own"],
    "server-admin": ["chat.use", "ruleset.manage", "schedule.message.create", "schedule.manage.own", "schedule.manage.guild", "schedule.manage.tenant"],
    "bot-admin": [...CAPABILITIES],
};
function ids(value) { return new Set((value ?? "").split(",").map(x => x.trim()).filter(Boolean)); }
export function parseGrants(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some(k => k !== "grants") || !Array.isArray(value.grants)) {
        throw new Error("Rights configuration must contain a grants array.");
    }
    return value.grants.map(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid rights grant.");
        const grant = raw;
        const platform = grant.platform ?? "discord";
        const validId = (id) => id === undefined || (platform === "discord" ? /^\d+$/.test(id) : /^[A-Z0-9][A-Z0-9._-]*$/i.test(id));
        if (Object.keys(grant).some(k => !["userId", "roleId", "guildId", "platform", "tenantId", "roles", "capabilities"].includes(k))
            || Boolean(grant.userId) === Boolean(grant.roleId)
            || ![grant.userId, grant.roleId, grant.guildId, grant.tenantId].every(id => typeof id === "string" ? validId(id) : id === undefined)
            || ![undefined, "discord", "slack"].includes(grant.platform)
            || (grant.roleId && !grant.guildId)
            || (grant.roles !== undefined && (!Array.isArray(grant.roles) || grant.roles.some(r => !Object.hasOwn(PRESETS, r))))
            || (grant.capabilities !== undefined && (!Array.isArray(grant.capabilities) || grant.capabilities.some(c => !CAPABILITIES.includes(c))))) {
            throw new Error("Invalid rights grant: use a user ID or a guild-scoped role ID and known capabilities/presets.");
        }
        if (grant.guildId && (grant.roles?.includes("bot-admin") || grant.capabilities?.includes("bot.manage"))) {
            throw new Error("Bot administration can only be granted globally to individual users.");
        }
        if (grant.platform === "slack" && grant.roleId)
            throw new Error("Slack schedule grants must target users, not Discord roles.");
        return grant;
    });
}
export function createAccessPolicy(env = process.env) {
    const contributionAccess = githubContributionAccess(env);
    const allowed = ids(env.DISCORD_ALLOWED_USERS);
    const admins = ids(env.DISCORD_ADMIN_USERS);
    const slackAdmins = ids(env.SLACK_ADMIN_USERS);
    const rightsFile = env.SCHEDULE_RIGHTS_FILE?.trim() || env.SLACK_RIGHTS_FILE?.trim() || env.DISCORD_RIGHTS_FILE?.trim();
    const workspace = configuredWorkspaceRoot(env);
    if (rightsFile && workspace) {
        const relative = path.relative(path.resolve(workspace), path.resolve(rightsFile));
        const lexicallyInside = relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
        if (lexicallyInside || pathIsWithin(workspace, rightsFile)) {
            throw new Error("DISCORD_RIGHTS_FILE must be outside the provider workspace root, including symlink targets.");
        }
    }
    // Validate eagerly for clear startup failures, then reload for each decision so
    // revocation is observable without restarting a scheduler worker.
    const initialGrants = rightsFile ? parseGrants(JSON.parse(fs.readFileSync(rightsFile, "utf8"))) : [];
    const currentGrants = () => rightsFile ? parseGrants(JSON.parse(fs.readFileSync(rightsFile, "utf8"))) : initialGrants;
    const matches = (g, s) => (g.userId === s.userId || Boolean(g.roleId && s.roleIds?.includes(g.roleId)))
        && (g.platform ?? "discord") === (s.platform ?? "discord")
        && (!g.guildId || g.guildId === s.guildId) && (!g.tenantId || g.tenantId === (s.tenantId ?? s.guildId));
    const explicitAdmin = (s) => ((s.platform ?? "discord") === "slack" ? slackAdmins.has(s.userId) : admins.has(s.userId)) || currentGrants().some(g => !g.guildId && !g.tenantId && matches(g, s)
        && g.roles?.includes("bot-admin"));
    const granted = (s, capability) => currentGrants().some(g => matches(g, s)
        && (g.capabilities?.includes(capability) || g.roles?.some(role => PRESETS[role].includes(capability))));
    const legacyMessage = (userId) => allowed.size === 0 || allowed.has(userId);
    const legacyAdmin = (userId) => admins.size > 0 ? admins.has(userId) : legacyMessage(userId);
    return {
        isExplicitAdmin: explicitAdmin,
        // Retained for existing context-author filters and compatibility callers.
        canMessage: (userId, subject = { userId }) => legacyMessage(userId) || granted(subject, "chat.use"),
        canUseAdminCommands: (userId) => legacyAdmin(userId) || explicitAdmin({ userId }),
        can(s, capability, resource = {}) {
            if (!CAPABILITIES.includes(capability))
                return false;
            if (resource.guildId && resource.guildId !== (s.guildId ?? s.tenantId))
                return false;
            if (resource.destination && (resource.destination.platform !== (s.platform ?? "discord") || resource.destination.tenantId !== (s.tenantId ?? s.guildId)))
                return false;
            if (capability === "schedule.manage.own" && resource.ownerId && resource.ownerId !== s.userId)
                return false;
            // Private one-shot requests require an explicit grant, never the legacy open-admin fallback.
            if (capability === "ask.use")
                return explicitAdmin(s) || granted(s, capability);
            if (capability === "github.contribute")
                return explicitAdmin(s) || granted(s, capability)
                    || (contributionAccess === "chat" && (legacyMessage(s.userId) || legacyAdmin(s.userId) || granted(s, "chat.use")));
            // Privileged GitHub actions never inherit the legacy open-admin fallback.
            if (capability === "github.merge" || capability === "github.release")
                return Boolean(s.guildId) && (explicitAdmin(s) || granted(s, capability));
            if (capability.startsWith("schedule.")) {
                if (!(s.guildId ?? s.tenantId))
                    return false;
                // Legacy open-admin fallback never grants unattended execution.
                return explicitAdmin(s) || granted(s, capability);
            }
            if (explicitAdmin(s) || granted(s, capability))
                return true;
            return capability === "chat.use" ? legacyMessage(s.userId) || legacyAdmin(s.userId) : legacyAdmin(s.userId);
        },
    };
}
/** Linking and reading cards are available to contributors and explicitly granted maintainers. */
export function canUseGitHubActions(access, subject) {
    return access.can(subject, "github.contribute") || access.can(subject, "github.merge") || access.can(subject, "github.release");
}
export function slashCommandCapability({ commandName: command, subcommand: sub, hasWorkspace }) {
    if (command === "github" && ["link", "status", "ready"].includes(sub ?? ""))
        return "github.contribute";
    if (command === "github" && sub === "unlink")
        return "chat.use";
    if (["ask", "chat"].includes(command) && !sub)
        return hasWorkspace ? "workspace.manage" : "chat.use";
    if (["reset", "history", "compact"].includes(command) && !sub)
        return "chat.use";
    if (["servers", "leave", "status", "fleet"].includes(command) && !sub)
        return "bot.manage";
    const read = {
        model: ["list", "current"], reasoning: ["list", "current"], provider: ["list", "current"],
        agent: ["list", "current"], mode: ["get"], plan: ["read", "update", "delete"],
    };
    if (sub && read[command]?.includes(sub))
        return "chat.use";
    if ((["model", "reasoning", "provider", "mode"].includes(command) && sub === "set")
        || (command === "agent" && ["select", "deselect"].includes(sub ?? "")))
        return "session.configure";
    if (command === "workspace" && ["list", "read", "create"].includes(sub ?? ""))
        return "workspace.manage";
    if (command === "mcp" && ["list", "enable", "disable", "workspace"].includes(sub ?? ""))
        return "mcp.manage";
    if (command === "ruleset" && ["get", "list", "set", "append", "delete", "clear", "enable", "disable", "preview"].includes(sub ?? ""))
        return "ruleset.manage";
    return undefined;
}
export function slashCommandRequiresAdmin(request) {
    return slashCommandCapability(request) !== "chat.use";
}
export function canInvokeSlashCommand(access, userId, request, subject = { userId }) {
    if (request.commandName === "github" && ["link", "status"].includes(request.subcommand ?? ""))
        return canUseGitHubActions(access, subject);
    if (request.commandName === "ruleset") {
        if (configuredUserInstructionMode() === "off")
            return false;
        return access.can(subject, "ruleset.manage") || access.can(subject, "chat.use");
    }
    const capability = slashCommandCapability(request);
    // Preserve legacy unknown-command classification; the dispatcher never executes unmapped commands.
    return capability ? access.can(subject, capability) : access.canUseAdminCommands(userId);
}
