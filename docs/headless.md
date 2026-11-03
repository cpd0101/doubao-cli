# Headless backend

`doubao headless` uses Doubao's HTTPS, IM and SSE services directly. It requires Node.js 22+ and an authenticated Doubao account; it does not launch or connect to a browser or desktop app. Headless is implemented for Linux and macOS. It uses private service APIs, which may change.

## Select the backend

```bash
npm install --global doubao-cli@latest
doubao --version
doubao headless login
# Scan the terminal QR with the Doubao mobile app and approve sign-in.
doubao headless sessions list --json
```

- Linux defaults to Headless for unprefixed commands such as `doubao login` and `doubao sessions list`.
- macOS defaults to the desktop app: DoubaoWork when installed, otherwise Doubao, unless `DOUBAO_APP` overrides the app path. Use `doubao headless ...` on macOS.
- `doubao --platform headless ...` uses the standard backend selector on either system; `doubao headless ...` is equivalent. `--app` is retained only for desktop compatibility (`work` or `doubao`); it cannot select Headless.
- `doubao web ...` and `doubao --platform web ...` are compatibility aliases for Headless, including login, help and all task options. They share Headless credentials and profiles; browser login sessions are not imported. Run `doubao web login` if Headless is not signed in. Browser `--target` and `web cdp` commands are unsupported.
- Backend selection and task execution are separate. `--runtime cloud` means cloud execution within Headless; it does not select the Headless backend.

## Sign-in and profiles

```bash
doubao headless login
doubao headless login --cookie-file /secure/doubao-cookie.txt --json
DOUBAO_HEADLESS_COOKIE='session-cookie-header' doubao headless status --json
doubao headless profiles --json
doubao headless status --profile work --json
doubao headless logout --profile work --json
```

Terminal QR login asks the user to scan and approve on the Doubao mobile app. For unattended setup, `--cookie-file` reads a Cookie header, `{ "cookie": "..." }`, or exported cookie array. `DOUBAO_HEADLESS_COOKIE` provides an in-memory credential for ordinary commands; an explicit `login` verifies and saves it to the selected profile. Treat both sources as secrets.

Credentials are stored under the CLI configuration directory in `headless/session.json` for the `default` profile and `headless/profiles/<name>/session.json` for named profiles. Files are written atomically with mode 0600 in directories with mode 0700. Profile names contain 1–64 ASCII letters, digits, `_` or `-`. Model defaults, current conversation, MCP configuration and local-runtime receipts are scoped to the selected profile and verified account. `logout` removes that profile's saved credentials and selection state; it cannot disable `DOUBAO_HEADLESS_COOKIE` in the calling environment.

`profiles` lists Headless profiles and attempts to enrich cached account IDs with live account metadata. The desktop `profiles --json` contract remains separate: it can report account ID, name, account type, enterprise user type and tenant metadata from the selected desktop app profile. A Headless profile is not a macOS desktop profile.

## Sessions and recovery

`sessions list --all` follows every page exposed by the session API and removes duplicate IDs. Success ends with `hasMore: false`; JSON `pages` reports successfully read pages. `source: "api"` identifies a live query; `complete` is true only when the returned list reaches the end without truncation. Desktop uses the same list service, with its current runtime selections overlaid. The observed intermittent server error is retried twice on the same page. Without `--all`, the default total limit is 20, and `--limit` accepts 1–100. The flags cannot be combined. `--timeout` covers the full traversal; timeouts, malformed pages and non-advancing cursors fail rather than returning a partial list as complete. Deleted or inaccessible conversations are outside this API's scope.

```bash
doubao headless sessions list --limit 20 --json
doubao headless sessions list --all --json
doubao headless sessions current --profile work --json
doubao headless sessions open <conversation-id> --profile work --json
doubao headless sessions read <conversation-id> --limit 20 --json
doubao headless sessions create "Hello" --mode chat --wait --json
doubao headless sessions create "Write a plan" --mode work --wait --json
doubao headless sessions send <conversation-id> "Continue" --wait --json
doubao headless sessions status <conversation-id> --run <run-id> --json
doubao headless sessions wait <conversation-id> --run <run-id> --timeout 600 --json
doubao headless sessions stop <conversation-id> --run <run-id> --json
```

Session management uses the same service and readback checks as Desktop:

