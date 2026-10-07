# claude-code-to-responses

A stateful OpenAI Responses API server in front of Claude Code. A client sends new input items against a `previous_response_id`; the gateway drives one Claude
Code process per conversation chain, holds Claude Code's tool calls until the client posts their outputs, and can kill and rebuild that process without losing
the prompt cache. To the client it is just another Responses endpoint.

Measured on **Claude Code 2.1.284**, the only version the gateway accepts (it checks `claude --version` at startup).

## Run it

```sh
CLAUDE_CODE_OAUTH_TOKEN=… deno run -A src/main.ts \
  --state-dir ~/.local/state/claude-code-to-responses \
  --claude ~/.wuhu/vendors/claude/2.1.284/claude
# or: deno task compile, then .state/bin/claude-code-to-responses with the same options
```

| Option                 | Default                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--listen host:port`   | `127.0.0.1:18330`                           | Responses API address. Off loopback the gateway refuses to start without `--auth-token-env`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--auth-token-env VAR` | none                                        | Clients must send `Authorization: Bearer $VAR` (`401 invalid_api_key` otherwise). The token is read from the environment, never from argv.                                                                                                                                                                                                                                                                                                                                                              |
| `--state-dir`          | required                                    | Response store (`responses/`, `tails/`), the gateway's Claude Code config folder and scratch home (`claude/config`, `claude/home`), its device id (`device-id`), per-process files (`run/`).                                                                                                                                                                                                                                                                                                            |
| `--work-dir`           | `/tmp/claude-code-to-responses`             | The one working folder of every session. Keep it the same absolute path on every machine; it must be outside any git repository (checked at startup). Claude Code reports its real path (`/private/tmp/…` on macOS).                                                                                                                                                                                                                                                                                    |
| `--device-id`          | generated once into `<state-dir>/device-id` | The Claude Code device id every session sends in `metadata.user_id` (also `CLAUDE_CODE_TO_RESPONSES_DEVICE_ID`). 64 lowercase hex digits, or a startup error. Give the same id to every gateway that should share a backend cache.                                                                                                                                                                                                                                                                      |
| `--claude`             | required                                    | The Claude Code 2.1.284 binary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--bridge-port`        | any free port                               | Loopback port Claude Code calls for MCP tools and hooks.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--tz`                 | `UTC`                                       | `TZ` of every Claude Code process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--idle-timeout`       | 1800 s                                      | Kill a process that sits at a finished turn this long.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--hold-timeout`       | 600 s                                       | Kill a process whose held tool calls wait this long.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| (startup)              |                                             | Takes the state dir's lock (`gateway.lock`, naming the holder by pid, start time and executable): a second gateway on the same state dir is refused with a startup error. Then kills the Claude Code processes a crashed gateway left behind: each run folder records its process's pid, executable and the time window of its spawn, written in the same synchronous step as the spawn, and only a process matching all three is killed. The one gap is a gateway killed between those two statements. |
| `--verify-logs`        | off                                         | After each process exits, check its log starts with the stored records, byte for byte (the tests turn it on).                                                                                                                                                                                                                                                                                                                                                                                           |

The backend comes from the gateway's own environment, and exactly one must be configured (a startup error otherwise):

