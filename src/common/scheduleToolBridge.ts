import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SendMessageOptions } from "../providers/types.js";
import { SCHEDULE_TOOLS } from "./scheduleToolDefinitions.js";
import { ScheduleTools, createScheduleToolRun } from "./scheduleTools.js";

export interface ScheduleMcpConfig { command: string; args: string[]; env: Record<string, string> }
class ScheduleConnection {
  private readonly token = randomBytes(32).toString("hex");
  private readonly runs = new Map<string, ScheduleTools>();
  private readonly server: Server;
  readonly ready: Promise<ScheduleMcpConfig>;
  constructor() {
    this.server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/call" || request.headers.authorization !== `Bearer ${this.token}`) { response.writeHead(403).end(); return; }
      try {
        let body = "";
        for await (const chunk of request) { body += chunk.toString(); if (body.length > 64_000) { response.writeHead(413).end(); request.destroy(); return; } }
        const call = JSON.parse(body) as { name: string; arguments: Record<string, unknown> };
        const run = this.runs.get(String(call.arguments?.run_id));
        if (!run) throw new Error("Schedule run is inactive or belongs to another session.");
        const result = await run.call(call.name, call.arguments);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }));
      } catch (error) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Schedule operation failed." }] }));
      }
    });
    this.server.requestTimeout = 125_000; this.server.headersTimeout = 10_000;
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.unref(); const address = this.server.address();
        if (!address || typeof address === "string") { reject(new Error("Could not start schedule bridge.")); return; }
        const development = import.meta.url.endsWith(".ts");
        const script = fileURLToPath(new URL(`../scheduleMcp.${development ? "ts" : "js"}`, import.meta.url));
        const args = development ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, script] : [script];
        resolve({ command: process.execPath, args, env: { AI_SCHEDULE_BRIDGE_URL: `http://127.0.0.1:${address.port}/call`, AI_SCHEDULE_BRIDGE_TOKEN: this.token } });
      });
    });
  }
  async run<T>(runtime: ScheduleTools, action: (runtime: ScheduleTools) => Promise<T>): Promise<T> {
    await this.ready; this.runs.set(runtime.id, runtime);
    try { return await action(runtime); } finally { this.runs.delete(runtime.id); await runtime.cancel(); }
  }
  async close(): Promise<void> { await Promise.all([...this.runs.values()].map(run => run.close())); this.runs.clear(); this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
export class ScheduleToolSessions {
  private readonly connections = new Map<string, ScheduleConnection>();
  private connection(key: string): ScheduleConnection { let value = this.connections.get(key); if (!value) { value = new ScheduleConnection(); this.connections.set(key, value); } return value; }
  config(key: string): Promise<ScheduleMcpConfig> { return this.connection(key).ready; }
  async run<T>(key: string, options: SendMessageOptions | undefined, action: (runtime?: ScheduleTools) => Promise<T>): Promise<T> {
    if (!options?.scheduleContext) return action();
    return this.connection(key).run(new ScheduleTools(createScheduleToolRun(), options.scheduleContext), action);
  }
  async reset(key: string): Promise<void> { const connection = this.connections.get(key); this.connections.delete(key); await connection?.close(); }
  async shutdown(): Promise<void> { await Promise.all([...this.connections.keys()].map(key => this.reset(key))); }
}

export const SCHEDULE_INSTRUCTIONS = "The host exposes schedule_tools for natural-language schedule requests. Use them whenever the user asks to create, list, inspect, edit, pause, resume, delete, run, or retry a schedule. Interpret ordinary language into tool fields yourself: use a five-field cron and an IANA timezone (for example, EST/EDT or ET means America/New_York). Ask a concise clarification only when a required detail is genuinely ambiguous. The host binds the requester and current destination; never ask for or invent identity fields. Create and edit return a proposal, not a saved change: reproduce its summary and exact confirmation command, and never claim persistence before the user confirms it.";
export function scheduleToolPrompt(prompt: string, runtime?: ScheduleTools): string { return runtime ? `${prompt}\n\n<schedule-tools>Current run_id: ${JSON.stringify(runtime.id)}</schedule-tools>` : prompt; }

export function scheduleMcpServerToml(config: ScheduleMcpConfig): string {
  const env = Object.entries(config.env).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",");
  const tools = SCHEDULE_TOOLS.map(({ name }) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(",");
  return `{command=${JSON.stringify(config.command)},args=${JSON.stringify(config.args)},env={${env}},tools={${tools}},startup_timeout_sec=60,tool_timeout_sec=120}`;
}