```bash
doubao headless sessions archive <conversation-id> --json
doubao headless sessions unarchive <conversation-id> --json
doubao headless sessions list --archived --all --json
doubao headless sessions pin <conversation-id> --json
doubao headless sessions unpin <conversation-id> --json
doubao headless sessions rename <conversation-id> "New title" --json
doubao headless sessions move <conversation-id> <project-id-or-exact-name> --json
doubao headless sessions move <conversation-id> none --json
```

Titles are trimmed, non-empty and limited to 20 UTF-16 units, matching the app. Project names must match exactly; ambiguous names require an ID. `none` clears the project reference without moving files. All commands support `--profile` and `--timeout`. A change returns `verified: true` only after server readback; an already-satisfied operation returns `changed: false`. Writes are never automatically retried. Failed confirmation exits nonzero with `verified: false`, an operation ID and the requested change. Listing defaults to active sessions; `--archived` selects archived sessions. JSON rows include `pinned`, `archived` (`null` if unknown), and `projectId`.

New sessions default to cloud Work; choose `--mode chat` for ordinary chat, or `--mode goal` to define a measurable objective. Goal mode uses the 2.32.10 protocol revision and checks the account's `goal_mode_enable` flag before sending. Desktop requires installed Doubao 2.32.10+; Headless requires no app. Follow-ups inherit one active goal; multiple active goals require resolution in Doubao. A completed turn does not establish completion of the whole goal.

`sessions open` and `current` select the CLI's current conversation and do not open a UI. Listing returns recent sessions; `read` returns up to 100 recent messages.

Save both `conversationId` and `runId` from an accepted send. Without `--wait`, create/send returns after acceptance with `reply: null`; Headless starts a background worker to continue local execution when needed. If a process times out or disconnects, use `sessions wait` with the same IDs. Do not resend an accepted request. Recovery reopens the same request with its original message identity. A `waiting_input` task needs a response through Doubao's interactive UI before waiting again. `stop` reports server state and does not undo tool effects; a terminal task can report stopped without having been cancelled.

Headless options are validated against the command contract. Unknown flags, unsupported backend options, and misplaced options fail before a request is sent. Use `--` when a message begins with option-like text. For data-returning commands, `--json` provides machine-readable output.

## Automatic tasks

```bash
doubao headless automations list --json
doubao headless automations get <id> --json
doubao headless automations create --file task.json --json
doubao headless automations update <id> --file patch.json --json
doubao headless automations delete <id> --json
```

These commands also work on Desktop without the `headless` prefix. `--profile` selects the account; `--timeout` bounds the whole operation, including pagination and readback.

Example `task.json` (choose a future execution time):

```json
{
  "title": "Review the report",
  "prompt": "Summarize the latest report and list open questions.",
  "timezone": "Asia/Shanghai",
  "runtime_config": { "runtime_type": 1 },
  "schedule": { "repeat_type": 1, "execute_at": "2026-12-01T09:00:00+08:00" }
}
```

Example `patch.json`:

```json
{ "title": "Review the weekly report", "prompt": "Summarize the weekly report." }
```

Runtime types: `1` cloud, `2` a native local device. Local schedules require that device's configuration and availability; Headless does not install a scheduler or start local workers for future tasks. Repeat types: `1` once, `2` hourly, `3` daily, `4` weekly, `5` custom. Daily/weekly schedules use `time: { "hour": 9, "minute": 0 }`; weekly schedules also use `weekdays` (`1` Monday through `7` Sunday). Custom schedules require the service's `parse_token`.

Create requires `title`, `prompt`, and `timezone`. Optional native fields are `schedule`, `runtime_config`, `deep_think_switch`, `model_config`, `parse_token`, `project_id`, `sandbox_auth_type` (`0` AlwaysAsk, `1` AskOnRisk, `2` FullAccess), `local_connector_tools`, and `lark_connector_id`. The default `create_context.bot_id` is the Work bot; the CLI generates a unique `local_job_id` for each submission.

Updates accept `title`, `prompt`, `schedule`, `parse_token`, `sandbox_auth_type`, `local_connector_tools`, and `lark_connector_id`. Connector updates use `{ "value": "..." }` or `{ "clear": true }`. Runtime, model and timezone are fixed at creation by the native update API.

Mutations return `verified: true` only after readback matches. Errors retain a known task ID and an operation ID; inspect `list/get` before repeating an uncertain mutation. Task IDs remain exact strings in CLI output. The list folds the service's change history and omits deleted tasks.

2026-10-15 acceptance: Work 2.32.10 and Headless both completed goal turns in cloud and local runtimes. Headless local also returned a detached submission ACK and subsequently read back as completed; one 60-second wait timed out before that readback. Both backends passed task create/get/update/delete with cross-backend readback. All temporary automatic tasks were deleted; the original eight tasks remained. This verifies turn execution and CRUD, not final goal lifecycle state or future scheduled execution.

