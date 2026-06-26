# cc-in-codex

Main Chinese README: [README.md](./README.md)

Local MCP server that gives Codex a persistent Claude Code companion.

The user talks to Codex. Codex delegates implementation work to one long-lived
Claude Code session per project, monitors it, cancels it when needed, and reviews
the result before answering.

This project is built for a local workflow: it uses your installed `claude`
binary and your existing Claude Code login. It does not require a new API key.

## What It Does

- Uses your local Claude Code login and config, including Claude Max accounts.
- Keeps one persistent Claude Code session per `cwd`.
- Lets Codex start, monitor, cancel, resume, and inspect Claude Code work.
- Supports two backends:
  - `sdk`: managed Claude Agent SDK backend for normal background delegation.
  - `tui`: native Claude Code CLI in `tmux`, so you can watch or take over the same full-screen session.
- Persists Claude's session in the normal Claude Code store, so you can resume it from the Claude Code CLI.
- Stores only companion metadata and a recent event buffer under `~/.cc-in-codex/state.json`.

## Requirements

- Node.js 22 or newer.
- Claude Code installed and authenticated locally (`claude --version` works).
- Codex with MCP server support.
- `tmux` for visible TUI mode.

## Tools

- `companion_open`: create or restore a project companion.
- `companion_resume`: bind cc-in-codex to an existing Claude Code session id, or start TUI resume.
- `companion_start`: start a background Claude Code run.
- `companion_wait`: wait for new progress after `companion_start` instead of waiting for the whole task.
- `companion_send`: send a short task and wait for completion.
- `companion_tui_open`: create or restore a visible native Claude Code CLI in `tmux`.
- `companion_tui_resume`: launch visible TUI with `claude --resume <session-id>` or `claude --continue`.
- `companion_tui_send`: paste a prompt into the visible Claude Code CLI and press Enter.
- `companion_tui_raw`: send raw text and/or tmux keys (e.g. `/clear`, `C-c`, `Escape`) to the visible CLI without the cc-in-codex wrapper.
- `companion_tui_compact_check`: decide whether the visible TUI is at a good checkpoint for compacting.
- `companion_tui_compact`: run Claude Code `/compact` with cc-in-codex-aware preservation instructions.
- `companion_tui_screen`: capture recent text from the visible Claude Code CLI.
- `companion_recent`: inspect recent companion events.
- `companion_status`: inspect session/run status.
- `companion_result`: read the latest final result and resume command.
- `companion_cancel`: stop a running companion task.
- `companion_reset`: forget the project-to-session binding.
- `companion_init_project`: create shared `AGENTS.md` and `CLAUDE.md`.

## Build

```bash
npm install
npm run build
```

For development:

```bash
npm run typecheck
npm run build
npm run smoke
```

## Codex MCP Config

```bash
codex mcp add cc-in-codex -- node /absolute/path/to/cc-in-codex/dist/index.js
```

The server uses your local `claude` executable when available. Override with:

```bash
CC_IN_CODEX_CLAUDE_PATH=/absolute/path/to/claude
```

## Quick Start

### New project

1. Ask Codex to use cc-in-codex for the project.
2. Codex should call `companion_init_project` once to create shared `AGENTS.md`
   and `CLAUDE.md` when they do not exist.
3. Use `companion_send` for normal SDK delegation.
4. Use `companion_tui_open` when you want to watch or take over Claude Code in a side terminal.

### Existing Claude Code project

If you already used Claude Code in the project, cc-in-codex can continue that
context instead of starting fresh.

Use an exact session id when you know it:

```json
{
  "cwd": "/absolute/path/to/project",
  "backend": "sdk",
  "sessionId": "00000000-0000-0000-0000-000000000000"
}
```

For the visible TUI, you can either resume an exact session or continue the
latest Claude Code conversation for that cwd:

```json
{
  "cwd": "/absolute/path/to/project",
  "continueLatest": true
}
```

The TUI backend maps that to `claude --continue`. If the project already has a
cc-in-codex tmux pane, resume will refuse to replace it unless you pass
`replaceTui: true`; this prevents Codex and the human observer from silently
watching a different Claude Code conversation than expected.

## Claude Code Status Line

For accurate context-window pressure, configure Claude Code to call
cc-in-codex as a status line command. Claude Code sends a JSON snapshot on
stdin; cc-in-codex stores the latest `context_window` data locally under
`~/.cc-in-codex/statusline/`.