- **`CLAUDE_CODE_OAUTH_TOKEN`**: the only production backend, a subscription token from `claude setup-token`.
- **Test only:** `ANTHROPIC_BASE_URL` with `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, for the fake endpoint and DeepSeek. The gateway says so at startup.

Only these variables reach Claude Code. No login stored in a config folder is supported or read, and the gateway never reads `~/.claude`.

## The API: a subset of OpenAI Responses

- `POST /v1/responses` with `stream: true`. Accepted: `model`, `instructions` (required), `tools` (function tools), `input` (a string, or `message`,
  `function_call`, `function_call_output` and `reasoning` items), `previous_response_id`, `reasoning.effort` (`low`, `medium`, `high`, `xhigh`, `max`; default
  `high`), `metadata`, and the neutral values of `store`, `tool_choice` (`auto`), `parallel_tool_calls`, `truncation`, `text`, `include`
  (`reasoning.encrypted_content`), `service_tier`, `user`, `prompt_cache_key`, `safety_identifier`.
- Anything else is a `400` with `code: unsupported` and the offending `param`: other tool types, `strict: true`, `store: false`, `background`,
  `max_output_tokens`, `temperature`, `top_p`, non-text output formats, `system` or `developer` messages, item references, images outside base64 data URLs,
  images in notices.
- `POST /v1/responses/{id}/cancel` cancels a response in progress and returns it. An id the gateway never saw is a `404 not_found`; a response that is no longer
  streaming is a `409 response_not_in_progress`. A cancelled response ends with `response.failed`, status `cancelled`, code `cancelled`, and is not a
  continuation point: the client goes on from the last completed response.
- Errors use OpenAI's shape `{"error": {"message", "type", "param", "code"}}`. Before streaming they are HTTP errors; once streaming they end the response with
  `response.failed`. Every code:

  | Code                                                                                                                        | When                                                                                                                                       |
  | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
  | `invalid_request`                                                                                                           | A malformed request (missing `model` or `instructions`, wrong types).                                                                      |
  | `unsupported`                                                                                                               | A field or value outside the subset (above).                                                                                               |
  | `invalid_api_key`                                                                                                           | `401`: the bearer token is missing or wrong (with `--auth-token-env`).                                                                     |
  | `previous_response_not_found`                                                                                               | The id is unknown, or `instructions`, `tools`, `model` or effort changed (a new Claude Code session): send the full history instead.       |
  | `invalid_function_arguments`                                                                                                | A history `function_call` whose arguments are not a JSON object.                                                                           |
  | `invalid_provider_record`                                                                                                   | A malformed provider record in the history.                                                                                                |
  | `unexpected_reasoning_item`                                                                                                 | A reasoning item next to new input that the gateway did not issue in this conversation.                                                    |
  | `missing_tool_output`, `unexpected_tool_output`                                                                             | The outputs don't match the calls the conversation waits on.                                                                               |
  | `tool_output_too_large`                                                                                                     | An output over 500,000 characters (Claude Code would move it to a file).                                                                   |
  | `conversation_busy`                                                                                                         | `409`: another response of the conversation is streaming or starting.                                                                      |
  | `not_found`, `response_not_in_progress`                                                                                     | Cancel of an unknown response, or of one that is no longer streaming.                                                                      |
  | `shutting_down`                                                                                                             | `503`: the gateway is stopping.                                                                                                            |
  | `cancelled`                                                                                                                 | The response was cancelled (by the cancel route or a client that went away).                                                               |
  | `context_length_exceeded`                                                                                                   | Claude Code hit its blocking context limit; auto-compaction is off, so compaction is the client's job.                                     |
  | `upstream_invalid_request`, `upstream_authentication_error`, `rate_limit_exceeded`, `upstream_overloaded`, `upstream_error` | The backend answered 400, 401/403, 429, 529 or 5xx. Claude Code's own retries are off: the client's retry policy is the only one.          |
  | `upstream_stream_cut`                                                                                                       | The model stream broke mid-message; streamed output cannot be withdrawn.                                                                   |
  | `malformed_model_message`, `unexpected_tool`, `unexpected_block`                                                            | The model stopped for tool use without a tool call, called a tool that isn't a client tool, or sent a block type the subset doesn't carry. |
  | `turn_ended_without_message`, `notice_undelivered`, `record_incomplete`                                                     | Claude Code ended a turn without a model message, called tools again before staged notices could go in, or did not log what it streamed.   |
  | `unexpected_control_request`                                                                                                | Claude Code asked the host something (a permission prompt) it should never need.                                                           |
  | `claude_code_exited`, `claude_code_killed`, `claude_code_stdin`, `claude_code_error`                                        | The process exited, was killed, could not be written to, or ended the turn with an error of its own.                                       |
  | `internal_error`                                                                                                            | A bug in the gateway; the process is killed and the next request rebuilds.                                                                 |
- Events are the standard streaming events: `response.created`, `response.in_progress`, `response.output_item.added` / `.done`, `response.content_part.added` /
  `.done`, `response.output_text.delta` / `.done`, `response.reasoning_text.delta` / `.done`, `response.function_call_arguments.delta` / `.done`, and one final
  `response.completed`, `response.incomplete` (the model hit its output limit) or `response.failed`.
- Output items: Claude's thinking blocks become `reasoning` items (text in `content`, the signature in `encrypted_content`); text blocks become assistant
  `message` items; tool calls become `function_call` items whose `call_id` is Claude's `tool_use` id. The last item is always one `reasoning` item whose
  `encrypted_content` is the **provider record** (below). Store the items and send them back unchanged. With `previous_response_id`, the gateway's own reasoning
  items may come back next to the new input and are ignored (they are the state the id names); any other reasoning item there is a
  `400 unexpected_reasoning_item`.
- Usage: `input_tokens` is uncached + cache-read + cache-written input, `input_tokens_details.cached_tokens` is Anthropic's `cache_read_input_tokens`, and
  `usage.anthropic` holds the raw numbers, summed over the model messages of the response.
- Each response object carries `x_gateway`: how it reached Claude Code (`new`, `live`, `store`, `history`), how many records a history rebuild used, how many
  groups it had to synthesize, and the resume path.

## How it works

**Chains.** A chain is one Claude Code session: fixed `instructions` (passed as `--system-prompt-file`, kept off argv, which Claude Code snapshots on the first
request), tools, model and effort. Every session runs in the one working folder (`--work-dir`); with no native tools it only shows up in the environment block,
which therefore reads the same in every conversation and on every machine. All sessions share the gateway's Claude Code config folder
(`<state-dir>/claude/config`); each session's log is `projects/<working folder>/<session>.jsonl` there. A test runs five chains in parallel and checks every log
against its records and the shared `.claude.json` for corruption.

**metadata.user_id.** Claude Code sends `metadata.user_id` with every request: its device id and the session id. It takes the device id from its config folder's
`.claude.json` (`userID`) and generates one only when there is none (probed). The device id is a gateway setting (`--device-id`, else generated once per state
dir), seeded into the shared `.claude.json` before every launch; the session id survives every rebuild. So a chain sends the same `metadata.user_id` live, after
a store rebuild, and after a history rebuild on a fresh state dir configured with the same id, and a cache keyed on it (DeepSeek's, see below) follows the
conversation. Records carry the device id for diagnosis only: a history recorded under another id rebuilds with the same model bytes (only `metadata.user_id`
differs) and logs a `device_mismatch`; it is never an error and never re-seeds.

**Tool rounds.** The request's tools are served to Claude Code as MCP tools (`mcp__fn__<name>`) by a loopback HTTP server inside the gateway. Claude Code calls
them while the model message is still streaming, one at a time; every call is held, keyed by its `claudecode/toolUseId`. The response ends at the model's
`message_stop` with every `function_call` in it, never at the first MCP call. The next request's `function_call_output` items release the held calls by id, in
whatever order Claude Code makes them.

**Notices.** `message` items sent alongside outputs are notices (text only; a blank one, empty or whitespace, is treated as absent). They are staged before any
result is released and go in through the PostToolUse hook of the response's last call. If that hook never runs (Claude Code answered the call itself, e.g. an
unknown tool), they go in at the end-of-turn Stop hook, and the inference that follows is part of the same response. With no held calls, new `message` items go
in through stdin as one user turn.

**Undefined tools.** A model call of a tool the request doesn't define is answered by Claude Code itself, with its
`<tool_use_error>Error: No such tool available: …` result. The client still receives the `function_call` and must send an output; the model never sees that
output. A rebuild after an eviction during such a hold keeps Claude Code's own entry, so the model sees the same thing on every path. Completed calls in a
history keep the client's outputs, whatever tools the request offers.

**Provider records.** A response's record is every line Claude Code wrote to its session log since the previous response, read verbatim from the log file, so
`log(response) = log(previous) + record`. `--session-mirror` tells the gateway when Claude Code has logged what it streamed; the file is the truth, so a line
Claude Code writes only to disk reaches a record too. A response that ends the model's turn completes at the turn's result, once Claude Code has logged its
end-of-turn hook, so the record holds the whole turn; one that ends in tool calls completes at `message_stop`. Records live in the response store (one file per
response under `<state-dir>/responses`, owner-only) and travel with the response in `encrypted_content` (gzip + base64, not encrypted). A record from the client
is checked field by field (the session must be a UUID, the device id 64 hex digits, links must be response ids, entries single-line JSON objects) before
anything touches a file; a malformed one is a `400`.

**Eviction and rebuild.** A process is killed after `--idle-timeout` at a finished turn, after `--hold-timeout` holding calls, on cancel, and on any failure.
Killing only ends the gateway's wait: the client's tools keep running. Anything Claude Code logged after the last response (its tail) is stored with that
response and carried into the next record; a cancelled or failed attempt is never kept. A chain is reserved from the moment a request names it until the
response is attached, so simultaneous requests never rebuild it twice. The next request then rebuilds:

- A known `previous_response_id` rebuilds the log from the store and resumes with `--resume`.
- Without one, the gateway reads the history: each response group's record must continue the previous one (same chain and session, `prev` link, and a digest of
  the items it covers). The longest such run is written verbatim; items without a usable record are **synthesized** as plain log entries, which makes that
  request a cold cache miss (expected). The next response's record covers the synthesized part, so later rebuilds are warm again.
- When the log stops at held calls, the gateway appends the tool results plus one user text, and resumes with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`. The text
  is the notices that came with the outputs, else the fixed line `Continue from where you left off.`. It lands in that response's record, so every later rebuild
  repeats it exactly.