2026-10-20 compatibility: Work 2.33.1 passed cloud/local goal turns and automatic-task CRUD. Headless passed CRUD and cloud goals; a goal in a temporary project retained its project binding, and the project was deleted after verification. Headless local waiting now observes the server turn while the tool channel starts, so a goal with no tool calls can complete without waiting for SSE headers. Local no-tool and file-write/readback goals both passed. A repeated file-write test exceeded its 90-second wait, then completed through recovery of the same accepted run without resending. Recovery of an already completed local turn also passed. All temporary automatic tasks were deleted; the original 45 tasks remained.

## Models, reasoning and usage

```bash
doubao headless models --json
doubao headless model --json
doubao headless model current --profile work --json
doubao headless model select 'Orange 5.5' --reasoning high --profile work --json
doubao headless model reasoning max --profile work --json
doubao headless sessions create "Analyze this" --model 'Orange 5.5' --wait --json
doubao headless sessions create "Analyze this" --model '<exact model name>' --reasoning high --wait --json
doubao headless usage --profile work --json
```

The live account catalog determines available models and their eligible modes. `model select` updates the selected conversation when one is selected and also stores defaults for new conversations in that profile/account. The supported reasoning levels are `low`, `medium`, `high`, `xhigh` and `max`. `--model` and `--reasoning` on create/send override the defaults for that request. Usage values and reset information come from the account service; unavailable values may be null.

Pass the exact model name shown by `doubao headless models --json`, including its capitalization and spacing. For example, use `'Orange 5.5'` when that name appears in the live catalog.

## Attachments

```bash
doubao headless sessions create "Summarize these files" --attach ./report.pdf --attach ./diagram.png --wait --json
doubao headless sessions send <conversation-id> "Compare these" --attach ./one.pdf --wait --json
```

Repeat `--attach` for multiple files. The uploader accepts at most 50 files per message, subject to service-side limits, and sends supported local files through Doubao's upload protocol before submitting the message. The CLI resolves and validates paths before upload. Do not place file contents in message text.

## Projects and enterprise knowledge

```bash
doubao headless projects list --json
doubao headless projects create "Research" --workspace /absolute/path --json
doubao headless sessions create "Search the project" --mode work --runtime local --project <id-or-exact-name> --wait --json
doubao headless sessions send <conversation-id> "Search company guidance" --enterprise-knowledge --wait --json
```

Projects can be selected by ID or exact name; `--project none` clears the project for a turn. A duplicate project name must be disambiguated with its ID. Project creation with `--workspace` binds that absolute workspace to the current Headless device and verifies the result. Project selection and enterprise knowledge require Work mode. `--enterprise-knowledge` selects the account's available official enterprise-search skill for that turn; availability is checked before sending.

## Local execution and permission policy

```bash
doubao headless runtimes --json
doubao headless sessions create "Inspect this workspace" --mode work --runtime local --workspace /absolute/path --permission AskOnRisk --wait --json
doubao headless sessions send <conversation-id> "Continue" --runtime local --permission AlwaysAsk --wait --json
```

Headless supports cloud and local execution. Cloud Work is the default. Local execution runs a portable Node worker in this CLI process against the local workspace and Doubao's task service. It is process-based local execution, not the native Doubao app sandbox. Local command delivery has two modes: **`sse`** (default, `/chunk_stream`, `node-sse`) and **`ws`** (Desktop-aligned command WebSocket, `node-ws`). Set `DOUBAO_HEADLESS_LOCAL_TRANSPORT=ws` for the Frontier path. On macOS/Linux, local turns default to a per-profile keep-alive hub: **`sse`** reuses a sticky sandbox id in a warm hub process (`sse-hub.sock`); **`ws`** reuses the Frontier command WebSocket (`frontier-hub.sock`) so follow-up invokes skip cold reconnect. Both hubs keep Desktop-aligned idle heartbeats so the server does not drop the standing connection between turns: **`ws`** sends Frontier text `"hi"` every 15s (4s pong wait, close after 2 losses); **`sse`** holds a standing `/chunk_stream` and re-POSTs after 18s of silence (paused for the turn-owned channel, resumed after). Inspect or stop the hub for the current transport with `doubao headless keepalive status|stop` (supports `--profile` / `--json`). Set `DOUBAO_HEADLESS_FRONTIER_KEEPALIVE=0` to force connect-per-invoke for both. JSON results may include `keepalive: true` and `hubPid` when the hub handled the turn. Workspace selection is shared with Desktop: explicit `--workspace`, then the saved workspace on the same device with an unchanged project, then an applicable project folder, then a new profile workspace. Selecting or clearing a project drops the inherited workspace. `--no-skills` omits the default `~/.agents/skills` path.

