# AI Assistant

An assistant with Discord, opt-in [Slack](#slack-adapter), and CLI adapters for **GitHub Copilot**, **OpenAI Codex**, and **OpenCode**. Choose a default provider, then chat through your configured adapter. Discord supports mentions, DMs and dedicated conversation threads, with provider switching during a conversation.

- Persistent conversations, isolated by user/channel or chat thread.
- Images, video, audio, text/code attachments, and downloadable files created by the agent.
- Discord history search and long-term server memory through natural requests.
- Model and reasoning controls, plus provider-specific tools and slash commands.
- User and admin access lists, scoped workspaces, and a Docker deployment for shared servers.

## Contents

- [Getting started](#getting-started)
- [Slack adapter](#slack-adapter)
- [Using the bot](#using-the-bot)
- [Scheduled tasks and named rights](#scheduled-tasks-and-named-rights)
- [Environment variable reference](#environment-variable-reference)
- [Access and security](#access-and-security)
- [Managing your installation](#managing-your-installation)
- [Development](#development)

## Getting started

For Slack, follow [Slack adapter setup](#slack-adapter). For Discord, first configure Discord and choose a provider. Then follow **one** installation path: [global npm install](#global-npm-install), [Docker](#docker), or [run from source](#run-from-source).

### 1. Configure Discord

1. Create an application with a bot user in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, enable **Message Content Intent** and copy the bot token (`DISCORD_TOKEN`). Under **General Information**, copy the Application ID (`DISCORD_APP_ID`).
3. In Discord, enable **Settings → Advanced → Developer Mode**. Right-click your server to copy its ID (`DISCORD_GUILD_ID`). You can copy channel and user IDs the same way.
4. In the Developer Portal, open **OAuth2 → URL Generator** and select the `bot` and `applications.commands` scopes. Select **View Channels**, **Send Messages**, **Send Messages in Threads**, **Create Public Threads**, **Read Message History**, **Attach Files**, and **Use Slash Commands**. Open the generated URL to invite the bot.

Slash commands are registered to the server named by `DISCORD_GUILD_ID`. All three Discord variables are required for registration.

Decide who can use the bot before starting it: when `DISCORD_ALLOWED_USERS` and `DISCORD_ADMIN_USERS` are both empty, everyone who can reach it can use public and administrative commands. See [Access and security](#access-and-security) for the permission rules.

### 2. Choose and authenticate a provider

Set `PROVIDER` to one of the following. Authenticate each provider you want to use, under the same operating-system user that runs the bot.

| `AI_ASSISTANT_ADAPTER` | `discord`; accepts `discord`, `slack` | Selects one network adapter per process. Local CLI conversations use `ai-assistant cli` instead. |
| `AI_ASSISTANT_STATE_DIR` | `~/.config/ai-assistant/adapters` | Persistent adapter journals, Slack context and Slack/CLI provider state. Use an absolute host-owned path outside the provider workspace. One worker per adapter/state directory. Does not relocate Discord's legacy provider stores. |
| `PROVIDER` | Backend | Authentication | Default model in this repo |
| --- | --- | --- | --- |
| `copilot` | GitHub Copilot SDK | `COPILOT_GITHUB_TOKEN` (preferred), `GH_TOKEN`, or a persisted CLI login with Copilot access | `claude-haiku-4.5` |
| `codex` | OpenAI Codex SDK | `OPENAI_API_KEY` or a persisted `codex login` | `gpt-5.6-sol` |
| `opencode` | OpenCode CLI | `opencode auth login` or the selected model provider's API key | OpenCode's configured default |

For native installs, OpenCode requires its CLI to be installed and discoverable (or set `OPENCODE_BIN`). Docker includes all three provider CLIs; [container login commands](#docker) are below.

Native video conversion also requires `ffmpeg` and `ffprobe` on `PATH`, with the `libsvtav1`, `libx264`, and `libx265` encoders. These are included in the Docker image.

### 3. Install and start

#### Global npm install

Requires Node.js 22.14+ and authentication for your chosen provider. Native dependency installation may also require Python and a C++ build toolchain (`python3 make g++` on Debian/Ubuntu, or Visual Studio's Desktop development with C++ workload on Windows).

```bash
npm install -g --install-links github:Rubiss-Projects/ai-assistant
ai-assistant setup
ai-assistant start
```

The setup wizard writes `~/.ai-assistant/.env` and offers to register slash commands. Accept that step, or run `ai-assistant register` before starting. Add advanced settings directly to that file using the [environment reference](#environment-variable-reference).

For later configuration changes, edit `.env` directly. Rerunning `ai-assistant setup` rewrites it and removes settings outside the wizard's prompts, including provider tokens, attachment mode, and file limits. If you rerun setup, back up the file and restore those entries before restarting.

For automatic startup on Linux or WSL with systemd, see [Run as a service](#run-as-a-service).

#### Docker

Requires Docker with Compose. Clone the repo to get the Compose file and configuration template:

```bash
git clone https://github.com/Rubiss-Projects/ai-assistant.git
cd ai-assistant
cp .env.example .env
```

Edit `.env`: fill in the Discord credentials, set `PROVIDER`, and configure access lists and provider authentication. For example, a Codex deployment using an API key needs these values alongside the template's other settings:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_APP_ID=your_application_id
DISCORD_GUILD_ID=your_server_id
PROVIDER=codex
OPENAI_API_KEY=your_api_key
AI_ASSISTANT_SECURITY_MODE=shared
DISCORD_ATTACHMENT_MODE=text
```

Pull the image, then start the bot:

```bash
docker compose pull
docker compose up -d
docker compose logs -f assistant
```

If you use CLI login instead of a token or API key, run the matching command after pulling the image and before starting the bot:

```bash
docker compose run --rm assistant copilot login
docker compose run --rm assistant codex login
docker compose run --rm assistant opencode auth login
```

For the Discord adapter, the entrypoint registers the current slash commands on each container start unless `REGISTER_COMMANDS_ON_START=false`. Slack always skips Discord registration, regardless of that flag. The included Compose file uses `${REGISTER_COMMANDS_ON_START:-true}`: a value supplied through Compose interpolation (for example, the project `.env` or `--env-file`) overrides the default. A separate service `env_file` does not override an explicit `environment` value. Releases publish `ghcr.io/rubiss-projects/ai-assistant:<version>`; the included Compose file uses `latest`.

Compose loads the project's host-side `.env` and passes its tokens and API keys into the container environment. Persisted CLI logins, session state, and retained agent files live in the Docker-managed `assistant-data` volume; provider workspaces are under `/data/workspaces`. The container runs as an unprivileged user with a read-only image filesystem, dropped Linux capabilities, and no host bind mounts. See [Container isolation](#container-isolation) for the boundary this provides.

#### Run from source

Requires Node.js 22.14+ and authentication for your chosen provider. Install Python and a C++ build toolchain before running `npm ci` (`python3 make g++` on Debian/Ubuntu, or Visual Studio's Desktop development with C++ workload on Windows).

```bash
git clone https://github.com/Rubiss-Projects/ai-assistant.git
cd ai-assistant
npm install
cp .env.example .env
```

Fill in the Discord and provider settings in the repository's `.env`, then register commands and start:

```bash
npm run register
npm start
```

## Slack adapter

Slack is opt-in: set `AI_ASSISTANT_ADAPTER=slack` to run one Slack Socket Mode connection instead of Discord. Discord remains the default. Run separate processes to use both platforms; do not run two Slack workers against the same state directory. Slack uses the selected `PROVIDER` and its existing authentication, and requires `AI_ASSISTANT_SECURITY_MODE=shared`.

### Create and install the Slack app

1. Create an app for your workspace at [Slack's app dashboard](https://api.slack.com/apps). Enable [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/); this uses an outbound WebSocket and does not require a public event-request URL.
2. Generate an app-level token with `connections:write` and save it as `SLACK_APP_TOKEN` (`xapp-…`). It opens the [Socket Mode connection](https://docs.slack.dev/reference/methods/apps.connections.open/); it is not the bot/history token.
3. Under **OAuth & Permissions**, add the bot scopes below. Under **Event Subscriptions**, enable events and subscribe to the bot events [`app_mention`](https://docs.slack.dev/reference/events/app_mention/) and `message.im`. Install the app into the workspace (reinstall after changing scopes) and save its bot token as `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Invite the bot to each permitted channel. Copy the workspace, channel and member IDs into the environment settings below. Use IDs, not display names or `#channel` names. Both the requester and bot must be current channel members.

| Bot scope | Used for |
| --- | --- |
| `app_mentions:read` | Receiving explicit mentions. |
| `files:read` | Authenticated downloads of files attached to a mention; reinstall the app after adding this scope. |
| `files:write` | Uploads provider-generated response files; reinstall the app after adding this scope. |
| `chat:write` | [Posting responses](https://docs.slack.dev/reference/methods/chat.postMessage/) in the originating channel or parent thread. |
| `channels:read` | Public-channel metadata and [membership checks](https://docs.slack.dev/reference/methods/conversations.members/). |
| `channels:history` | Public-channel history and replies, subject to token access. |
| `groups:read`, `groups:history` | Add these when supporting private channels; invite the bot there too. |
| `im:read`, `im:history` | One-to-one DM metadata, events, and history. |

History uses `SLACK_BOT_TOKEN` unless `SLACK_HISTORY_TOKEN` is configured. The history credential must belong to the same workspace and have access to the permitted channels, including the appropriate `channels:history` / `groups:history` scopes. Verify both [channel history](https://docs.slack.dev/reference/methods/conversations.history/) and [thread replies](https://docs.slack.dev/reference/methods/conversations.replies/) for your token type and installation. If your bot token cannot retrieve channel threads, configure an appropriately scoped user OAuth token as `SLACK_HISTORY_TOKEN`. Receiving mentions does not establish history access. Keep all tokens in host configuration outside the provider workspace.

### Configure and start Slack

Use a checkout or installed version containing the adapter; while this feature is in a draft PR, the published `latest` image and default branch may not contain it. Copy the repository's `.env.example` and edit these values along with your provider credentials:

```dotenv
AI_ASSISTANT_ADAPTER=slack
AI_ASSISTANT_SECURITY_MODE=shared
PROVIDER=copilot
SLACK_APP_TOKEN=xapp-replace-me
SLACK_BOT_TOKEN=xoxb-replace-me
SLACK_TEAM_ID=T0123456789
SLACK_ALLOWED_CHANNELS=C0123456789
SLACK_ALLOWED_USERS=U0123456789,U9876543210
SLACK_INSTALLATION_ID=default
# Optional when a separate authorized history credential is needed:
# SLACK_HISTORY_TOKEN=xoxp-replace-me
# Optional: history authors to exclude; no spaces around commas:
# SLACK_EXCLUDED_CONTEXT_USERS=U1111111111,U2222222222
# Docker only: skip Discord command registration.
REGISTER_COMMANDS_ON_START=false
```

Slack does not require `DISCORD_TOKEN`, `DISCORD_APP_ID` or `DISCORD_GUILD_ID`; leave them unset for a Slack-only process. The Discord setup wizard and `register` command are not Slack setup steps.

- **Source checkout:** place `.env` in the repository, install dependencies with `npm ci`, then run `npm start`. Do not run `npm run register`.
- **Installed CLI:** manually create `~/.ai-assistant/.env` with the Slack/provider settings, then run `ai-assistant start`. Set `AI_ASSISTANT_CONFIG_DIR` in the launching environment to use a different configuration directory.
- **Docker Compose:** edit the `.env` beside `compose.yaml`, including `AI_ASSISTANT_ADAPTER=slack`, and use an image containing the adapter. To build from the checked-out adapter revision, run `docker compose up -d --build`; view startup errors with `docker compose logs -f assistant`. Apply later environment changes with `docker compose up -d`.

Set `AI_ASSISTANT_WORKSPACE_ROOT` to the directory providers may access. The default adapter state directory is `~/.config/ai-assistant/adapters`; an `AI_ASSISTANT_STATE_DIR` override must be an absolute, persistent host-owned path outside that workspace. For example, Docker can use `/data/adapter-state` beside its `/data/workspaces` workspace. Native installs should use separate sibling directories for workspace and state. Shared mode rejects provider state placed inside its allowed workspace.

### Slack conversations and history

Mention the app in an allowed channel to start a turn, or message it from an allowlisted user's one-to-one DM. A top-level mention uses that channel's shared session and posts its response directly to the channel without creating a thread. Mentioning the app in an existing thread uses the parent thread's shared session and keeps the response in that thread. Direct messages use individual sessions. Sessions are isolated by platform, workspace, installation, channel, conversation kind, optional parent thread, and DM user.

Plain messages and unmentioned follow-ups do not trigger replies, but authorized history retrieval can include them on a later mention. `SLACK_ALLOWED_USERS` controls who may trigger turns; it does **not** exclude other channel members' messages from context. Use `SLACK_EXCLUDED_CONTEXT_USERS` to exclude history authors. This does not block their explicit requests if they remain in the allowed-user list.

Automatic context is bounded to 50 messages and 8,000 serialized characters. Explicit summary/history requests support the last N messages, the last N minutes/hours/days, after a same-channel Slack message link, or since the requester's actual previous message. Specify channel or thread scope in the request; summaries remain bounded and disclose partial/unavailable coverage. Recent long-thread retrieval preserves the root separately and searches recent windows. History failures and rate limits do not imply an empty conversation.

Every turn is classified before its context reaches the model, using the same typed Jev choice vocabulary Discord participation uses (`direct_reply`, `unsolicited_reply`, `direct_react`, `react`, `ignore`). The host derives the classification from the conversation form, not from message text and not from a provider call: Slack channel mentions, threaded mentions and direct-message forms classify as `direct_reply`, because only an explicit request to the assistant starts a Slack turn. The classification is part of the transport session context, so the model is told which conversation form it is answering and a new form rotates the retained session policy. Unsupported or ambiguous conversation forms (an unknown platform or form, or a thread without its thread identity) are rejected explicitly and never fall back to an untyped value; replayed output whose conversation no longer has a classifiable form is skipped at startup rather than posted to the wrong destination.

For a smoke check, mention the app at the channel level, add an unmentioned channel detail, then mention it again asking about that detail and confirm the response remains top-level. Separately mention it in an existing thread, add an unmentioned thread detail, and mention it again to confirm the response stays under the parent timestamp. Request a thread summary and verify source links and coverage. Confirm an unallowed user or channel does not start a turn. These checks exercise real Slack/provider access; the automated suite uses fixtures.

One-to-one DMs from `SLACK_ALLOWED_USERS` are supported without an app mention. Replies inside DM threads are unsupported; send a top-level DM instead. Group DMs, externally shared and organization-shared channels are rejected. Slack supports incoming files in admitted DMs and explicit mentions in channels and thread replies, provider-generated response files, text replies and history; progress UI, persistent memory, scheduling, proactive participation and Discord slash-command parity are not implemented. Discord participation and rights settings do not configure Slack; use the Slack allowlists.

Files attached to the current explicit mention (images, Markdown, CSV, PDF, DOCX, XLSX and other native files) are downloaded with the bot token after channel access checks and supplied as local provider inputs alongside the text. Incoming files use native mode independently of `DISCORD_ATTACHMENT_MODE`, with the shared five-file and `AI_INPUT_ATTACHMENT_MAX_BYTES` limits (and a 30-second download deadline per file). Download failures and limits appear in the response; private file URLs and tokens are never passed to the provider. Only Slack-hosted private downloads are accepted; external integrations need to be uploaded to Slack first. Files from historical messages are not downloaded. Provider/tool support determines which document formats can be interpreted.

Provider-generated files use Slack's external upload flow after text delivery: each validated non-empty artifact is re-sanitized, uploaded as its exact bytes to a first-party signed `files.slack.com/upload/v1/` URL without a bot token, then completed as one group in the same channel or parent thread. Slack limits and workspace upload policy still apply; configure `AI_OUTPUT_ATTACHMENT_MAX_BYTES` to bound individual artifacts. File-only responses do not send a placeholder message. A transfer, ticket, completion, cancellation, or rate-limit failure after delivery starts is retained as an interrupted delivery and is never regenerated or blindly retried.

### Slack operations and troubleshooting

- **No replies:** check Socket Mode, `app_mention` subscription, token/workspace match, both allowlists, channel membership and host logs. Private channels need the corresponding scopes and invitations. Shared/external channels are unsupported.
- **Attachment download failed:** add `files:read` to the bot token, reinstall the app, and confirm it can access the uploaded file. The history token is not used for file downloads. Check the per-file size limit and the warning returned in the thread.
- **Attachment upload failed:** add `files:write` to the bot token and reinstall the app. Check Slack workspace file-size/type limits and reconcile the interrupted turn instead of retrying it blindly.
- **History unavailable:** check the history credential's access and scopes for both history APIs. Slack rate limits vary by app distribution; this adapter bounds retrieval and reports failure rather than guaranteeing a complete transcript.
- **State ownership error:** one worker per adapter journal is enforced by an exclusive SQLite transaction in `owner.sqlite`. The OS releases ownership after process termination or a host crash, and the next worker automatically recovers its `owner.lock` marker. Never delete `owner.sqlite` or an active worker's marker. An old release's marker has no crash-safe ownership protocol: stop all workers and archive only that legacy `owner.lock` before upgrading if it survived a crash. A clean shutdown needs no migration. Keep the journal on local storage with working filesystem locks; network filesystems and multiple hosts sharing state are unsupported.
- Persist `slack-turns`, `slack-context` and `slack-provider-state` under `AI_ASSISTANT_STATE_DIR` across restarts. Keep `SLACK_INSTALLATION_ID` stable. SIGINT/SIGTERM drain the adapter, but an active provider may take until completion or its timeout to stop.
- Membership, provider/session identity and excluded-author policy changes, or unavailable history, invalidate retained context. Edit/deletion detection is limited to fetched history windows. Context metadata is compacted at 4,000 aggregate entries with a provider-session reset before the next request. Each Slack installation admits at most 1,000 persisted sessions; capacity rejects new threads before provider state is created while existing threads remain usable. To reclaim capacity, stop the adapter and reconcile inactive context files together with their provider mappings; no automatic history eviction is performed. Slack replays generated replies at startup with current access/audience checks. Unavailable authorization checks retain that output for a later startup or source retry; confirmed audience changes deny delivery. Interrupted or uncertain deliveries need operator reconciliation; they are not automatically regenerated. Successfully delivered response payloads are removed immediately. Terminal turn records, including interrupted deliveries, expire after seven days; each journal is capped at 10,000 records and rejects new turns when full. Reconcile uncertain deliveries within that retention window. Retryable generated records remain until delivery or reconciliation and count toward the cap.

See the [adapter specification and validation status](docs/adapter-refactor-spec.md) for recovery details and validation scope.

## Using the bot

### Conversations and sessions

Use `/chat <message>` for an ongoing conversation. In unrestricted mode, `/ask <prompt>` also provides a private, one-shot answer. Shared mode ignores incoming DMs for everyone. Explicit bot admins and users or server roles granted `ask.use` can use `/ask` in a server to receive a one-shot DM answer; other users should use server channels.

| Where you use `/chat` | What happens |
| --- | --- |
| Server channel | Creates a public thread named `{Provider}: {your message}`, with its own conversation. |
| Existing thread | Continues that thread's conversation. |
| DM | Unrestricted mode only: responds inline in your persistent DM session, if the command is available in DMs. |

You can also mention the bot in a visible channel, or send a message without a mention in a channel listed in `DISCORD_FREE_CHANNELS`. Bot-owned chat threads can respond without a mention, using the participation policy below. Ordinary channel conversations are isolated by user and channel; a bot-owned thread shares one session among its participants.

In shared mode, bot-owned `/chat` threads default to **smart participation**: the bot chooses whether to reply, add one reaction, or stay silent. It favors silence during human-to-human conversation and acknowledgments. Short follow-ups such as “why?” remain eligible. Explicit `@bot` mentions and `/chat` always request an answer. Reply notifications alone are not treated as explicit mentions.

Ordinary messages are grouped after two seconds of quiet (up to eight seconds before starting a decision). Each thread runs one decision or response at a time. New messages invalidate unfinished decisions, and a 20-second cooldown limits unsolicited replies and reactions. Explicit requests to react, including requests for a different emoji, bypass reaction cooldown. Skipped messages remain available through recent Discord history, with author and reply metadata and the existing access filters. History is bounded to 50 messages / 24,000 content characters; it is not a permanent transcript. Reactions need Discord's Add Reactions permission; a failed reaction does not generate a text reply. Classification failures stay silent, while explicit requests continue to work.

Set `CHAT_PARTICIPATION_MODE=always` to answer every message or `mentions-only` to require an explicit mention or slash command. Unrestricted/dedicated deployments default to `always`. These settings affect bot-owned threads; ordinary mentions and `DISCORD_FREE_CHANNELS` retain their behavior. Restart after changing configuration.

The default evaluator uses the thread's active provider and existing login in a separate classification session. It prefers Luna, independently of the main chat model, and can be changed with `CHAT_PARTICIPATION_MODEL` to a model your account supports. Copilot disables tools and configuration discovery. Codex uses an ephemeral, isolated, read-only run with shell, web search, MCP, apps, hooks and plugins disabled. OpenCode selects a small model on the configured connection (preferring Luna, then Haiku or GPT-4.1 Mini, then the configured model) and uses an isolated pure run with tools and permissions denied. Its temporary session database is deleted afterward. No artifact tools are attached to classification runs. Provider startup overhead still contributes to latency.

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is an optional decision evaluator, not a replacement for the model writing answers. Its [typed Choice API](https://docs.typesafe.ai/primitives/choice) supplies a probability for each action. To use it, put this in your gitignored `.env`:

```dotenv
CHAT_PARTICIPATION_EVALUATOR=jev
TYPESAFE_API_KEY=your_typesafe_key
# Optional; otherwise defaults to jev-latest:
# CHAT_PARTICIPATION_MODEL=jev-latest
```

Only Jev needs a TypeSafe key. The key stays with the host evaluator; shared provider environments do not receive it. Selecting Jev sends the bounded, permission-filtered conversation excerpt to TypeSafe. Jev asks separate action and speculative emoji Choice questions together: `ignore`, `direct_reply`, `unsolicited_reply`, `direct_react`, or `react` compete for participation, while emoji compete only with other emoji. Only the selected reaction consumes its emoji answers. A separate scope Choice identifies requests for custom-only, Unicode-only, or either; the host picks the highest-probability emoji within that permitted group. If that group has no available emoji, it stays silent. Reported probabilities determine winners even when the API-selected label differs. Large message bursts with large emoji catalogs are split into bounded requests under one evaluation timeout, retaining all candidates. A winning `direct_reply` bypasses unsolicited-reply cooldown, and `direct_react` bypasses reaction cooldown. The former `CHAT_PARTICIPATION_JEV_THRESHOLD` setting is ignored and can be removed. Malformed required distributions are reported as evaluation failures and produce no Discord activity; there is no automatic fallback to a different service.

Reactions can use the current server’s custom emoji, discovered automatically from Discord alongside Unicode defaults. Choices are labeled as custom or Unicode so generic requests such as “pick a custom emoji” can select a server emoji without naming it. The catalog follows emoji updates and excludes unavailable or role-restricted emoji the bot cannot use; availability is checked again before reacting. No server emoji names or IDs need configuration. Jev chooses using emoji names and conversation context, not the artwork, so descriptive names help. The same catalog is available to provider-based participation evaluators.

Run `npx tsx scripts/evaluate-participation.ts jev` for a live check against synthetic multi-user conversations, or replace `jev` with `codex`, `copilot`, or `opencode` to test an existing provider login. This uses real inference, checks target message, direct/unsolicited status, selected emoji and cooldown behavior, reports observed latency, and never connects to Discord. The small fixture set is a smoke test, not a general accuracy benchmark.


Mentions and free-channel messages include nearby conversation. A reply mentioning the bot also includes the referenced message and its surroundings.

Long tasks send periodic “still working” messages (every minute by default). Each provider has a one-hour hard timeout by default. The shared conversation service does not impose an additional fixed deadline: preparation time does not reduce the configured provider timeout, and increasing that timeout allows longer runs. At that limit, the bot cancels or terminates the run and waits up to five seconds for cancellation confirmation.

To keep messages with links compact, set `DISCORD_SUPPRESS_EMBEDS=true` and restart the bot. This hides automatic link previews in text replies (including mentions, DMs, chat threads, and slash-command output) and scheduled messages while keeping URLs clickable. The default is `false`; existing messages are not changed, and uploaded files are still delivered.

### Artifact and media tools

The built-in `artifact_tools` MCP server is available to all three providers, including in shared mode.

| Tool | Behavior |
| --- | --- |
| `fetch_webpage` | Reads public pages, JSON, RSS and Atom; returns text, links, JSON-LD and timestamps. Automatically tries an anonymous browser for sparse script-rendered pages or HTTP 403. Use `mode: "browser"` to render explicitly and string `offset` from `nextOffset` for more text. Works in shared mode without shell networking. |
| `report_lookup` | Optionally retains source-backed, model-reported facts for a scheduled direct lookup. Verification requires a successful `fetch_webpage` call in the same run. Hosted search/article evidence does not require either tool. |
| `fetch_artifact` | Downloads a public HTTP(S) file URL, or resolves a Discord message's attachments, embedded media, and links. One candidate downloads immediately; multiple candidates are returned for selection using `candidate_id`. |
| `transcode_video` | Converts a local video to `av1`, `h264`, or `hevc` in MP4 using FFmpeg software encoding. Returns a decoded, verified local output. |
| `attach_file` | Validates and copies a finished file, freezes its bytes, and registers it for the current Discord response. Returns `ready` or an actionable error while the agent can still correct its output. |

Public research can use hosted web search and article opening, the direct reader,
and alternative sources. A direct-reader failure does not invalidate evidence
obtained through another reader. No per-domain configuration is required.

The direct reader validates and pins public DNS addresses on every redirect and
uses standard HTTP(S) ports. Each read has an 8 MiB document limit and a 45-second
deadline. Text is returned in 24,000-character chunks from a bounded 192,000-character
snapshot, with up to 16,000 JSON-LD characters. Continuations reuse the same snapshot.
A response can read 24 URL/mode combinations within the 80-call tool budget.
Transient connection and HTTP 5xx failures get one retry within the deadline.

The supplied Compose setup runs both browser readers in a separate `browser`
service with a hard 1 GiB memory limit (including swap and every child process).
It has no bot credentials or data volumes and exposes no host port. Its control
network is private to the bot; a separate network provides public internet access.
`AI_ASSISTANT_BROWSER_URL` selects this operator-configured service. Other installs
must provide the same bounded worker; there is no in-process browser fallback.
The worker resolves its cgroup v1/v2 membership and effective ancestor limits,
and refuses startup unless memory plus swap is capped at most 1 GiB.

The general reader runs sandboxed Chromium in a fresh anonymous context, without
saved account cookies or existing profiles. JavaScript, styles and
public GET/HEAD data requests can render articles. Every destination connection
passes through an authenticated local proxy that validates and pins public DNS,
including redirects and subresources. Loopback bypass and non-proxied WebRTC UDP
are disabled. Page POST requests, WebSockets, service workers, embedded frames,
popups, media downloads and images/fonts are blocked. Browser reads are limited
to 128 permitted requests/connections, 1,024 attempted requests, eight navigations,
and 64 MiB transfer/decoded-content
budgets. Anonymous cookies are discarded afterward; a first HTTP 403 establishing
cookies permits one follow-up navigation. Login requirements and human-verification
challenges remain unavailable; use other public coverage when needed.

Both browser readers share a single-browser admission limit to stay within the
256-process/thread container budget; overlapping reads queue and retain
their original deadlines. General rendering monitors a 50,000-node DOM budget
and limits the JavaScript heap to 128 MiB. Worker/SharedWorker constructors are
disabled before document scripts run; the service memory limit also contains
ArrayBuffer, Wasm, native DOM allocations and any child processes. An isolated-world traversal checks node,
depth and serialized-byte limits before returning HTML to the bot; it never
materializes an unbounded `page.content()` result.

HTTPS eBay item URLs use a smaller browser path with scripts and subresources
disabled. Up to five redirects to the same item on `https://www.ebay.com` may
continue; each destination is checked before Chromium follows it and the host's
public DNS address remains pinned. Redirects to another item/host are rejected,
repeated URLs stop as `navigation_loop`, and verification redirects return
`challenge`. Start listings with their canonical `/itm/ITEM_ID` URL in `mode=auto`.
Explicit JavaScript rendering also checks the final eBay item identity.
Page results expose bounded `images` and `embeddedPages` URL lists, so the agent
can read seller descriptions hosted in separate frames and inspect product
photos through existing tools. Extraction never automatically loads those URLs;
subsequent reads still pass through the public-network policy.

Browser results include bounded `diagnostics`: main-frame URLs, HTTP statuses,
redirect destinations, and the last response URL. Queries, fragments and URL
credentials are omitted from this trace. A title and short text excerpt are
included when a bounded document was readable; these are untrusted evidence,
not verified listing facts. Failures distinguish `challenge`, `navigation_loop`,
`navigation_limit`, and `listing_mismatch`, and include `nextStep` guidance.
The general reader stops on a third visit to the same URL or its existing
eight-navigation limit. No separate `agent-browser` CLI or plugin is required.

Chromium is
included in the container; other installs can set `AI_ASSISTANT_BROWSER_EXECUTABLE`.
The supplied `compose.yaml` uses `seccomp.json` to permit Chromium's user namespace
sandbox while retaining syscall filtering and dropping host capabilities. Keep
that profile beside the Compose file when deploying it elsewhere.

### Switch providers, models, and reasoning

Every session starts with the provider selected by `PROVIDER`. Use the following slash commands to inspect or change it:

```text
/provider list
/provider set codex
/provider current
```

A change inside a thread applies to that thread; a change in a channel or DM applies to that user's session. Provider choices survive restarts. Each provider keeps separate history for the same Discord session: switching to a provider for the first time starts fresh, and switching back resumes its earlier history. Conversation history is not transferred between providers.

Use `/model` to choose a model and `/reasoning` to control reasoning effort on supported providers. Commands that change providers, models, or reasoning require admin access.

### Search and memory

Ask naturally to “search this channel for the beach plans” or “search across the server.” The bot generates related queries, gathers indexed Discord messages, ranks the results, and returns source links. Searches respect the requester's channel access; the default pools are 200 candidates and 50 messages supplied to the answering agent.

Say “remember this” or “put this in memory” to save information for the server, and “forget the cheese agreement” to remove matching records. Relevant memories are recalled in later conversations. Replied-to contract summaries are resolved to their original messages so complete text and source links are preserved. Each memory keeps its source channel and is recalled only while the requester can still read that channel.

### Slash commands

| Command | Description | Copilot | Codex | OpenCode |
|---------|-------------|:---:|:---:|:---:|
| `/ask <prompt>` | One-shot question — no session history, private reply | ✅ | ✅ | ✅ |
| `/chat <message>` | Start/continue a persistent conversation in a thread | ✅ | ✅ | ✅ |
| `/reset` | Clear your conversation history | ✅ | ✅ | ✅ |
| `/model list/set/current` | List models, switch model, show current | ✅ | ✅ | ✅ |
| `/provider list/set/current` | Switch the active AI provider per session | ✅ | ✅ | ✅ |
| `/reasoning list/set/current` | Reasoning effort control | ✅ | ✅ | ⚠️ |
| `/status` | Show auth status and CLI version | ✅ | ✅ | ✅ |
| `/history [count]` | Show your recent exchanges | ✅ | ✅ | ✅ |
| `/agent list/current/select/deselect` | Custom agent management | ✅ | ⚠️ | ⚠️ |
| `/mode get/set` | Session mode (interactive/plan/autopilot) | ✅ | ⚠️ | ⚠️ |
| `/compact` | Compact session context | ✅ | ⚠️ | ⚠️ |
| `/fleet` | Start fleet mode | ✅ | ⚠️ | ⚠️ |
| `/plan read/update/delete` | Session plan management | ✅ | ⚠️ | ⚠️ |
| `/workspace list/read/create` | Workspace file management | ✅ | ⚠️ | ⚠️ |
| `/mcp list/enable/disable/workspace` | MCP server management | ✅ | partial | ⚠️ |
| `/servers`, `/leave` | Server management | ✅ | ✅ | ✅ |

`✅` = supported · `⚠️` = replies "provider does not support this" · `partial` = listing works, injection not

Support also depends on the configured security mode. Copilot's additional features include custom agents, plans, workspace commands, and user-scope skills loaded from `~/.agents/skills` at session start.

## Server-side Codex contribution reviews

Optional `AI_ASSISTANT_ENABLE_CODEX_REVIEWS=true` automatically reviews PRs published
through the contribution tools, including GitHub-App-authored fork PRs. It requires
shared mode, the existing GitHub contribution App configuration, and the separate
Linux `reviewer` container. This uses the native Codex CLI with a **ChatGPT login**;
API keys and endpoint overrides are rejected. It consumes the account's Codex
allowance and does not trigger the hosted GitHub Codex integration or GitHub Actions.

The assistant sends a hash-verified, head/base-pinned text snapshot through a private
Unix socket. The reviewer has its own persistent login volume, no GitHub/Discord
credentials, and no TCP control port. It launches at most one Codex process at a
time, with a ten-minute deadline. Codex's commands are sandboxed read-only, with
network, connected apps, MCP, plugins, hooks, and repository instructions disabled.
The worker does not execute project tests/builds. The host publishes a `COMMENT`
review as the publisher App, including actionable inline findings where supported;
neither service approves or merges. This is a Codex-powered static review, not a
review posted by the hosted Codex connector.

For the supplied Compose example, provision a **separate** login (do not copy or
concurrently share the assistant's live `auth.json`):

```sh
docker compose --profile reviews run --rm --no-deps --entrypoint /usr/local/lib/codex/bin/codex reviewer login --device-auth
# Complete the displayed sign-in, then enable AI_ASSISTANT_ENABLE_CODEX_REVIEWS.
docker compose --profile reviews up -d
```

The review listener remains running but Codex starts only for a review. Its Compose
limits are 1 CPU, 1 GiB memory/no additional swap, 128 processes, and 256 MiB temporary
storage; these are ceilings, not idle allocations. The socket volume is mounted only
by the assistant and reviewer. Never mount the assistant's data volume or the Docker
socket into the reviewer, and never expose its socket to agent workspaces.

`CODEX_REVIEW_LIMIT` defaults to 20 attempts per PR in both host and worker, including
failed/interrupted attempts; `0` removes this quota. Counts persist across turns and
restarts, including when the configured limit changes. Repeated requests for the
same head/base reuse a job. Stop once the current head has a completed review with
no remaining actionable findings: the budget is a ceiling, not a target. No-op
commits or extra PRs must not be created to trigger more reviews or reset a budget.
After checking a failure, `github_contribution_review` accepts `retry: true`:
it reconciles the old receipt first and only spends another attempt if inference
failed or its receipt is unavailable. An uncertain GitHub write is never reposted.
Definite GitHub rejections stop publication until an explicit retry, which reuses
completed inference. A successful PR publish still returns its URL if review
scheduling fails, with a separate `auto_review` error; this is not a clean review.
New commits automatically queue the next review if budget remains. A changed PR
head/base invalidates an in-flight result. Review inference and publication continue
after a Discord turn ends, but do not start a new unsolicited author conversation.
The current author turn is instructed to wait, evaluate findings, fix/test/publish,
and repeat within its tool budget. Failed, stale, exhausted, or uncertain outcomes
are never reported as a clean current-head review. Findings on deleted lines remain
in the review summary even when GitHub cannot place them inline.

Process preferences (what to test, how to respond, when to hand off) belong in the
existing operator/user instructions. Hard limits, repository ownership, and sandbox
permissions are enforced in code and cannot be overridden by those instructions.
The shared context registry includes enablement, review instructions, and tool
contracts, so existing sessions refresh at their next turn after a configuration
restart. One-shot and scheduled profiles do not gain contribution/review tools.

Both durable ledgers must be retained: the host's `github-contributions.json.reviews.json`
beside its contribution state, and `/data/review-jobs` in the reviewer's volume.
Do not clear them to retry a failed review or reset a budget. Interrupted inference
fails closed rather than spending another review; ambiguous publication checks for
the existing review marker instead of posting duplicates. Large, binary, unsupported,
or incomplete patches fail closed. Unchanged generated/lock files and excess context
may be omitted and are explicitly listed in the review snapshot.

## Scheduled tasks and named rights

Authorization is centralized in `src/common/accessPolicy.ts`. Existing
`DISCORD_ALLOWED_USERS` and `DISCORD_ADMIN_USERS` behavior remains compatible,
including the open-admin fallback for existing commands. Optional
`DISCORD_RIGHTS_FILE` JSON grants add named capabilities to individual Discord
users or guild-scoped Discord roles. `SLACK_RIGHTS_FILE` (or the shared
`SCHEDULE_RIGHTS_FILE`) uses the same format with `"platform":"slack"`, a
`tenantId`, and a Slack user ID. The file is operator-controlled, must be
outside agent workspaces, is validated at startup, and is refreshed for schedule
authorization so revocation does not require restart; shared mode rejects paths
inside the provider workspace root, including symlink targets. Restart to reload changes.
See [`rights.example.json`](rights.example.json) for a complete example with
placeholder IDs. Discord's Administrator permission does **not** automatically
grant bot administration.

| Capability | Operations |
| --- | --- |
| `chat.use` | Conversations and existing public slash actions |
| `ask.use` | Permission to invoke private one-shot `/ask` in shared mode (also requires ordinary command access) |
| `session.configure` | Model, reasoning, provider, agent, and mode changes |
| `workspace.manage` | Workspace operations and explicit `/ask`/`/chat` workspaces |
| `mcp.manage` | MCP configuration |
| `bot.manage` | Global bot administration: servers, leave, status, fleet |
| `schedule.message.create` | Create or modify fixed-message tasks |
| `schedule.ai.create` | AI tasks; explicit opt-in for trusted users or guild roles |
| `schedule.manage.own` | Inspect and manage owned tasks |
| `schedule.manage.guild` | Inspect and manage all tasks in the granted guild |
| `schedule.manage.tenant` | Inspect and manage tasks in the granted Discord guild or Slack workspace |

The `member` preset grants `chat.use`. The `scheduler` preset adds
`schedule.message.create` and `schedule.manage.own`. The `server-admin` preset
adds `schedule.manage.guild`; it grants no host, provider, or cross-server
administration. The global `bot-admin` preset grants all capabilities and may
only be assigned to user IDs. Role grants require `guildId`. Task edits,
resumes, manual runs, and delivery retries also require creation rights for that
task type: a server schedule manager also needs `schedule.ai.create` to rewrite
or execute an AI task. No in-Discord rights editor is exposed.

For an admin-only installation, set `DISCORD_ADMIN_USERS` explicitly and
`SCHEDULES_ENABLED=true`. For a scheduling whitelist, additionally grant the
`scheduler` preset to selected user IDs or a Discord role. An empty admin list
never grants scheduling, even if legacy commands allow everybody. Scheduling
rights are additive to the existing lists; set an explicit admin list if you
want other configuration commands restricted too.

To allow trusted Discord admins to schedule both messages and AI tasks, grant
their guild-scoped role the `server-admin` preset and explicitly add
`"capabilities": ["schedule.ai.create"]`. Neither the `scheduler` nor the
`server-admin` preset enables AI scheduling by itself. Explicit bot administrators
retain scheduling access; ordinary Discord Administrator permissions alone do
not grant it.

```text
/schedule create kind:message channel:#reminders content:Submit your availability cron:0 9 * * 5 timezone:America/New_York
/schedule create kind:ai channel:#daily-updates content:Summarize the recent discussion cron:0 9 * * 1-5 timezone:America/New_York provider:codex model:<model-id> context_messages:100
/schedule create kind:message channel:#reminders content:Check the deployment cron:0 */3 * * * timezone:America/New_York start_at:2026-12-01 09:00 end_at:2026-12-31 18:00
```

Creation shows the interpreted schedule and up to three occurrences within its start and end dates.
`/schedule list` shows manageable tasks in the current guild. Use
`/schedule inspect id:<id>` for the prompt/message, ownership, saved settings,
pause reason, recent runs, and delivered-message links. `/schedule edit`,
`pause`, `resume`, `delete`, and `run-now` operate on that ID. Delete also removes
the task's run history. Configuration responses are ephemeral. A guild schedule
manager can inspect all scheduled prompts in their guild, so grant that role
only to users trusted with those prompts.

`start_at` and `end_at` are optional and can be used separately or together.
Use `YYYY-MM-DD HH:mm` (optionally with seconds) in the schedule's timezone, or an
ISO date-time with an explicit offset, such as `2026-12-31T18:00:00-05:00`.
The end must be in the future and later than the start. A start in the past is
treated as already active; missed occurrences are skipped. Local times skipped
or repeated by a daylight-saving clock change require another time or an explicit
offset. Add or change either date with `/schedule edit id:<id> start_at:2026-12-01 09:00 end_at:2026-12-31 18:00`;
clear either with `start_at:none` or `end_at:none` on `/schedule edit`.
Changing the timezone alone keeps the saved date instants; supply the dates again
to reinterpret them in the new timezone.

A task with a future start is shown as scheduled and waits until that date,
including after a pause/resume or bot restart. Automatic runs, `run-now`, and
delivery retries cannot start early. The first automatic run is the first cron
occurrence at or after the start; a run exactly at the start time is included.

At or after the cutoff, the schedule is marked ended: no new runs or delivery
retries can start, and pending output is suppressed. A run exactly at the end
time is excluded. This also applies after a bot restart. Existing tasks without
date limits keep their current behavior. To restart an ended schedule, extend or clear
its end date, then use `/schedule resume`. Ended tasks retain their history and
count toward quotas until deleted. Like pausing, ending cannot recall messages
already being sent or undo provider tool effects; active inference may still finish.

Discord schedules support ordinary guild text channels; Discord DMs, threads,
forum containers, natural-language creation, and one-time tasks remain deferred.
Cron accepts five fields (minute, hour, day of month, month, weekday) and requires
an explicit IANA timezone. Local schedules use cron-parser's daylight-saving
semantics: the UTC execution time changes with the local clock. Use UTC when
fixed UTC intervals matter; inspect the preview around clock changes. A runtime
minimum interval also prevents closely spaced executions, including manual runs.

Fixed-message tasks make no provider call. AI tasks require an explicit saved
model, use the selected provider (or the bot's configured provider at creation),
and optionally save a reasoning effort. They start with a fresh session and a
separate temporary workspace on every run. Provider-wide security, system prompt,
and integration configuration still apply; this is not a new tool sandbox.
AI scheduling defaults to explicit bot administrators. Only grant
`schedule.ai.create` to users or guild roles trusted to run unattended AI tasks
with those same provider tools and integrations.
Scheduled AI runs use at most `SCHEDULE_AI_TIMEOUT_MS`, or the provider's shorter
configured inference timeout, plus its existing cancellation grace period.

`/schedule inspect` separates delivery state from webpage lookup outcome. A
delivered failure notice can have `delivery: succeeded` and `lookup: unavailable`.
`fetched; facts not verified` means the page was read but no verified factual
summary was reported; `not reported` means no built-in webpage lookup was recorded
(including ordinary non-lookup tasks and hosted-web-only runs). Verification is
a model report backed by a readable source, not an independent fact checker.
Individual source failures remain in run diagnostics and are not prepended to
Discord posts. Scheduled updates contain supported findings and a short coverage
caveat only when needed. Up to 10 last verified summaries
are retained per task and supplied to later runs as explicitly stale, untrusted
context, with their original timestamps. Failed reads never replace those values.
Changing the saved prompt clears the summaries. This metadata persists alongside
the existing tasks/runs without changing their delivery/retry behavior.

AI context is opt-in (`context_messages:0` by default, maximum 100 recent messages,
40,000 characters). Only non-bot messages from the destination channel whose
authors are allowed to use the bot are included. No conversation history or
server-wide memory is automatically reused. Host-provided Discord attachment
lookups are restricted to that same destination, and linked private channels
cannot be resolved through this callback. Every run checks the owner's current
guild membership, role grants, and owner/bot channel permissions before execution
and before each outbound message. Revoked access pauses the task. Restart after
environment or rights-file changes so the new policy applies. Both fixed-message
and AI scheduled posts allow user, role, `@everyone`, and `@here` mentions.
Use actual Discord mentions (`<@USER_ID>` or `<@&ROLE_ID>`), not plain display
names. Role pings require a mentionable role or the bot's "Mention @everyone,
@here, and All Roles" permission; `@everyone` and `@here` require that permission.
Recipients' Discord notification settings still apply.

Schedules and run history live in
`~/.config/ai-assistant/schedules.sqlite` (inside the existing `assistant-data`
volume in Docker). Back up the database consistently with its WAL, or stop the
bot before copying it. SQLite transactional claims and a 60-second scheduler
lease allow one active scheduler per database. After an unclean restart the bot
waits for that lease to expire and starts the scheduler automatically, without
exiting or restarting the bot again. A stale worker is checked before delivery.

Graceful shutdown stops accepting new runs and drains active runs without disabling
their schedules. The supplied Compose file allows 11 minutes for shutdown, covering
the default 10-minute inference timeout and delivery/cleanup. Set the deployment's
`stop_grace_period` above your configured inference timeout, and avoid overriding it
with a short `docker stop`/`docker compose` timeout during updates.
Missed occurrences after downtime are skipped. Tasks do not overlap, and full
worker capacity skips occurrences rather than building an unbounded backlog.
Defaults are 15 minutes between starts, 10 tasks per owner across servers, 50 per
guild, two concurrent runs, and a 10-minute AI inference limit; the `SCHEDULE_*`
variables in `.env.example` configure these bounds. Paused tasks count toward
quotas. Three consecutive generation failures pause a task.

Generation output and delivery state are recorded separately. Successful runs
retain message IDs but discard output payloads. Run history, including unresolved delivery failures and uncertain outcomes, is
bounded to the latest 20 runs per task. Inspect failures before starting more runs. A definitely rejected Discord send can be retried with
`/schedule retry-delivery id:<id> run_id:<run-id>`; it sends only the remaining
parts and does not repeat AI work. Editing a task invalidates old delivery retries.
After a restart, interrupted generation is queued under its original run ID and
occurrence, with up to three generation restarts per run. Saved output resumes from
the first part without a recorded message ID, without repeating AI work. Recovery
obeys concurrency limits and rechecks task revisions, dates, and permissions.
Generation starts afresh; provider tool effects from the interrupted attempt may
be repeated. This does not resume the provider's in-memory reasoning session.
An ambiguous send stays uncertain and is never automatically replayed, but future
occurrences remain enabled. Unconfirmed provider cancellation still pauses the task
because the old provider may be running. Existing schedules paused solely by the
old restart recovery are repaired automatically on upgrade, unless subsequently
edited, explicitly paused, or ended. Exactly-once Discord
delivery is not guaranteed, including the crash window between a successful send
and saving its message ID. Pausing or editing suppresses pending output, but cannot
recall a message already being sent or undo provider tool effects.

### Slack scheduled actions

With the Slack adapter selected, `SCHEDULES_ENABLED=true` enables the same store,
worker lease, recurrence validation, limits, recovery, and run history used by
Discord. Slack is only the control and delivery surface: schedules invoke the
agent internally and post through `chat.postMessage`; Slack `/remind`, Slackbot,
Workflow Builder, and bot-authored events never trigger an agent run.

The primary flow is a mention in an allowed channel/thread, or a message in an
allowed one-to-one DM:

```text
@agent Schedule every Monday at 9 AM to search for latest news about AI safety and post a source-linked summary here
@agent Remind us every weekday at 4:30 PM to update the release notes
@agent Schedule every day at 8 AM to summarize recent channel context
```

The host resolves supported recurrence phrases, defaults the destination to the
current channel or thread, and replies with kind, action, cadence, timezone,
dates, destination, context count, provider/model, and upcoming occurrences.
Nothing is saved until the same actor replies in the same conversation with
`@agent confirm proposal_<id>` (the mention is unnecessary in a DM). Proposals
expire after ten minutes, are bound to the authenticated actor and conversation,
and are consumed once. Repeating a confirmation returns the original schedule.
Use `@agent cancel proposal_<id>` to discard one. Unsupported or ambiguous
recurrences and underspecified “latest news” requests produce a clarification.
“First business day” is not representable by the five-field cron engine.

Deterministic fallback syntax is:

```text
@agent schedule create --kind message --content "Submit timesheets" --cron "0 16 * * 5" --timezone America/New_York
@agent schedule create --kind ai --content "Research platform releases with source links" --cron "0 9 * * 1" --timezone America/New_York --provider codex --model <model-id> --reasoning low --context-messages 20 --start-at 2026-11-01T09:00:00-05:00 --end-at 2027-01-01T00:00:00-05:00
@agent schedule list
@agent schedule inspect <schedule-id>
@agent schedule edit <schedule-id> --content "New action" --cron "30 9 * * 1-5"
@agent schedule pause|resume|delete|run-now <schedule-id>
@agent schedule retry-delivery <schedule-id> <run-id>
```

Create and material edit return a confirmation proposal. Inspect includes saved
settings, status, recent outcomes, timestamps, and Slack permalinks when available.
Sensitive details are redacted when inspection occurs outside the saved audience.
Delivery retry uses saved completed output without running the provider again.
Ambiguous sends (`internal_error`, `fatal_error`, malformed replies, connection
loss, timeout, or interruption after sending begins) remain `uncertain` and are
never replayed automatically. Accepted output parts are checkpointed separately.
This is not an exactly-once guarantee for provider calls or external posts.

Slack scheduling requires explicit named rights in addition to
`SLACK_ALLOWED_USERS`; unattended AI access is never inferred from chat access.
The example rights file shows a workspace-scoped user grant. The worker rechecks
the owner allowlist and grants, workspace/installation, destination allowlist,
bot and owner membership, unsupported shared-channel flags, saved audience,
dates, and revision before execution and delivery. One-to-one DMs are supported;
group DMs and Slack Connect/shared channels are not.

The first release runs one selected chat adapter per process. A worker claims and
recovers only its active platform, though one database can hold both platforms.
Do not run Discord and Slack processes concurrently against that file: the single
60-second lease remains authoritative. Schema v2 migration is transactional and
writes `<database>.pre-v2-backup` before changing an existing database. To roll
back, stop every worker, retain the current database for diagnosis, and restore
that backup before starting the old binary.

Troubleshooting: “Scheduling is disabled” means `SCHEDULES_ENABLED` was not
exactly `true`; permission errors require a valid current named grant, not only a
Slack allowlist entry. An inaccessible destination must be allowlisted and have
both owner and bot membership. A waiting worker begins after the previous
60-second lease expires. Provider/model failures remain in run inspection; a
definite delivery rejection can use `retry-delivery`, while an `uncertain` send
must be checked in Slack and resolved manually rather than replayed.

## Environment variable reference

The tables below cover every setting read or explicitly passed to providers by this repository, including advanced settings missing from the starter template. Provider CLIs can have additional configuration of their own; in `unrestricted` mode they inherit the full process environment.

### Where configuration lives

| Installation | Configuration file | How it is loaded |
| --- | --- | --- |
| Global CLI | `~/.ai-assistant/.env` | `setup` writes it; `start` and `register` change into that directory before loading it. |
| Source checkout | `.env` in the repository | `npm start` and `npm run register` load it from the working directory. |
| Docker Compose | `.env` beside `compose.yaml` | Compose passes entries into the container. Its explicit `environment` entries override the same keys in `.env`. |

For native foreground runs, variables already set in the launching environment take precedence over `.env`. Update or unset an exported value before relying on a change in the file.

Two native-startup exceptions are `COPILOT_MODEL` and `MCP_CONFIG_PATH`: the application reads them before loading `.env`. Set them in the launching environment before `npm start` or `ai-assistant start`. Docker and systemd populate the environment before application startup, so their configured values are available in time.

Restart native processes after changing configuration. For Docker, use `docker compose up -d` to apply changes; a container restart alone does not reload Compose's environment. Existing Copilot and Codex sessions may need `/reset` after system-prompt changes.

Defaults below describe behavior when a setting is absent, with template, wizard, and container overrides called out explicitly. `~` in a documented default means the operating-system user's home; use absolute paths when setting path overrides yourself. Time values are milliseconds and size values are bytes.

### General settings and security

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `PROVIDER` | `copilot`; accepts `copilot`, `codex`, `opencode` | Selects the default AI backend. `/provider set` overrides it for a session. |
| `AI_ASSISTANT_CONFIG_DIR` | `~/.ai-assistant`; container: `/data` | Changes the CLI's configuration directory. Set in the launching environment **before** invoking the CLI; placing it only inside the file it is meant to locate does not redirect loading. Does not relocate session stores. |
| `AI_ASSISTANT_SYSTEM_PROMPT` | Unset | Adds persistent operator instructions to every provider. Quote text containing spaces or `#` in `.env`. |
| `AI_ASSISTANT_SYSTEM_PROMPT_FILE` | Unset | Reads operator instructions from a UTF-8 file, taking precedence over inline text. Relative paths resolve from the bot's working directory. Unreadable files cause an error. In Docker, keep the file under `/data`. |
| `USER_INSTRUCTION_MODE` | `off`; accepts `off`, `admin_only`, `admin_and_self`, `unfiltered` | Enables per-Discord-user ruleset injection and management. `off` disables injection and hides ruleset tools. `admin_only` allows only ruleset admins. `admin_and_self` allows admins plus users managing their own rulesets. `unfiltered` allows any authorized bot user to manage any target user's rulesets. |
| `USER_INSTRUCTION_RULESETS_FILE` | `~/.config/ai-assistant/user-instructions.json` | JSON file storing user instruction rulesets. In shared mode, keep it outside the provider workspace, including symlink targets. Back this up with the rest of the bot configuration. |
| `AI_ASSISTANT_SECURITY_MODE` | `unrestricted` if absent; template/wizard: `shared` | `shared` isolates credentials and scopes provider tools; `unrestricted` gives providers the operator's inherited capabilities. Invalid values stop startup. See [Provider security](#provider-security). |
| `AI_ASSISTANT_ENABLE_SITES` | `false`; accepts `true`, `false` | In shared mode, enables the Codex Sites connector and scoped source-push network access to create, update, and publish through the logged-in ChatGPT account. Other apps remain restricted and destructive connector actions remain blocked. |
| `AI_ASSISTANT_WORKSPACE_ROOT` | Working directory in shared mode; wizard: `<config dir>/workspaces`; Compose: `/data/workspaces` | Sets the enforced root for provider file access in shared mode. Ignored in unrestricted mode. Compose explicitly sets this value, so changing it there requires editing `compose.yaml`. |
| `CHAT_PARTICIPATION_MODE` | Shared: `smart`; unrestricted: `always` | Bot-owned thread behavior: `smart`, `always`, or `mentions-only`. |
| `CHAT_PARTICIPATION_EVALUATOR` | `provider` | Use the thread's provider/login, or select `jev`. |
| `CHAT_PARTICIPATION_MODEL` | Luna for Codex/Copilot; available small model for OpenCode; `jev-latest` for Jev | Separate evaluator model; does not change the main conversation model. |
| `CHAT_PARTICIPATION_REASONING` | `none` | `none` or `low`; Copilot uses `low`. Ignored by Jev. |
| `CHAT_PARTICIPATION_TIMEOUT_MS` | `15000` | Evaluator timeout, 100–60000 ms. |
| `TYPESAFE_API_KEY` | Unset | Required only when the participation evaluator is `jev`. |
| `REGISTER_COMMANDS_ON_START` | `true` in the container entrypoint | Registers guild slash commands before the container starts the Discord adapter. Slack always skips registration. Set `false` to skip for Discord; only the exact value `true` enables registration. Has no effect on native startup. |

For a short custom prompt:

```env
AI_ASSISTANT_SYSTEM_PROMPT="Use a playful tone, but be concise."
```

For a longer prompt, set `AI_ASSISTANT_SYSTEM_PROMPT_FILE` to a file readable by the bot, such as `/data/system-prompt.txt` in Docker.

Prompt-file edits and ruleset changes apply to existing conversations on their next turn. Copilot resumes with updated configuration, OpenCode supplies current instructions each turn, and Codex transfers a bounded historical summary into a fresh thread when context changes. See [session context lifecycle and contributor guidelines](docs/context-lifecycle.md) for tool enrollment, compaction behavior, and failure recovery.

Ruleset commands and tools manage rules in their current server. Global rules also appear in applicable listings and previews, but guild-scoped management never edits or deletes them: a server's ruleset administrator must not gain authority over other servers. Global rules created in unrestricted-mode DMs can be managed there; in shared mode, where DMs are disabled, the host operator manages them in `USER_INSTRUCTION_RULESETS_FILE`. Cross-server command management would require explicit scope selection and separate authorization.

### Discord

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `DISCORD_TOKEN` | Required | Bot token used to connect to Discord and register commands. |
| `DISCORD_APP_ID` | Required for registration | Discord Application ID whose slash commands are registered. |
| `DISCORD_GUILD_ID` | Required for registration | Server ID receiving the guild slash commands. The registration script does not fall back to global registration. |
| `DISCORD_FREE_CHANNELS` | Empty; comma-separated channel IDs | Channels where allowed users can chat without mentioning the bot. |
| `DISCORD_SUPPRESS_EMBEDS` | `false`; set `true` to enable | Hides automatic link previews in bot text replies and scheduled messages without changing link text. Restart after changes; existing messages are unaffected. |
| `DISCORD_ALLOWED_USERS` | Empty; comma-separated user IDs | Restricts ordinary messages and public slash actions. Empty allows everyone; explicit admins can also invoke public slash actions. |
| `DISCORD_ADMIN_USERS` | Falls back to `DISCORD_ALLOWED_USERS` | Comma-separated user IDs allowed to invoke administrative slash actions. If both lists are empty, everyone has admin access. Does not by itself grant access to ordinary messages. |
| `DISCORD_ATTACHMENT_MODE` | `native`; accepts `native`, `text` | `native` stages attachments in the turn's workspace and supplies file paths; binary files are never inlined as text. `text` embeds text/code uploads as untrusted text and deletes temporary uploads before the provider runs; binary uploads and video processing are unavailable. Images remain vision inputs in both modes. |
| `DISCORD_SEARCH_CANDIDATE_LIMIT` | `200`; integer ≥ `25` | Maximum unique indexed search candidates gathered across generated queries. Invalid or smaller values use the default. |
| `DISCORD_SEARCH_CONTEXT_LIMIT` | `50`; integer ≥ `10` | Maximum ranked search messages supplied to the answering agent. Invalid or smaller values use the default. |
| `DISCORD_MEMORY_RECALL_LIMIT` | `5`; integer ≥ `1` | Maximum relevant durable memories included in a response. Invalid or smaller values use the default. |

### Slack

See [Slack adapter setup](#slack-adapter) for app scopes, token access, startup and limitations. Restart after changes.

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `SLACK_APP_TOKEN` | Required for Slack | App-level Socket Mode credential (`xapp-…`). |
| `SLACK_BOT_TOKEN` | Required for Slack | Installed bot OAuth credential (`xoxb-…`); identity, membership and posting. Also used for history unless overridden. |
| `SLACK_TEAM_ID` | Required for Slack | Expected workspace ID. Both bot and history credentials must authenticate to this workspace. |
| `SLACK_ALLOWED_CHANNELS` | Required, nonempty | Comma-separated channel IDs where mentions are accepted. |
| `SLACK_ALLOWED_USERS` | Required, nonempty | Comma-separated user IDs allowed to start turns; does not filter history authors. |
| `SLACK_INSTALLATION_ID` | `default` | Stable logical installation namespace for sessions. Changing it creates separate session identities. |
| `SLACK_HISTORY_TOKEN` | `SLACK_BOT_TOKEN` | Optional separate OAuth credential with access to channel and thread history in the same workspace. |
| `SLACK_EXCLUDED_CONTEXT_USERS` | Empty | Comma-separated IDs excluded from fetched history. Do not include spaces around commas. Policy changes rebuild retained context. |
| `SLACK_RIGHTS_FILE` | Unset | Named Slack grants; use `platform: slack`, `tenantId`, and a user ID. Reloaded on schedule decisions. |
| `SLACK_ADMIN_USERS` | Empty | Explicit workspace administrators. Unlike the chat allowlist, grants tenant-wide schedule administration. |
| `SCHEDULE_DEFAULT_TIMEZONE` | `UTC` | Trusted IANA timezone used when a Slack request omits one. Always shown before confirmation. |
| `SCHEDULE_DEFAULT_PROVIDER` | `PROVIDER` | Provider saved explicitly on new Slack AI schedules. |
| `SCHEDULE_DEFAULT_MODEL` | Unset | Model saved on conversational Slack AI schedules; required unless deterministic create supplies `--model`. |
| `SCHEDULE_DEFAULT_REASONING` | Unset | Optional reasoning setting saved on conversational Slack AI schedules. |

### Run timing and output files

Provider timing and progress settings require integer values of at least `10`; invalid or smaller values use the default. Setting `0` does not disable progress updates or timeouts. Media timing and file limits have the bounds listed below.

| Variable | Default | What it does |
| --- | --- | --- |
| `SCHEDULES_ENABLED` | `false` | Starts the active adapter's scheduler and Slack frontend when exactly `true`. Disabled mode creates no lease or schedule worker. |
| `SCHEDULE_DB_PATH` | Slack: `<AI_ASSISTANT_STATE_DIR>/schedules.sqlite`; Discord: existing config path | Optional Slack database override. A database may contain both platforms, but only one process may hold its worker lease. |
| `SCHEDULE_RIGHTS_FILE` | Platform rights-file setting | Shared named-rights source, taking precedence over Slack/Discord-specific rights paths. |
| `SCHEDULE_MIN_INTERVAL_MINUTES` | `15` | Minimum interval between starts, including manual runs. |
| `SCHEDULE_MAX_PER_USER` | `10` | Owner quota. Discord keeps its existing cross-guild owner semantics; Slack owners are namespaced by workspace. |
| `SCHEDULE_MAX_PER_GUILD` | `50` | Existing tenant quota; for Slack this applies per namespaced workspace. |
| `SCHEDULE_CONCURRENCY` | `2` | Maximum concurrent runs for the active worker. |
| `SCHEDULE_AI_TIMEOUT_MS` | `600000` | Host cap for scheduled AI generation. |
| `AI_PROGRESS_INTERVAL_MS` | `60000` (1 minute) | Interval between progress messages during long runs, for all providers. |
| `AI_CANCELLATION_GRACE_MS` | `5000` (5 seconds) | How long to wait for a provider to confirm cancellation after a timeout. |
| `COPILOT_TIMEOUT_MS` | `3600000` (1 hour) | Hard limit for a Copilot run; the active run is aborted on timeout. |
| `CODEX_TIMEOUT_MS` | `3600000` (1 hour) | Hard limit for a Codex run; the active run is cancelled on timeout. |
| `OPENCODE_TIMEOUT_MS` | `3600000` (1 hour) | Hard limit for an OpenCode run; its child process is terminated on timeout. |
| `AI_INPUT_ATTACHMENT_MAX_BYTES` | `104857600` (100 MiB) | Per-file limit for incoming uploads and URL downloads. Requires an integer from `1` to `536870912` (512 MiB); invalid values raise an error. |
| `AI_MEDIA_TIMEOUT_MS` | `300000` (5 minutes) | Deadline for software video conversion. Positive integer, capped at `900000` (15 minutes); invalid values use the default. |
| `AI_OUTPUT_ATTACHMENT_MAX_BYTES` | `10485760` (10 MiB) | Maximum size of each agent-created response attachment, also bounded by the total response limit. |
| `AI_OUTPUT_ATTACHMENT_MAX_TOTAL_BYTES` | `10485760` (10 MiB) | Maximum combined attachment bytes retained for one response; hard cap `104857600` (100 MiB). |
| `AI_OUTPUT_ATTACHMENT_MAX_COUNT` | `10` | Maximum agent-created attachments per response; hard cap `10`. |

### GitHub Copilot

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | Unset; persisted CLI login | Authenticates with a GitHub account that has Copilot access. Takes precedence over `GH_TOKEN`. |
| `GH_TOKEN` | Unset | Fallback token when `COPILOT_GITHUB_TOKEN` is absent or blank. |
| `COPILOT_MODEL` | `claude-haiku-4.5` | Default Copilot model ID. For native foreground runs, set it in the launching environment; `.env` is loaded too late for this setting. |
| `COPILOT_HOME` | `~/.copilot` in shared mode | Sets Copilot's base directory in shared mode and is passed to its process for configuration/login state. |
| `GH_CONFIG_DIR` | CLI-defined | Optional GitHub CLI configuration directory passed to Copilot in shared mode. |

### OpenAI Codex

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | Unset; persisted Codex CLI login | Authenticates Codex with an API key. Also passed to OpenCode when using an OpenAI model provider. |
| `OPENAI_BASE_URL` | SDK default | Overrides the OpenAI API endpoint used by Codex, for example `https://api.openai.com/v1`. |
| `CODEX_MODEL` | `gpt-5.6-sol` | Default Codex model ID. |
| `CODEX_REASONING_EFFORT` | `low`; accepts `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Default Codex reasoning effort. Invalid values raise an error; model support may vary. |
| `CODEX_WEB_SEARCH_MODE` | `cached`; accepts `disabled`, `cached`, `indexed`, `live` | Controls Codex hosted web search for normal Discord, Slack, and local CLI conversations. Values are trimmed and case-insensitive; invalid values stop Codex startup or selection but do not affect Copilot or OpenCode. `cached` uses the hosted cache, `indexed` may search the hosted index, `live` permits current live retrieval, and `disabled` removes hosted search. This does not change local command networking. Restart after changing it (for Compose, recreate with `docker compose up -d`). |
| `CODEX_HOME` | `~/.codex` | Codex configuration/login directory, also used to locate its model cache and generated images. |
| `CODEX_EXECUTABLE_PATH` | SDK executable; image: `/usr/local/lib/codex/bin/codex` | Overrides the Codex executable used by the SDK. The image sets this to its bundled runtime. |
| `CODEX_MAX_INLINE_ATTACHMENT_BYTES` | `200000` | Maximum bytes per non-image attachment read as text by the Codex adapter; positive integer, capped at `1000000`. Oversized attachments produce an error. |

To exercise the real hosted-search boundary without making it part of CI, run `CODEX_WEB_SEARCH_SMOKE=1 npx tsx scripts/smoke-codex-web-search.ts` with a working Codex login. It checks that `live` produces a cited current result and that `disabled` emits no hosted-search operation.

### OpenCode and model provider keys

The following API keys are explicitly allowed into the OpenCode child process in shared mode. Set the key for the model provider you use, or use a persisted CLI login. `OPENAI_API_KEY` is listed in the Codex table above.

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `OPENCODE_MODEL` | OpenCode's configured default | Selects a model in `provider/model` format, for example `openrouter/anthropic/claude-sonnet-4.5`. |
| `OPENCODE_BIN` | Known npm install locations, then `opencode` on `PATH` | Overrides the OpenCode executable path. |
| `ANTHROPIC_API_KEY` | Unset | API key for OpenCode's Anthropic provider. |
| `OPENROUTER_API_KEY` | Unset | API key for OpenCode's OpenRouter provider. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Unset | Google model provider API key passed to OpenCode. |
| `GEMINI_API_KEY` | Unset | Gemini API key passed to OpenCode; interpretation depends on the selected provider. |
| `GROQ_API_KEY` | Unset | API key for OpenCode's Groq provider. |
| `MISTRAL_API_KEY` | Unset | API key for OpenCode's Mistral provider. |
| `COHERE_API_KEY` | Unset | API key for OpenCode's Cohere provider. |
| `XAI_API_KEY` | Unset | API key for OpenCode's xAI provider. |
| `OPENCODE_DISABLE_AUTOUPDATE` | Forced to `1` by the bot | Disables CLI auto-updates for each OpenCode child process. Operator values are overwritten. |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | Forced to `1` in shared mode | Prevents repository configuration from weakening OpenCode's generated security policy. In unrestricted mode, an existing value is inherited. |
| `OPENCODE_CONFIG_CONTENT` | Generated by the bot in shared mode | Supplies OpenCode's inline security policy in shared mode, overriding operator values. In unrestricted mode, existing configuration is preserved; the bot adds its artifact MCP tools when starting a turn. |

### MCP

| Variable | Default | What it does |
| --- | --- | --- |
| `MCP_CONFIG_PATH` | `~/.config/Code/User/mcp.json` | Overrides the global MCP file (`mcpServers` key). Workspace `.vscode/mcp.json` entries (`servers` key) win on duplicate names. Provider and security-mode support governs injection. For native foreground runs, set it in the launching environment; `.env` is loaded too late. |
| `MCP_INPUT_*` | Unset | Resolves `${input:id}` placeholders in MCP configuration. Uppercase the ID and replace hyphens with underscores: `${input:grafana-service-account-token}` uses `MCP_INPUT_GRAFANA_SERVICE_ACCOUNT_TOKEN`; `${input:portainer-api-token}` uses `MCP_INPUT_PORTAINER_API_TOKEN`. Servers with unresolved inputs are skipped. |
| `AI_ARTIFACT_BRIDGE_URL` | Generated by the bot | Internal endpoint supplied to the bot-launched artifact MCP adapter. Do not configure manually. |
| `AI_ARTIFACT_BRIDGE_TOKEN` | Generated by the bot | Internal authentication token supplied to the artifact MCP adapter for its provider session. Do not configure manually. |

### Inherited operating-system and runtime variables

These are advanced runtime inputs, usually supplied by the operating system. The bot does not assign defaults unless noted. Shared mode passes the common runtime variables below to provider processes; Codex uses a separate, narrower environment for local shell commands. XDG and GitHub configuration variables are provider-specific. The bot's own session stores remain under `~/.config/ai-assistant` regardless of XDG overrides.

| Variable | What it does / scope |
| --- | --- |
| `HOME` | Home-directory context on POSIX; also used to locate OpenCode's npm installation and Copilot's shared-mode base directory. Compose sets `/data` for the bot; Codex overrides it with the selected working directory for shared-mode local commands. |
| `USERPROFILE` | Windows home-directory context; fallback for Copilot's shared-mode base directory. Codex sets it to the selected working directory for shared-mode local commands on every platform. |
| `HOMEDRIVE` | Windows home drive passed to provider processes. |
| `HOMEPATH` | Windows home path passed to provider processes. |
| `APPDATA` | Used by the bot on Windows to look for OpenCode in the global npm installation. |
| `PATH` | Executable search path. The image includes the bundled Codex runtime and provider binaries. |
| `SYSTEMROOT` | Windows system directory context passed to providers. |
| `WINDIR` | Windows installation directory passed to providers. |
| `COMSPEC` | Windows command-interpreter path passed to providers. |
| `PATHEXT` | Windows executable extensions used during command lookup. |
| `TEMP` | Temporary-directory hint; Codex local commands use a private per-session directory in shared mode. |
| `TMP` | Alternative temporary-directory hint, with the same Codex override. |
| `TMPDIR` | POSIX temporary-directory hint, with the same Codex override. |
| `LANG` | Default locale passed to providers. |
| `LC_ALL` | Locale override passed to providers. |
| `LC_CTYPE` | Character-handling locale passed to providers. |
| `TERM` | Terminal type passed to providers. |
| `NO_COLOR` | Color-output preference passed to providers. |
| `HTTP_PROXY` | HTTP proxy configuration passed to provider processes; support depends on the CLI. |
| `HTTPS_PROXY` | HTTPS proxy configuration passed to provider processes. |
| `ALL_PROXY` | General proxy configuration passed to provider processes. |
| `NO_PROXY` | Hosts excluded from proxy use by supporting clients. |
| `NODE_EXTRA_CA_CERTS` | Additional certificate-authority file for Node-based clients. |
| `SSL_CERT_FILE` | Certificate-authority bundle path for supporting clients. |
| `SSL_CERT_DIR` | Certificate-authority directory for supporting clients. |
| `XDG_CONFIG_HOME` | Configuration base directory passed to Copilot and OpenCode in shared mode. |
| `XDG_DATA_HOME` | Data base directory passed to Copilot and OpenCode in shared mode. |
| `XDG_CACHE_HOME` | Cache base directory passed to Copilot and OpenCode in shared mode. |
| `XDG_STATE_HOME` | State base directory passed to OpenCode in shared mode. |
| `SUDO_USER` | Preferred account name when the CLI generates a systemd service. |
| `USER` | Service account fallback when `SUDO_USER` is absent; falls back to `root` if neither exists. |
| `NODE_ENV` | Set to `production` in the container image for runtime dependencies; the bot has no separate behavior switch for it. |

## Access and security

### Bot-authored GitHub contributions

The optional [GitHub contribution tools](docs/github-contributions.md) let
authorized Discord users propose and revise draft PRs in the AI Assistant and
Docker repositories using dedicated bot identities. A publisher App has PR-write
and content-read access upstream; a separate writer App can change only the
selected contribution forks. Neither gets upstream content-write or merge access.
The existing bot host holds credentials outside the agent sandbox.

Enable with `AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS=true` in shared mode and a
protected `GITHUB_CONTRIBUTIONS_CONFIG_FILE`. `GITHUB_CONTRIBUTIONS_ACCESS=granted`
(default) uses explicit `github.contribute` grants or the `contributor` rights
preset; `chat` admits everyone already allowed to chat. See the linked guide for
App setup, limits, and recovery. Dependabot's existing merge path is unchanged.

Optional [linked GitHub actions](docs/github-contributions.md#linked-github-actions-in-discord)
add Discord buttons for approving, merging, and releasing bot contributions.
Each person links their own GitHub account with `/github link`; no action uses
another person's identity. Contributors may approve; explicit bot administrators
or `github.merge` / `github.release` rights control the privileged buttons.
GitHub repository permissions still apply. Enable with
`AI_ASSISTANT_ENABLE_GITHUB_ACTIONS=true` and a separate device-flow App's
`GITHUB_USER_APP_CLIENT_ID`. The model has no access to user tokens or these actions.

| Variable | Default / accepted values | What it does |
| --- | --- | --- |
| `GITHUB_CONTRIBUTIONS_PUBLISH_LIMIT` | `20`; non-negative safe integer | Publish attempts per response, including failed attempts. `0` means unlimited. Other tool budgets are independent and unchanged. |
| `CODEX_REVIEW_LIMIT` | `20`; non-negative safe integer | Server-side Codex review attempts per PR, including failed/interrupted attempts, retained across turns and restarts. `0` means unlimited. Enforced independently by the assistant and reviewer. |

For both variables, unset or blank uses `20`; invalid values stop enabled-service
startup. These are operator-only settings, not tool arguments or agent instructions.
Set them in the Compose `.env` (or launching environment); the supplied Compose file
passes the same review limit to both services. Recreate the assistant and reviewer
after changes. Existing shared sessions refresh their limits and instructions on
their next turn. Unlimited removes only the selected quota, not repository/access
restrictions, other tool budgets, timeouts, or the 5,000-record review history caps.
It can consume more of the operator's Codex allowance. A clean current-head review
ends the review loop even when budget remains.

### Discord permissions

With `AI_ASSISTANT_SECURITY_MODE=shared`, incoming DM messages are ignored and all DM slash commands are rejected before execution, including for admins. Server `/ask` is restricted to users in `DISCORD_ADMIN_USERS`, with a global `bot-admin` rights grant, or with an explicit `ask.use` capability grant; the legacy open-admin fallback does not qualify. Discord Administrator permission or the `server-admin` preset alone does not qualify either. Grant `ask.use` to a guild-scoped role to allow private one-shot requests without granting other bot-admin privileges. The normal `chat.use` check still applies, and the optional `workspace` argument still requires `workspace.manage`. This is enforced at runtime, so already registered commands cannot bypass it; `/ask` may still appear in the command picker for non-admins. Restart the bot after changing security mode. Other commands can still return ephemeral responses, and channel/thread visibility still follows Discord permissions.

`DISCORD_ALLOWED_USERS` controls ordinary messages and public slash actions. `DISCORD_ADMIN_USERS` controls administrative slash actions; listed admins can also invoke public slash actions. To let an admin send ordinary messages when the allowlist is nonempty, include them in `DISCORD_ALLOWED_USERS` too.

When the admin list is empty, admin access falls back to the allowed-user list. When both are empty, everyone has both levels of access.

| Access level | Slash actions |
| --- | --- |
| Public | `/ask`, `/chat`, `/reset`, `/history`, `/compact`, all `/plan` actions, and `list`/`current`/`get` under `/model`, `/reasoning`, `/provider`, `/agent`, and `/mode`. |
| Administrative | `/model set`, `/reasoning set`, `/provider set`, `/agent select/deselect`, `/mode set`, all `/workspace` and `/mcp` actions, `/servers`, `/leave`, `/status`, and `/fleet`. Supplying `workspace` to `/ask` or `/chat` also requires admin access. Unknown commands/subcommands default to admin-only. |

Mention-only behavior determines when the bot replies; it does not restrict what tools a permitted user can invoke. Discord search also requires **Read Message History** and **Message Content Intent**. For shared bots, use `DISCORD_ATTACHMENT_MODE=text` to keep non-image uploads out of the agent's executable file inputs.

### Provider security

| `AI_ASSISTANT_SECURITY_MODE` | Intended use | Behavior |
| --- | --- | --- |
| `shared` | Servers with multiple users | Isolates bot secrets, restricts external mutations, and scopes file access to the assigned workspace. |
| `unrestricted` | Private servers whose users are trusted as the operator | Inherits the operator's credentials, connected apps, filesystem access, and provider capabilities. |

The template and setup wizard select `shared`. If the variable is absent, the bot uses `unrestricted` and logs a startup warning. Invalid mode values stop startup.

In shared mode, provider processes receive an explicit environment allowlist that excludes Discord credentials and MCP input secrets. Each adapter enforces additional restrictions:

- **Copilot** uses its `empty` mode with scoped file/search/web tools, read-only external MCP calls, and the host-owned artifact tools. Arbitrary shell, external mutating MCP calls, repository-defined MCP processes, and file access through workspace symlinks are blocked.
- **Codex** retains local shell, build, and test support inside its filesystem permissions. A restricted proxy permits package downloads from `registry.npmjs.org`; Sites additionally allows source pushes to `git.chatgpt-team.site`. Other destinations and broad private-network access remain blocked. Its shell gets a separate environment without provider credentials and a private temporary directory. npm uses that private directory for its cache and does not load the operator's npm configuration. Development runs use a source copy there so npm's hidden files work without relaxing workspace credential and Git restrictions. Hosted web search is configured separately with `CODEX_WEB_SEARCH_MODE`; changing it never expands sandboxed-command networking. Handoff summarization and participation evaluation always disable hosted search. Connected apps default off except known read-only GitHub repository tools; mutating and newly introduced connector tools remain disabled.
- **OpenCode** uses a permission policy that denies tools unless explicitly allowed. Plugins, shell execution, content-wide grep, sensitive paths, and access outside the workspace are blocked.

`AI_ASSISTANT_ENABLE_SITES=true` adds a Codex-only exception to shared mode: Discord users can create, update, and publish Sites as the logged-in ChatGPT account. It permits workspace-root `.openai` metadata and stages current site files in a fresh temporary Git repository; existing `.git` directories and history remain blocked. Other apps remain restricted and destructive connector actions remain blocked. In unrestricted mode, Sites follows the operator's normal Codex configuration.

Read-only connectors can still expose repository contents, and permitted users can consume model quota. Set the Discord access lists to match the audience you trust with those capabilities. Provider tool permissions are separate from conversational instructions.

### Container isolation

The included Compose deployment mounts only the Docker-managed `/data` volume. Shared-mode provider tools are rooted at `/data/workspaces`, outside the adjacent provider login and session state. CLI logins persist in the volume; host credentials are not automatically inherited.

Container networking remains available for Discord, model APIs, and hosted tools. Provider restrictions can independently deny network access to local agent commands.

Keep the provided isolation intact for a shared bot: host bind mounts, the Docker socket, privileged mode, or host networking can weaken the boundary. Docker and the host kernel remain part of that boundary and should be kept patched.

## Managing your installation

### Run as a service

On Linux or WSL with systemd, install the service after completing global CLI setup:

```bash
ai-assistant install-service
sudo systemctl start ai-assistant
sudo journalctl -u ai-assistant -f
```

The installer enables startup on boot; the service restarts on failure. After changing configuration, run `sudo systemctl restart ai-assistant`.

### Update

Use the commands for your installation method, then restart the running bot. Register slash commands again after command changes.

| Installation | Update | Register commands |
| --- | --- | --- |
| Global npm | `npm install -g --install-links github:Rubiss-Projects/ai-assistant` | `ai-assistant register` |
| Source checkout | `git pull` followed by `npm install` | `npm run register` |
| Docker | `docker compose pull` followed by `docker compose up -d` | Automatic on start unless disabled; manually use `docker compose run --rm assistant node /app/dist/scripts/register-commands.js`. |

`ai-assistant update` prints the npm update command; it does not install the update. For a native foreground process, stop it and run the start command again. For systemd, run `sudo systemctl restart ai-assistant` after updating.

### Persistent data

| Data | Native location | Docker location |
| --- | --- | --- |
| CLI configuration | `~/.ai-assistant/.env` or the configured CLI directory | Values passed from the project `.env` |
| Provider selections, session mappings, server memories | `~/.config/ai-assistant/` | `/data/.config/ai-assistant/` |
| Provider credentials and provider-owned session state | Provider home/configuration directories | Provider directories within `/data` |
| Agent workspaces and retained output files | Configured workspace root in shared mode | `/data/workspaces/` |

`.env` is git-ignored. Provider CLI logins are stored in their own directories, so credentials are not limited to `.env`.

### Uninstall

For a global npm install, first stop and remove the systemd service if you installed it:

```bash
sudo systemctl stop ai-assistant
sudo systemctl disable ai-assistant
sudo rm /etc/systemd/system/ai-assistant.service
sudo systemctl daemon-reload
```

Then remove the package:

```bash
npm uninstall -g ai-assistant
```

For Docker, `docker compose down` removes the containers while retaining the data volume. Add `--volumes` only if you intend to delete persisted CLI logins, sessions, memories, and agent files; the host-side `.env` and its secrets remain. Native configuration and state also remain after uninstall; remove the directories listed above only if you intend to discard that data.

## Development

For production releases, use the [AI Assistant deployment skill](.agents/skills/deploy-ai-assistant/SKILL.md). It covers PR review, release publication, Docker repository promotion, and runtime verification.

After [installing from source](#run-from-source), use `npm run build` to compile TypeScript and `npm test` to run the test suite.

### Developing from the bot's sandbox

Keep edited source in the assigned workspace. From that checkout, stage the current files in the session's private scratch directory, where npm's hidden files and executable dependencies can work across shell calls:

```sh
build_dir=$(mktemp -d "$TMPDIR/ai-assistant-check-XXXXXX")
cp -R src scripts tests package.json package-lock.json patch-deps.cjs tsconfig.json "$build_dir/"
(cd "$build_dir" && npm ci --include=dev --no-audit --no-fund --fetch-retries=0 && npm run check)
# Copy any needed build artifacts back to the workspace, then remove this staging copy.
rm -rf "$build_dir"
```

`check` runs the TypeScript build and the complete test suite with a temporary home directory for test state. It bypasses the outbound proxy only for localhost test fixtures; on Linux these stay inside the sandbox's network namespace. Tests run two files at a time to stay within the container's process limit. Linux Unix sockets are enabled inside the filesystem sandbox for local fixtures; host filesystem sockets and host loopback remain inaccessible. Keep install scripts enabled: native dependencies and the Copilot SDK patch need them.

The container includes Python, Make, a C++ compiler and Node headers; `NPM_CONFIG_NODEDIR=/usr/local` uses those headers without another download host. `AI_ASSISTANT_CODEX_TMPDIR=/data/codex-tmp` places private session directories on executable storage, while `/tmp` remains `noexec`. Each session gets its own directory, removed on reset/shutdown. Abrupt container termination can leave scratch directories on the data volume. On native installations, provide equivalent tools and headers; this setting defaults to the operating-system temporary directory. Do not replace a failed build with TypeScript stripping and report it as type-checked.

Use temporary state and fake providers for local application checks. Live Discord/Slack or model-provider checks require separate test credentials and explicit authorization; production credentials are not exposed to the shell. Docker image builds stay in CI, without a Docker socket in the bot container. Packages with additional download hosts remain blocked until the host policy is reviewed.

The container CI also runs `scripts/smoke-codex-development.ts`: it copies a clean checkout, installs dependencies, builds and runs all tests through the production Codex sandbox in separate shell invocations. It requires no model calls or bot login, and checks that credential files and unapproved destinations remain inaccessible.

### Project structure

```
src/
  index.ts              # Entry point — loads .env, starts bot
  bot.ts                # Discord client, command routing, message & thread handling
  commands.ts           # Slash command definitions (unified command set)
  cli.ts                # ai-assistant CLI (setup/start/register/install-service/update)
  sessionManager.ts     # Facade — routes each session to its active provider
  providers/
    types.ts            # Provider interface + shared types + UnsupportedError
    copilot.ts          # Copilot SDK adapter (GitHub Copilot)
    codex.ts            # Codex SDK adapter (OpenAI Codex)
    opencode.ts         # OpenCode CLI adapter
    index.ts            # createProvider() factory (reads PROVIDER env)
  common/
    chunkForDiscord.ts  # Chunk text for Discord's 2000-char limit
    sessionStore.ts     # Persist Discord key → provider session ID (per provider)
    providerStore.ts    # Persist Discord key → active provider override
    mcpConfig.ts        # VS Code-style MCP config loader/status
  handlers/
    mention.ts          # @mentions, free-channel messages, bot-owned thread messages
    slash/              # One handler per slash command
  utils/                # Attachment download + Discord message-link resolution
scripts/
  register-commands.ts  # One-time slash command registration
patch-deps.cjs          # Copilot SDK ESM patch (runs on install)
.github/workflows/      # CI, release, and dependabot automation
ai-assistant.service    # systemd unit template (%%PLACEHOLDER%% vars, patched by install-service)
.env.example            # Environment variable template
```

### Adding a provider

1. Implement the [`Provider`](src/providers/types.ts) interface in a new file under `src/providers/`.
2. Register it in the [`createProvider()`](src/providers/index.ts) factory.
3. Add it to the `PROVIDERS` list and the CLI wizard (`src/cli.ts`).
4. Any method you can't implement throws `UnsupportedError`, and the matching slash command automatically reports "provider does not support X".


### Channel summaries

The agent interprets natural-language catch-up requests and invokes `fetch_channel_history` through the shared host-tool bridge. Exact wording and link placement are not required: “can you give a summary of everything since this message?” followed by a message link, or “here is the link; catch me up from there”, can select the same range. The tool is available in server mentions, `/chat`, and permitted `/ask` across providers. It uses the current artifact run ID, allows at most three calls per response, and binds the requester, channel, and cutoff to the host invocation. It is unavailable for DM, scheduled, and internal ephemeral history retrieval.

Tool arguments select one range: `previous_message`, `after_message` with `message_url`, `recent` with optional `count`, or `relative_time` with `amount` and `unit` (`minutes`, `hours`, or `days`). Numeric arguments are decimal strings. The host validates bounds, links, permissions, and author filtering. The agent asks for clarification instead of dropping unsupported or conflicting constraints. A legacy wording hint still suppresses ambient context for recognized summary phrases; it no longer retrieves history or selects the interval. History returned by the tool contains attachment counts only.

Mention the bot in the channel to catch up on its conversation, or use the same request with `/chat` (and `/ask` where permitted):

- `@Rook summarize everything since my last message`
- `@Rook summarize the last 50 messages`
- `@Rook recap messages from the last 2 hours`
- `@Rook summarize messages since https://discord.com/channels/GUILD/CHANNEL/MESSAGE`

The bot retrieves messages chronologically from the channel where the request is made. “Since my last message” finds the requesting user’s most recent message before the request, including when the request says “at 1:37”; it uses the actual message rather than guessing a timezone. A starting message link must be from that same channel and is excluded from the summary. Bare clock times or other unsupported date ranges ask for an unambiguous range. With no range, the default is the latest 100 messages.

Each request scans at most 1,000 messages, in pages of up to 100, and includes at most 60,000 characters of source records. Recent-message counts apply before author filtering. Retrieval or text truncation is reported as partial coverage. If the user’s previous message cannot be found within the scan limit, the bot asks for a starting link or recent-message count instead of claiming to summarize everything.

Both requester and bot need View Channel and Read Message History; private threads also require verified membership or Manage Threads. Existing context-author rules apply, bot messages are omitted, and attachments are counted without downloading or interpreting their contents. Summary records are untrusted quoted data; links inside retrieved history do not trigger additional link expansion. No new slash-command registration or configuration is needed.

The shared session-context registry includes the durable summary instructions and static capability contract for conversation and one-shot (`/ask`) profiles. After deployment, existing conversations refresh through the provider's context lifecycle on their next turn. Changes to policy, retrieval limits, or the explicit behavior revision change the fingerprint; request-specific messages, identities, timestamps, and anchors do not. Scheduled and internal ephemeral profiles do not advertise this host enrichment.
