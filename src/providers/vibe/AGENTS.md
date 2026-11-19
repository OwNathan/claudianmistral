# Mistral Vibe constraints

## Shared process and sessions

- One vibe-acp process per runtime host serves every chat tab, model/command discovery, and command probes; all multiplex ACP sessions over it through `acquireVibeSharedRuntime`, which owns the fingerprint, acquire, and shared `initialize` handshake. A runtime-input change (CLI path, environment) swaps the whole process on the next acquire; the workspace transition hook drains in-flight work first.
- vibe-acp `os.chdir`es per `session/new` and `session/load`, so the shared process is sound for one working directory; auxiliary consumers always reuse the execution host cwd. Vibe also refuses a concurrent prompt per session, so each chat session runs one turn at a time and probe/discovery sessions are prompt-less.
- Resume identity is the ACP session id: `session/load` fails closed on a missing session (`Session not found: <id>` → provider-session-missing), and Claudian never rebinding it from history availability. History hydration parses Vibe's on-disk chunk records fail-soft; unreadable chunks are skipped and counted, never an error, and resume still goes through native `session/load`.
- Cancellation calls `session/cancel` only; a cancelled turn never quarantines the shared process another tab may be using.

## Models and reasoning

- The `model` select of the session's config options is the catalog of truth (aliases; locked models are absent). Apply model via `set_config_option` only when it differs from the select's current value; Vibe persists an active-model change natively, so no-op re-application is churn, not safety.
- Thinking is per-model and optional: send `set_config_option("thinking")` only when the session's `thinking` select lists that level (the response after a model switch carries the switched model's levels). A model with no thinking select is resolved metadata with an empty level list — never keep retrying discovery for it.
- Discovery may switch a model and restore it best-effort on one auxiliary session; model warming with no levels is still a resolved outcome.

## Commands, tools, and elicitation

- Commands are read-only runtime catalog data: a prompt-less auxiliary session receives `available_commands_update` shortly after `session/new`; probes wait bounded and fail soft to an empty catalog. Probe sessions answer permissions cancelled and elicitation declined, so discovery can never present chat UI or execute turns.
- Elicitations (Vibe's `ask_user_question`) arrive only because the client advertises form elicitation; they key questions `q0..qN`, carry option labels as consts, and accept free text. Route them through the question UI with the pending-interaction ledger; stale or cross-turn resolutions are rejected and answered as cancelled.
- Vibe streams compaction as a `tool_call` titled `Compacting conversation history...` (kind `other`); treat it as presentation, not a permission target. Tool calls/results stream for every tool, so normalize names from titles/kinds but keep raw payloads lossless.

## Auth and launch

- Authentication is native: never call ACP `authenticate`, persist credentials, or advertise terminal/browser auth flags; the plugin only passes the user's environment through (`VIBE_*`, `MISTRAL_*`) and Vibe resolves its own credentials.
- The launcher aborts when its bundled runtime module is missing; the CLI inspect probe (`vibe-acp --version`) stays launcher-only and must never mask that gate with a fallback or auto-start on settings render. WSL and execution-target installs are not supported; do not add their settings surface back without WSL wire proof.
