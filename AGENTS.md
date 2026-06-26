# Project Agent Instructions

This file is shared by Codex and Claude Code.

## Collaboration Model

- Codex is the lead agent for reasoning, planning, scientific judgment, review, and final synthesis.
- Claude Code is the persistent local implementation companion for repository inspection, edits, tests, refactors, and execution.
- The user should only need to talk to Codex; Claude Code reports concise execution results back to Codex.

## Working Rules

- Work in the current repository root unless explicitly instructed otherwise.
- Keep changes focused on the requested task.
- Prefer reading existing code and tests before editing.
- Preserve local style, naming, and architecture.
- Run relevant checks when practical and report exact commands and outcomes.
- Do not hide blockers, uncertainty, failed commands, or skipped verification.
- Avoid dumping large file contents into chat; summarize only the necessary evidence.

## Context Policy

- Treat this file as the shared project memory.
- Claude Code sessions started by cc-in-codex are persistent and resumable from the local Claude Code CLI.
- If context seems stale after a tool or MCP restart, re-read the relevant files instead of relying on memory.