- Each process gets a random epoch in its MCP and hook URLs; a call from a killed process finds no epoch and is rejected (`410`), so it can never reach the
  process that replaced it. An MCP call for a tool_use id the model never produced is refused; a duplicate call of one id gets the same output.

## Claude Code pins (measured on 2.1.284)

Every pin in this table is asserted by the per-release probe (`deno task probe`, `probe/probe_test.ts`), most of them paired with a run that drops the pin to
show its effect; three more variables are set without being verified (below the table). The source of truth is `src/claude/pins.ts`.

| Flag or variable                                                        | Value                                                  | Why                                                                                                                                                                                                                                                                  | Probe                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `-p --input-format stream-json --output-format stream-json --verbose`   |                                                        | Headless, streaming JSON in and out                                                                                                                                                                                                                                  | headless stream-json …                                             |
| `--include-partial-messages`                                            |                                                        | Stream events, so the response streams and ends at `message_stop`                                                                                                                                                                                                    | headless stream-json …                                             |
| `--session-mirror`                                                      |                                                        | `transcript_mirror` frames carry every log line verbatim, in order (the provider records)                                                                                                                                                                            | headless stream-json …                                             |
| `--model`, `--effort`                                                   | request `model`, `reasoning.effort`                    | Fixed per chain                                                                                                                                                                                                                                                      | headless stream-json …                                             |
| `--system-prompt-file`                                                  | a 0600 file holding `instructions`                     | Replaces Claude Code's default prompt, byte for byte as `--system-prompt` would, without putting it on argv where every local user could read it. Claude Code still prepends its billing header and "You are a Claude agent, built on Anthropic's Claude Agent SDK." | `--system-prompt-file` … (paired with `--system-prompt`)           |
| `--tools ""` (passed once)                                              |                                                        | No native tools, no Skill tool: the request's tools are the only tools                                                                                                                                                                                               | `--tools ""` … (paired with `default`)                             |
| `--permission-mode dontAsk` + settings `permissions.allow: ["mcp__fn"]` |                                                        | MCP calls run without a permission prompt                                                                                                                                                                                                                            | every probe: no `control_request`                                  |
| `--setting-sources ""`                                                  |                                                        | No user or project settings (hooks, env, permissions), and no user or project MCP servers                                                                                                                                                                            | `--setting-sources ""` … (two probes, each paired)                 |
| `--settings <file>`                                                     | gateway-written                                        | The gateway's own hooks: PostToolUse, PostToolUseFailure, Stop (HTTP)                                                                                                                                                                                                | headless …, Stop hook …                                            |
| `--strict-mcp-config --mcp-config <file>`                               | gateway-written                                        | Only the gateway's MCP server (`fn`, HTTP, `timeout: 2147483647`), even with settings open                                                                                                                                                                           | `--strict-mcp-config` … (paired, planted user and project servers) |
| `--session-id` / `--resume`                                             | chain's session                                        | New session, or a rebuilt log                                                                                                                                                                                                                                        | headless …, a log rebuilt …                                        |
| MCP server `timeout`                                                    | `2147483647`                                           | The longest Claude Code accepts; holds end by eviction, never by this                                                                                                                                                                                                | MCP server timeout … (65 s hold)                                   |
| MCP tool `_meta["anthropic/maxResultSizeChars"]`                        | `500000`                                               | Results up to 500,000 characters stay inline, never moved to a file (the gateway refuses longer outputs)                                                                                                                                                             | anthropic/maxResultSizeChars … (paired)                            |
| `HOME`, `CLAUDE_CONFIG_DIR`                                             | `<state-dir>/claude/home`, `<state-dir>/claude/config` | Isolation; one config folder for the gateway, which holds every session's log                                                                                                                                                                                        | headless …                                                         |
| `.claude.json` `userID` in the config folder                            | the gateway's device id, seeded                        | Claude Code uses it as `metadata.user_id`'s `device_id` instead of generating one                                                                                                                                                                                    | a device id seeded as userID … (paired with a fresh folder)        |
| `TZ`                                                                    | `--tz`                                                 | Decides the date Claude Code announces                                                                                                                                                                                                                               | TZ decides the date …                                              |
| `ENABLE_TOOL_SEARCH`                                                    | `false`                                                | MCP tools load eagerly, in every request                                                                                                                                                                                                                             | ENABLE_TOOL_SEARCH=false … (paired with `true`)                    |
| `DISABLE_AUTO_COMPACT`                                                  | `1`                                                    | The client is the only compactor; at the limit the turn ends as `blocking_limit`                                                                                                                                                                                     | DISABLE_AUTO_COMPACT=1 … (paired)                                  |
| `CLAUDE_CODE_TOTAL_TOKENS_REMINDER`                                     | `off`                                                  | No usage-dependent `<total_tokens>` lines in the prompt                                                                                                                                                                                                              | CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off … (paired)                   |
| `CLAUDE_CODE_SILENT_TURN_REMINDER`                                      | `0`                                                    | No "The user hasn't heard from you in a while" after silent tool rounds                                                                                                                                                                                              | CLAUDE_CODE_SILENT_TURN_REMINDER=0 … (paired)                      |
| `MAX_MCP_OUTPUT_TOKENS`                                                 | `1000000`                                              | Lifts Claude Code's 25,000-token cap on MCP results. With the size annotation a 500,000-character result stays inline even without it, so it is a backstop                                                                                                           | MAX_MCP_OUTPUT_TOKENS … (paired, without the annotation)           |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`                                   | `1` on the held-call resume only                       | Resumes the turn from tool results + user text with nothing foreign                                                                                                                                                                                                  | CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1 … (paired)                   |
| `CLAUDE_CODE_MAX_RETRIES`                                               | `0`                                                    | An upstream error ends the turn at once as `terminal_reason: api_error` with `api_error_status`; the client owns retries                                                                                                                                             | CLAUDE_CODE_MAX_RETRIES=0 … (paired: unset retries)                |

