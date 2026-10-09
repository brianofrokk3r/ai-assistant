import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SCHEDULE_TOOLS } from "./common/scheduleToolDefinitions.js";
const endpoint = process.env.AI_SCHEDULE_BRIDGE_URL, token = process.env.AI_SCHEDULE_BRIDGE_TOKEN;
if (!endpoint || !token)
    throw new Error("Schedule MCP must be started by the host.");
const server = new Server({ name: "ai-assistant-schedules", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: SCHEDULE_TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(request.params), signal: AbortSignal.timeout(115_000) });
        if (!response.ok)
            throw new Error("Schedule bridge is unavailable or this session has expired.");
        return await response.json();
    }
    catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Schedule call failed." }] };
    }
});
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => { void server.close(); });
