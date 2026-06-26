import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  CompanionConfig,
  CompanionEvent,
  CompanionMode,
  CompanionRecord,
  PermissionPolicy,
  StateFile,
} from "./types.js";

const STATE_PATH = resolve(homedir(), ".cc-in-codex", "state.json");
const MAX_EVENTS_PER_COMPANION = 800;

export const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;
export const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

export const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookRead",
  "NotebookEdit",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
];

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"];

export const MUTATING_TOOLS = new Set(["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function normalizeCwd(cwd?: string): string {
  return resolve(cwd ?? process.env.PWD ?? process.cwd());
}

export function resumeCommand(sessionId?: string): string | undefined {
  return sessionId ? `claude --resume ${sessionId}` : undefined;
}

export function defaultConfig(input?: Partial<CompanionConfig> & { cwd?: string }): CompanionConfig {
  const mode: CompanionMode = input?.mode ?? "workspace-write";
  const permissionPolicy: PermissionPolicy = input?.permissionPolicy ?? "balanced";
  return {
    cwd: normalizeCwd(input?.cwd),
    title: input?.title ?? "Claude Code companion",
    backend: input?.backend ?? "sdk",
    mode,
    permissionPolicy,
    model: input?.model,
    effort: input?.effort ?? "high",
    maxTurns: input?.maxTurns ?? 30,
    maxBudgetUsd: input?.maxBudgetUsd,
    maxRuntimeMs: input?.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
    stallTimeoutMs: input?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    claudePath: input?.claudePath,
    tmuxSessionName: input?.tmuxSessionName,
    attachCommand: input?.attachCommand,
    allowedTools: input?.allowedTools ?? (mode === "read-only" ? READ_ONLY_TOOLS : DEFAULT_ALLOWED_TOOLS),
    disallowedTools: input?.disallowedTools ?? [],
  };
}

function emptyState(): StateFile {
  return { version: 1, companions: {} };
}

export async function loadState(): Promise<StateFile> {
  try {
    const text = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(text) as StateFile;
    if (parsed.version !== 1 || typeof parsed.companions !== "object") {
      return emptyState();
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
}

export async function saveState(state: StateFile): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function createRecord(config: CompanionConfig): CompanionRecord {
  const now = new Date().toISOString();
  return {
    cwd: normalizeCwd(config.cwd),
    title: config.title,
    backend: config.backend,
    mode: config.mode,
    permissionPolicy: config.permissionPolicy,
    model: config.model,
    effort: config.effort,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    maxRuntimeMs: config.maxRuntimeMs,
    stallTimeoutMs: config.stallTimeoutMs,
    claudePath: config.claudePath,
    tmuxSessionName: config.tmuxSessionName,
    attachCommand: config.attachCommand,
    allowedTools: config.allowedTools,
    disallowedTools: config.disallowedTools,
    status: "idle",
    cursor: 0,
    createdAt: now,
    lastUsedAt: now,
    events: [],
  };
}

export async function getRecord(cwd?: string): Promise<CompanionRecord | undefined> {
  const state = await loadState();
  return state.companions[normalizeCwd(cwd)];
}

export async function ensureRecord(
  input?: Partial<CompanionConfig> & { cwd?: string },
): Promise<CompanionRecord> {
  const config = defaultConfig(input);
  const state = await loadState();
  const existing = state.companions[config.cwd];
  if (existing) {
    const merged: CompanionRecord = {
      ...existing,
      title: input?.title ?? existing.title,
      backend: input?.backend ?? existing.backend ?? config.backend,
      mode: input?.mode ?? existing.mode,
      permissionPolicy: input?.permissionPolicy ?? existing.permissionPolicy ?? config.permissionPolicy,
      model: input?.model ?? existing.model,
      effort: input?.effort ?? existing.effort,
      maxTurns: input?.maxTurns ?? existing.maxTurns ?? config.maxTurns,
      maxBudgetUsd: input?.maxBudgetUsd ?? existing.maxBudgetUsd,
      maxRuntimeMs: input?.maxRuntimeMs ?? existing.maxRuntimeMs ?? config.maxRuntimeMs,
      stallTimeoutMs: input?.stallTimeoutMs ?? existing.stallTimeoutMs ?? config.stallTimeoutMs,
      claudePath: input?.claudePath ?? existing.claudePath,
      tmuxSessionName: input?.tmuxSessionName ?? existing.tmuxSessionName,
      attachCommand: input?.attachCommand ?? existing.attachCommand,
      allowedTools: input?.allowedTools ?? existing.allowedTools ?? config.allowedTools,
      disallowedTools: input?.disallowedTools ?? existing.disallowedTools ?? config.disallowedTools,
      resumeCommand: resumeCommand(existing.sessionId),
    };
    state.companions[config.cwd] = merged;
    await saveState(state);
    return merged;
  }

  const created = createRecord(config);
  state.companions[config.cwd] = created;
  await saveState(state);
  return created;
}

export async function updateRecord(record: CompanionRecord): Promise<CompanionRecord> {
  const state = await loadState();
  state.companions[record.cwd] = {
    ...record,
    resumeCommand: resumeCommand(record.sessionId),
    lastUsedAt: new Date().toISOString(),
    events: record.events.slice(-MAX_EVENTS_PER_COMPANION),
  };
  await saveState(state);
  return state.companions[record.cwd];
}

export async function resetRecord(cwd?: string): Promise<boolean> {
  const state = await loadState();
  const key = normalizeCwd(cwd);
  const existed = Boolean(state.companions[key]);
  delete state.companions[key];
  await saveState(state);
  return existed;
}

export function pushEvent(
  record: CompanionRecord,
  event: Omit<CompanionEvent, "id" | "at"> & { at?: string },
): CompanionRecord {
  const nextEvent: CompanionEvent = {
    id: record.cursor,
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    text: event.text,
    raw: event.raw,
  };
  return {
    ...record,
    cursor: record.cursor + 1,
    activeRun: record.activeRun
      ? { ...record.activeRun, lastProgressAt: nextEvent.at }
      : record.activeRun,
    events: [...record.events, nextEvent].slice(-MAX_EVENTS_PER_COMPANION),
  };
}
