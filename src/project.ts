import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeCwd } from "./state.js";

export interface InitProjectResult {
  cwd: string;
  created: string[];
  skipped: string[];
  agentsPath: string;
  claudePath: string;
}

export async function initProject(cwd?: string, force = false): Promise<InitProjectResult> {
  const root = normalizeCwd(cwd);
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");
  const created: string[] = [];
  const skipped: string[] = [];

  await writeIfNeeded(agentsPath, buildAgentsMd(), force, created, skipped);
  await writeIfNeeded(claudePath, buildClaudeMd(), force, created, skipped);

  return { cwd: root, created, skipped, agentsPath, claudePath };
}

async function writeIfNeeded(
  path: string,
  content: string,
  force: boolean,
  created: string[],
  skipped: string[],
): Promise<void> {
  if (!force) {
    try {
      await access(path);
      skipped.push(path);
      return;
    } catch {
      // File does not exist; create it.
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  created.push(path);
}

function buildAgentsMd(): string {
  return `# Project Agent Instructions

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
`;
}

function buildClaudeMd(): string {
  return `# Claude Code Project Entry

Read AGENTS.md first. It is the shared source of project instructions for both Codex and Claude Code.

When running as the cc-in-codex companion:

- Codex is the lead agent.
- Continue the existing Claude Code session context when resumed.
- Execute implementation tasks directly in this working directory.
- Return concise results for Codex to review.
`;
}