Set but **not verified** by the probe:

- `PATH=/usr/bin:/bin`, so any helper Claude Code starts finds the system tools; the rest of the environment is cleared. Nothing the gateway uses spawns one (no
  native tools; hooks and MCP are HTTP), and with `PATH` unset the model sees the same prompt (measured), so there is no effect to assert.

- `DISABLE_AUTOUPDATER=1`. In 2.1.284 the updater fetches from a fixed `https://downloads.claude.ai/claude-code-releases` that no flag or variable redirects, so
  no test can offer it an update without letting Claude Code reach Anthropic.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The fake endpoint sees the same requests with or without it (measured: the conversation's own and one
  `GET /api/hello`); what it turns off in 2.1.284 (telemetry, the model catalog and plugin downloads from fixed Anthropic hosts, and auto-updates as well) never
  goes to `ANTHROPIC_BASE_URL`.

All three are hygiene only; nothing in the gateway depends on them.

Claude Code internals the gateway also relies on, asserted by the probe: the log a process mirrored resumes into a byte-identical request
(`a log rebuilt from the mirrored entries …`), and a resumed log missing the `atis-latch` line gets one written outside the mirror, so synthesized logs include
it (`a resumed log without the atis-latch line …`).

Not pinned on purpose: `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS` (unset means no age limit on resuming a held call in 2.1.284),
`CLAUDE_CODE_OVERRIDE_DATE` (no effect in 2.1.284), the prompt-cache TTL variables.