`runtimes` reports the actual `hostPlatform`. Model startup can exceed the default 120-second budget; use `--timeout 600` for a longer foreground wait, or recover an accepted timeout using its original IDs.

`--permission FullAccess|AskOnRisk|AlwaysAsk` selects the local task permission policy for local execution and MCP turns. New local conversations default to `AskOnRisk` (Desktop defaults to `FullAccess`); follow-ups inherit the server's saved local permission, including `FullAccess`, unless explicitly overridden. Enabling or inheriting `FullAccess` requires confirmation before submission: type `y` in a TTY, or pass `--yes` on `sessions create` / `send` / `wait`. Consent is per invocation and is not persisted; recovering an unfinished `FullAccess` task with `sessions wait` needs a fresh confirmation or `--yes`.

Tool approvals under `AskOnRisk` and `AlwaysAsk` normally require TTY stdin/stderr and `--wait`. Pass `--yes` to approve them for that create/send/wait without a prompt (including detached no-wait workers that inherit the flag). Without `--yes`, a detached worker cannot ask, so operations needing a prompt are denied. These policies do not create an OS sandbox or confine MCP server processes. Doubao conversation controls such as questions or approvals still require a response in the Doubao UI.

Headless MCP registration keeps all `--env` values in the private local connector store and passes them to the local stdio server; the remote connector registration receives an empty environment. Command paths, arguments, tool descriptions, call arguments, and tool results still reach Doubao. Keep secrets out of those fields. This change does not erase environment values uploaded by earlier versions; rotate previously exposed credentials.

If `--wait` is omitted for a local task, the CLI starts one detached worker before submission. That worker submits the original request, returns the accepted IDs to the CLI, and remains responsible for the request's local HTTP/SSE execution. `sessions wait` uses the same conversation and run IDs and may start a local runtime to recover from the saved receipt. A persistent lease prevents concurrent runtime execution while the original worker is active; after it exits, a later wait can resume recovery. A failed or ambiguous operation should be inspected with `sessions status` or `sessions wait` before any retry.

## MCP connectors

```bash
doubao headless mcp register my-tools --command /absolute/path/to/node --arg /absolute/path/server.mjs --env KEY=value --json
doubao headless mcp list --json
doubao headless sessions create "Use my tool" --mode work --runtime local --mcp <connector-id> --wait --json
doubao headless mcp remove <connector-id> --json
```

Headless registers local stdio servers. Repeat `--arg` and `--env` for additional values; use absolute executable and server paths. Pass `--mcp <connector-id>` on each turn that should expose a connector. MCP selects a local Work task with a message and can be combined with attachments. With `--wait`, this CLI process submits the request and services calls; otherwise one detached worker submits the request and owns its local HTTP/SSE execution and calls. Connector definitions and secrets are profile/account scoped. Verify tool effects from actual service results, and recover accepted timeouts with the original session and run IDs rather than resending.

## 0.17 acceptance (2026-10-12)

The 0.17 implementation passed 357/357 tests on Linux x86_64 with Node 23.7.0 and macOS with Node 22.16.0. Live acceptance used a fresh, isolated Linux candidate installation and an isolated config directory. Linux's authenticated run used a cookie file created from an approved QR session; this does not establish fresh QR login on Linux for 0.17. On macOS, fresh anonymous HTTP QR issuance, phone scan and approval, account verification, and credential persistence passed without importing credentials. Saved credentials were mode 0600; no credential values were printed.

Live business checks completed on the authenticated account:

- Attachment upload and reading passed with a text-file marker and a PNG divided into colored quadrants; the reply identified both file content and image regions.
- A project was created and read back, then selected with enterprise knowledge for a completed cloud task (`38446800478422786`). The test-owned project (`38435854858730242`) was removed and read back absent; three unrelated projects remained.
- A Linux local-runtime task read a marker from its workspace file. A GPT-5.6 Sol local task with a stdio MCP server returned the fixture marker (`38445935542783746`, run `58271629787701250`).
- An existing Linux session switched from local to cloud and back to local, with a changed workspace and `AskOnRisk` policy. The new file marker was read back; the server conversation retained the new runtime, workspace and permission fields.
- The Linux no-wait worker continued a local workspace read plus MCP call in the background. Waiting with the original conversation and run IDs returned a schema-matching reply, and the test-owned connector was removed and verified inactive.

