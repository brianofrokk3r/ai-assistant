import { ARTIFACT_TOOLS } from "./artifactToolDefinitions.js";
import { RULESET_TOOLS } from "./rulesetToolDefinitions.js";
import { githubContributionTools } from "./githubContributionToolDefinitions.js";
import { SCHEDULE_TOOLS } from "./scheduleToolDefinitions.js";
function localServerToml(config, tools, timeoutSec) {
    const env = Object.entries(config.env).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",");
    const toolConfig = tools.map(({ name }) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(",");
    return `{command=${JSON.stringify(config.command)},args=${JSON.stringify(config.args)},env={${env}},tools={${toolConfig}},startup_timeout_sec=60,tool_timeout_sec=${timeoutSec}}`;
}
export function codexHostMcpOverride(artifacts, rulesets, github, schedules) {
    if (!artifacts && !rulesets && !github && !schedules)
        return "mcp_servers={}";
    const servers = [];
    if (artifacts)
        servers.push(`artifact_tools=${localServerToml(artifacts, ARTIFACT_TOOLS, 960)}`);
    if (rulesets)
        servers.push(`ruleset_tools=${localServerToml(rulesets, RULESET_TOOLS, 120)}`);
    if (github)
        servers.push(`github_contributions=${localServerToml(github, githubContributionTools(), 120)}`);
    if (schedules)
        servers.push(`schedule_tools=${localServerToml(schedules, SCHEDULE_TOOLS, 120)}`);
    return `mcp_servers={${servers.join(",")}}`;
}
export function codexHostMcpOverrides(artifacts, rulesets, replaceAll = true, github, schedules) {
    if (replaceAll)
        return [codexHostMcpOverride(artifacts, rulesets, github, schedules)];
    const overrides = [];
    if (artifacts)
        overrides.push(`mcp_servers.artifact_tools=${localServerToml(artifacts, ARTIFACT_TOOLS, 960)}`);
    if (rulesets)
        overrides.push(`mcp_servers.ruleset_tools=${localServerToml(rulesets, RULESET_TOOLS, 120)}`);
    if (github)
        overrides.push(`mcp_servers.github_contributions=${localServerToml(github, githubContributionTools(), 120)}`);
    if (schedules)
        overrides.push(`mcp_servers.schedule_tools=${localServerToml(schedules, SCHEDULE_TOOLS, 120)}`);
    return overrides;
}
