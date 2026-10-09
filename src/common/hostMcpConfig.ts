import { ARTIFACT_TOOLS } from "./artifactToolDefinitions.js";
import { RULESET_TOOLS } from "./rulesetToolDefinitions.js";
import type { ArtifactMcpConfig } from "./artifactToolBridge.js";
import type { RulesetMcpConfig } from "./rulesetToolBridge.js";
import { githubContributionTools } from "./githubContributionToolDefinitions.js";
import type { GitHubContributionMcpConfig } from "./githubContributionToolBridge.js";
import { SCHEDULE_TOOLS } from "./scheduleToolDefinitions.js";
import type { ScheduleMcpConfig } from "./scheduleToolBridge.js";

function localServerToml(
  config: { command: string; args: string[]; env: Record<string, string> },
  tools: readonly { name: string }[],
  timeoutSec: number,
): string {
  const env = Object.entries(config.env).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",");
  const toolConfig = tools.map(({ name }) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(",");
  return `{command=${JSON.stringify(config.command)},args=${JSON.stringify(config.args)},env={${env}},tools={${toolConfig}},startup_timeout_sec=60,tool_timeout_sec=${timeoutSec}}`;
}

export function codexHostMcpOverride(artifacts?: ArtifactMcpConfig, rulesets?: RulesetMcpConfig, github?: GitHubContributionMcpConfig, schedules?: ScheduleMcpConfig): string {
  if (!artifacts && !rulesets && !github && !schedules) return "mcp_servers={}";
  const servers: string[] = [];
  if (artifacts) servers.push(`artifact_tools=${localServerToml(artifacts, ARTIFACT_TOOLS, 960)}`);
  if (rulesets) servers.push(`ruleset_tools=${localServerToml(rulesets, RULESET_TOOLS, 120)}`);
  if (github) servers.push(`github_contributions=${localServerToml(github, githubContributionTools(), 120)}`);
  if (schedules) servers.push(`schedule_tools=${localServerToml(schedules, SCHEDULE_TOOLS, 120)}`);
  return `mcp_servers={${servers.join(",")}}`;
}

export function codexHostMcpOverrides(artifacts?: ArtifactMcpConfig, rulesets?: RulesetMcpConfig, replaceAll = true, github?: GitHubContributionMcpConfig, schedules?: ScheduleMcpConfig): string[] {
  if (replaceAll) return [codexHostMcpOverride(artifacts, rulesets, github, schedules)];
  const overrides: string[] = [];
  if (artifacts) overrides.push(`mcp_servers.artifact_tools=${localServerToml(artifacts, ARTIFACT_TOOLS, 960)}`);
  if (rulesets) overrides.push(`mcp_servers.ruleset_tools=${localServerToml(rulesets, RULESET_TOOLS, 120)}`);
  if (github) overrides.push(`mcp_servers.github_contributions=${localServerToml(github, githubContributionTools(), 120)}`);
  if (schedules) overrides.push(`mcp_servers.schedule_tools=${localServerToml(schedules, SCHEDULE_TOOLS, 120)}`);
  return overrides;
}