In Claude Code settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/cc-in-codex/dist/index.js statusline"
  }
}
```

With this configured, `companion_tui_compact_check` uses Claude Code's real
`context_window.used_percentage` and remaining context. Without it, the compact
check falls back to visible-pane and metadata heuristics.

## Visible TUI Mode

The TUI backend requires `tmux`.

```bash
brew install tmux
```

Open the visible Claude Code session from Codex with `companion_tui_open`, or
from a terminal with:

```bash
cc-in-codex attach /absolute/path/to/project
```

Resume an existing Claude Code conversation in the visible TUI:

```bash
cc-in-codex attach /absolute/path/to/project --continue
cc-in-codex attach /absolute/path/to/project --resume <session-id>
```

If a cc-in-codex tmux pane already exists and you intentionally want a fresh
visible pane for the resumed conversation:

```bash
cc-in-codex attach /absolute/path/to/project --continue --replace
```

Codex can then send work to the same visible session with `companion_tui_send`.
The prompt is pasted into Claude Code's native CLI and submitted. You can attach
to the same tmux session in Codex's side terminal, watch the live ASCII UI, and
type manually if you need to take over.

### Prompt layering

The TUI backend separates a one-time **bootstrap** prompt from each **task**
prompt. The first `companion_tui_send` to a freshly launched pane prepends the
companion contract (role, `cwd`, mode, permission policy, report format); every
later send carries only `Task: ...`. The bootstrap is re-sent automatically if
the tmux session is recreated. This keeps repeat turns lean while still priming
a new pane.

### Raw input

Use `companion_tui_raw` to drive the pane directly without the cc-in-codex
framing — for example a slash command (`text: "/clear"`), an interrupt
(`keys: ["C-c"]`), or `Escape`. It targets the existing session and errors
clearly if none is open. Sending `/clear` marks the pane as needing bootstrap
again, so the next task re-primes Claude Code with the companion contract. Raw
`/compact` has the same bootstrap reset behavior.

Long task prompts and longer raw inputs are pasted through a tmux buffer and use
a length-based delay before pressing Enter. This is more reliable than direct
key injection for long commands, long slash commands, or multi-line task briefs.

### Compacting context

Compacting is a checkpoint decision, not a reflex. Codex should first run
`companion_tui_compact_check`. That tool inspects whether the visible TUI appears
idle at a clean boundary and estimates pressure from Claude Code statusline data
when available, falling back to cc-in-codex metadata plus captured pane length.
It returns `wait`, `no_need`,
`consider_at_next_checkpoint`, or `compact_now`.

Only run `companion_tui_compact` when the check says this is a reasonable node
to compact, or when the user explicitly asks. It sends `/compact` with default
instructions to preserve the companion contract, current project state, recent
decisions, open tasks, verification status, blockers, and workflow assumptions
while dropping repeated boilerplate. After compacting, the next task
re-bootstraps the companion contract.

The check is intentionally conservative. Claude Code's exact remaining context
window is not exposed here as a stable structured signal, so the goal is to
compact at good task boundaries before context pressure becomes risky, not to
chase an exact token threshold.

### Monitoring and stop loss

Claude Code TUI work often includes long read/think phases. Treat quiet periods
as something to inspect with `companion_tui_screen`, not as an automatic failure.
Use `companion_tui_raw` with `keys: ["C-c"]` only when the visible pane shows a
real problem: runaway commands, repeated permission loops, obviously wrong work,
or a user-requested stop. For normal implementation tasks, leave enough time for
Claude Code to read the repo before interrupting.

For SDK work, `maxRuntimeMs` and `stallTimeoutMs` are stop-loss limits. Prefer a
larger stall timeout for repository audits or tasks where Claude Code needs time
to read before producing progress events.

## Safety Model

The default permission policy is `balanced`. The SDK and TUI backends have
different safety boundaries.

`maxBudgetUsd` is an optional per-turn SDK stop-loss override. It is not stored
as sticky project state. For normal Claude Max/subscription workflows, omit it
and rely on `maxRuntimeMs`, `stallTimeoutMs`, visible TUI monitoring, and manual
`C-c` stop-loss instead.

For the SDK backend, cc-in-codex uses the Claude Agent SDK permission callback:

- read-only mode denies mutating Claude Code tools.
- workspace-write mode allows normal local project work.
- `balanced` denies detected paths outside the companion `cwd`.
- `strict` mode only allows explicit `allowedTools`.
- `trusted` mode relies on Claude Code and the local environment.
- `bypass` explicitly skips Claude Code permission prompts. The SDK backend uses
  `bypassPermissions`; a newly launched TUI uses `--dangerously-skip-permissions`.

The TUI backend is intentionally human-visible and conservative. It sends prompts
and raw keys, but it does not claim to know task completion from a full-screen
terminal, and it cannot enforce the same MCP-level path guardrails inside the
native Claude Code CLI. TUI safety comes from visibility, Claude Code CLI
permissions, project settings, user confirmation, and explicit stop-loss actions
such as sending `C-c`. Codex remains responsible for monitoring and reviewing
results.

Existing TUI panes cannot change their launch permission flags. To use `bypass`
in TUI mode, create a fresh pane or resume with `replaceTui:true`.

### Limitations

Current TUI behavior is intentionally conservative: the MCP server does not try
to infer task completion from the full-screen terminal. It reports that the
prompt was sent and returns the tmux attach command. Because the live transcript
lives in the pane, `companion_tui_send` returns only a short event trail (read
the pane or `companion_tui_screen` for live status). The `tui` backend requires
`tmux` on `PATH`; without it the tools return an actionable install error instead
of crashing. The `sdk` backend remains the default and is unchanged.

## Design

Codex is the lead agent. Claude Code is the execution companion.

- Codex handles reasoning, decomposition, review, and synthesis.
- Claude Code handles coding, repository inspection, edits, tests, refactors, and subagents.
- The same `cwd` resumes the same Claude Code session.
- Claude Code reads the repository itself instead of receiving large pasted summaries.
- `AGENTS.md` is the shared project instruction file; `CLAUDE.md` points Claude Code to it.

When a Claude session exists, `companion_status` and `companion_result` include:

```bash
claude --resume <session-id>
```

Use that command in the Claude Code CLI to inspect or continue the same session.

## Open Source Status

The repository is intended to be small, local-first, and easy to audit. Before
publishing a release, run:

```bash
npm run typecheck
npm run build
npm run smoke
```

The package publishes only the compiled `dist/` output plus documentation and
license files and the smoke script. See `LICENSE` for terms.
