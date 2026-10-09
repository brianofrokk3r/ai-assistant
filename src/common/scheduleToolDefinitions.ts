const run = { type: "string", description: "The current run_id from the schedule-tool instructions." };
const id = { type: "string", description: "A host-issued schedule ID." };
const optionalScheduleFields = {
  content: { type: "string", description: "The exact message to post, or the complete task for the AI to perform." },
  cron: { type: "string", description: "A standard five-field cron expression: minute hour day-of-month month day-of-week." },
  timezone: { type: "string", description: "An IANA timezone such as America/New_York. Convert user abbreviations such as EST to the appropriate IANA zone." },
  context_messages: { type: "string", description: "Number of preceding destination messages to give an AI run, from 0 through 100." },
  start_at: { type: "string", description: "Optional ISO-8601 start instant. For edits, use none to clear it." },
  end_at: { type: "string", description: "Optional ISO-8601 exclusive end instant. For edits, use none to clear it." },
  provider: { type: "string", enum: ["copilot", "codex", "opencode"] },
  model: { type: "string" },
  reasoning: { type: "string", description: "Provider reasoning effort. For edits, use none to clear it." },
};

export const SCHEDULE_TOOLS = [
  { name: "create_schedule", description: "Propose a recurring fixed message or AI task in the current platform destination. This does not save anything until the user confirms the returned proposal.", inputSchema: { type: "object" as const, properties: { run_id: run, kind: { type: "string", enum: ["message", "ai"] }, ...optionalScheduleFields }, required: ["run_id", "kind", "content", "cron"], additionalProperties: false } },
  { name: "list_schedules", description: "List schedules the current user can manage in this workspace.", inputSchema: { type: "object" as const, properties: { run_id: run }, required: ["run_id"], additionalProperties: false } },
  { name: "inspect_schedule", description: "Inspect a schedule and its recent runs. Sensitive details are redacted outside its saved destination.", inputSchema: { type: "object" as const, properties: { run_id: run, schedule_id: id }, required: ["run_id", "schedule_id"], additionalProperties: false } },
  { name: "edit_schedule", description: "Propose changes to a schedule. This does not save anything until the user confirms the returned proposal.", inputSchema: { type: "object" as const, properties: { run_id: run, schedule_id: id, ...optionalScheduleFields }, required: ["run_id", "schedule_id"], additionalProperties: false } },
  ...["pause", "resume", "delete"].map(action => ({ name: `${action}_schedule`, description: `${action} a schedule the current user can manage.`, inputSchema: { type: "object" as const, properties: { run_id: run, schedule_id: id }, required: ["run_id", "schedule_id"], additionalProperties: false } })),
  { name: "run_schedule_now", description: "Run a saved schedule immediately.", inputSchema: { type: "object" as const, properties: { run_id: run, schedule_id: id }, required: ["run_id", "schedule_id"], additionalProperties: false } },
  { name: "retry_schedule_delivery", description: "Retry a definitely failed delivery for a saved schedule run.", inputSchema: { type: "object" as const, properties: { run_id: run, schedule_id: id, schedule_run_id: { type: "string" } }, required: ["run_id", "schedule_id", "schedule_run_id"], additionalProperties: false } },
] as const;