These are source and isolated-candidate acceptance results, not an npm publication or general release-installation claim. Reproduce the live suite from a source checkout with an already authenticated, isolated config directory; use a separate output directory for private receipts and fixtures. Do not use `HOME` as an isolation mechanism.

```bash
umask 077
mkdir -p /tmp/doubao-headless-017-config /tmp/doubao-headless-017-output
DOUBAO_CLI_CONFIG_DIR=/tmp/doubao-headless-017-config doubao headless login
npm run test:e2e:headless -- --config /tmp/doubao-headless-017-config \
  --output /tmp/doubao-headless-017-output --stage all
```

The login command must complete before running the suite. The runner writes sanitized acceptance receipts and synthetic fixtures under `--output`; it does not read or print credential files. The command runs the checked-out source, so the runner is not included in the npm package. Headless uses private service APIs, which may change. Local execution is a process-based Node worker, not an OS sandbox or the native Doubao app sandbox; permission policies govern CLI approval behavior and do not confine MCP server processes. Headless does not use CDP or the desktop app.

If a request was accepted but writing its recovery receipt failed, inspect the structured `recoveryReceipt` and `recoveryReceiptPath` in the error result. After repairing storage, restore that receipt to the stated path with private permissions (0600), then wait on the same conversation and run IDs. Never resend the accepted request; it may already have executed tools.

## Historical acceptance (2026-10-10, CLI 0.15.0)

The dated results below describe the initial cloud-only implementation and remain historical evidence for CLI 0.15.0. The 0.17 acceptance above is separate and does not convert these older checks into 0.17 results.

- Pure Node HTTP: authenticated account lookup, session list, model catalog, new chat, follow-up chat, new cloud Work, model 5 selection and JSON reply validation passed.
- Cloud result: `38446481515031810` / `58110026190228738`, `HEADLESS_CLOUD_OK`. New-conversation identity differed from the source desktop session.
- Chat result: `38446428244786178`; first reply `HEADLESS_CHAT_OK`, follow-up `HEADLESS_FOLLOWUP_OK`.
- Model/JSON result: `38446481494493442` / `58114893028244226`, final `{"ok":true}`, `replyValid:true`.
- Timeout recovery: the original cloud turn was resumed by ID in another process. The final server reply was read without resending.
- Cloud calculation turn: `38446464005040130` / `58115199990398466`; server reply completed; stop read back its terminal completed state. The model's claim that Python ran is not independent proof of tool execution.
- Ordinary-chat cancellation: `38446446463869186` / `58114849878163970`; returned `status:cancelled`, `stopped:true`, verified from server readback. Live nested Work-child cancellation has not been covered.
- Linux QR: fresh anonymous HTTP bootstrap, issuance, phone scan/approval, confirmed polling, account verification and saving the resulting session passed. Generated request IDs were used; no app/browser credentials were imported. The resulting credential file is owned by the CLI user with mode 0600 and parent directories mode 0700.
- Fresh Linux processes with `DOUBAO_HEADLESS_COOKIE` unset reused the QR session for status, seven live models, five recent sessions, chat and cloud Work. Chat `38446481913278466` / `58107226726788354` returned `LINUX_QR_CHAT_OK`; Work `38446363878547202` / `58106696513435650` returned `LINUX_QR_WORK_OK`. Both server states were completed.
- Local Node 22.16.0 and Linux x86_64 Node 23.7.0: the complete suite passed 239/239 on each host, including a fresh Linux `npm ci`. Desktop tests select their intended backend explicitly; Linux default behavior is tested separately.
- Implicit Linux backend selection, unauthenticated status, capabilities and help passed. Installing the 0.15.0 npm tarball into an isolated prefix and invoking its `doubao` executable also passed. No existing account credentials were transferred there. Authenticated HTTP acceptance ran on both Linux and macOS; the HTTP backend did not connect to CDP.

Test side effects: several synthetic acceptance conversations remain in the account. The first raw protocol probe omitted the complete creation metadata, so the service appended a synthetic `HEADLESS_HTTP_OK` test turn to existing conversation `38446393744786434` (question `58110115407994626`). Production requests now include the verified creation metadata. No session was deleted.

These dated source-acceptance results do not establish npm publication or release installation.