## Tests

```sh
deno task test        # the gateway on the fake Anthropic endpoint (no network, no secrets)
deno task probe       # the per-release probe of every pin (about 80 s; one test holds a call for 65 s)
deno task test:deepseek   # real tool rounds on DeepSeek's Anthropic-compatible endpoint; needs DEEPSEEK_API_KEY
```

Tests launch the real Claude Code 2.1.284 at `~/.wuhu/vendors/claude/2.1.284/claude` by default; set `CLAUDE_BINARY` to use a different install (for example
`CLAUDE_BINARY=$PWD/.state/vendors/claude/2.1.284/claude deno task test`). The probes use the same setting. The binary must still be 2.1.284. Processes are
isolated under `.state/`, with working folders under `/tmp/cc2r-test`. They use ports 18300-18399 and fail if any Claude Code process outlives them.

The byte assertions (`test/core_test.ts`, `test/hold_test.ts`, `test/matrix_test.ts`): one conversation runs twice, once on a single live process and once with
idle evictions, a gateway restart that keeps the store and one that loses it (full-history rebuild from records); every request the model receives is
byte-identical (working folder normalized). Around each disruption, the next request repeats the one before it up to the new tail. The matrix adds parallel
calls released out of order, notices mid-turn, at a turn start and at the end-of-turn hook, eviction during a hold (with and without notices, then evicted and
rebuilt again), a midnight via `TZ`, cancellation mid-stream and mid-continuation, a client disconnect, stale-call fencing, typed errors, and two negative
controls: a moved working folder (an environment update at the tail, prefix intact) and a history without records (synthesized, a cache miss, warm again on the
next rebuild).

## DeepSeek

`deno task test:deepseek` runs real tool rounds on DeepSeek Flash through its Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`, model
`deepseek-flash`) with the OpenAI SDK driver: a librarian with `read_doc` and `add` tools, about 5,500 tokens of context, then each kind of eviction. It needs
`DEEPSEEK_API_KEY` and fails without it. Measured 2026-10-07; "prefix" is the share of the previous request's input that DeepSeek reported reading from its
cache on the first request after the eviction (DeepSeek caches in 64-token units). The test requires at least 90%.

| First request after                                                             | Input | Cached | Hit   | Prefix |
| ------------------------------------------------------------------------------- | ----- | ------ | ----- | ------ |
| a live turn start (for comparison)                                              | 2,122 | 1,920  | 90.5% | 92.0%  |
| an idle eviction (store rebuild)                                                | 3,749 | 3,584  | 95.6% | 96.6%  |
| an eviction during a hold (interrupted-turn resume)                             | 5,302 | 3,712  | 70.0% | 98.0%  |
| a gateway restart (store rebuild)                                               | 5,367 | 5,120  | 95.4% | 96.6%  |
| a restart that lost the response store (history rebuild from records)           | 5,461 | 5,248  | 96.1% | 96.5%  |
| a restart on a completely fresh state dir, same `--device-id` (history rebuild) | 5,544 | 5,376  | 97.0% | 98.4%  |

The hold row's hit is lower only because its new tail is a 1,500-token tool result no cache has seen; everything before it was read from the cache.

DeepSeek keys its prompt cache on Anthropic's `metadata.user_id` (Claude Code's device id and the session id): the same request under another device id or
session id reads nothing from the cache (measured directly against the endpoint). The last row is warm because the fresh state dir was configured with the same
device id; with a different one it was a miss (0% cached, measured before the device id was configurable), although the model's bytes are the same. Whether
Anthropic's own cache depends on `metadata` is unknown: no request in this repository goes to Anthropic.

## Known limits

- Images go in only at a turn start (stdin); notices sent with tool outputs are text, since hooks carry text only.
- No per-request `tool_choice`, `max_output_tokens` or forced compaction: Claude Code has no per-request knob.
- A model stream Claude Code retries mid-message fails the response (`upstream_stream_cut`): streamed output cannot be withdrawn. The client retries; the
  rebuild is warm.
- The fake endpoint can't answer what only Anthropic can: first-party tool search, real cache hits and TTLs, real thinking signatures after a rebuild.

## Credits

The design follows the WUHU-133 research (Wuhu space, 2026-10-07). [yetone/magpie](https://github.com/yetone/magpie)'s Claude subscription bridge (MIT) was read
as prior art for driving the real binary with MCP-bridged tools; no code was copied from it. The fake endpoint and launcher started from the research rig.
