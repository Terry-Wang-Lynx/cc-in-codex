import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { normalizeCwd } from "./state.js";

export interface TuiSessionInfo {
  cwd: string;
  tmuxSessionName: string;
  attachCommand: string;
  created: boolean;
  tmuxVersion: string;
  launchMode: "new" | "resume" | "continue" | "existing";
  requestedSessionId?: string;
}

export interface TuiSendResult extends TuiSessionInfo {
  runId: string;
  sent: true;
}

export interface TuiScreen {
  cwd: string;
  tmuxSessionName: string;
  attachCommand: string;
  exists: boolean;
  capturedAt: string;
  text: string;
}

export function tmuxSessionNameForCwd(cwd: string): string {
  const root = normalizeCwd(cwd);
  const base = sanitizeName(basename(root) || "project").slice(0, 32);
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 10);
  return `ccic-${base}-${hash}`;
}

export function buildAttachCommand(tmuxSessionName: string): string {
  return `tmux attach -t ${tmuxSessionName}`;
}

export function ensureTuiSession(input: {
  cwd?: string;
  sessionId?: string;
  continueLatest?: boolean;
  claudePath?: string;
  tmuxSessionName?: string;
}): TuiSessionInfo {
  if (input.sessionId && input.continueLatest) {
    throw new Error("Use either sessionId or continueLatest for a TUI session, not both.");
  }

  const cwd = normalizeCwd(input.cwd);
  const tmuxVersion = requireTmux();
  const tmuxSessionName = input.tmuxSessionName ?? tmuxSessionNameForCwd(cwd);
  const attachCommand = buildAttachCommand(tmuxSessionName);

  if (hasTmuxSession(tmuxSessionName)) {
    return { cwd, tmuxSessionName, attachCommand, created: false, tmuxVersion, launchMode: "existing" };
  }

  const claude = input.claudePath ?? "claude";
  const launchMode = input.sessionId ? "resume" : input.continueLatest ? "continue" : "new";
  const command = buildClaudeTuiCommand(claude, launchMode, input.sessionId);

  execFileSync("tmux", ["new-session", "-d", "-s", tmuxSessionName, "-c", cwd, command], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    cwd,
    tmuxSessionName,
    attachCommand,
    created: true,
    tmuxVersion,
    launchMode,
    requestedSessionId: input.sessionId,
  };
}

export function sendPromptToTui(input: {
  cwd?: string;
  prompt: string;
  sessionId?: string;
  continueLatest?: boolean;
  claudePath?: string;
  tmuxSessionName?: string;
}): TuiSendResult {
  const session = ensureTuiSession(input);
  const bufferName = `ccic-${randomUUID()}`;

  const clear = spawnSync("tmux", ["send-keys", "-t", session.tmuxSessionName, "C-u"]);
  assertSuccess(clear, "tmux send-keys C-u");

  const load = spawnSync("tmux", ["load-buffer", "-b", bufferName, "-"], {
    input: input.prompt,
    encoding: "utf8",
  });
  assertSuccess(load, "tmux load-buffer");

  const paste = spawnSync("tmux", ["paste-buffer", "-b", bufferName, "-t", session.tmuxSessionName]);
  assertSuccess(paste, "tmux paste-buffer");

  // Claude Code's TUI can take a moment to finish processing long pasted input.
  // Sending Enter immediately after paste is flaky for longer prompts.
  waitMs(150);

  const enter = spawnSync("tmux", ["send-keys", "-t", session.tmuxSessionName, "C-m"]);
  assertSuccess(enter, "tmux send-keys Enter");

  spawnSync("tmux", ["delete-buffer", "-b", bufferName]);

  return { ...session, runId: randomUUID(), sent: true };
}

export interface TuiRawResult extends TuiSessionInfo {
  sent: true;
  enteredKeys: string[];
}

/**
 * Send raw input to an existing pane without the cc-in-codex wrapper: literal text and/or tmux
 * key names (e.g. "Enter", "C-c", "Escape"). Useful for slash commands and control keys.
 */
export function sendRawToTui(input: {
  cwd?: string;
  text?: string;
  keys?: string[];
  enter?: boolean;
  tmuxSessionName?: string;
}): TuiRawResult {
  const cwd = normalizeCwd(input.cwd);
  const tmuxVersion = requireTmux();
  const tmuxSessionName = input.tmuxSessionName ?? tmuxSessionNameForCwd(cwd);
  const attachCommand = buildAttachCommand(tmuxSessionName);

  if (!hasTmuxSession(tmuxSessionName)) {
    throw new Error(
      `No Claude Code TUI session '${tmuxSessionName}' to receive raw input. Open it first with companion_tui_open.`,
    );
  }

  const hasText = typeof input.text === "string" && input.text.length > 0;
  const keys = input.keys ?? [];
  const enteredKeys: string[] = [];

  if (hasText) {
    const bufferName = `ccic-${randomUUID()}`;
    const load = spawnSync("tmux", ["load-buffer", "-b", bufferName, "-"], {
      input: input.text,
      encoding: "utf8",
    });
    assertSuccess(load, "tmux load-buffer");
    const paste = spawnSync("tmux", ["paste-buffer", "-b", bufferName, "-t", tmuxSessionName]);
    assertSuccess(paste, "tmux paste-buffer");
    spawnSync("tmux", ["delete-buffer", "-b", bufferName]);
  }

  for (const key of keys) {
    const result = spawnSync("tmux", ["send-keys", "-t", tmuxSessionName, key]);
    assertSuccess(result, `tmux send-keys ${key}`);
    enteredKeys.push(key);
  }

  // Default to pressing Enter only for a plain text send with no explicit keys.
  const shouldEnter = input.enter ?? (hasText && keys.length === 0);
  if (shouldEnter) {
    if (hasText) waitMs(150);
    const enter = spawnSync("tmux", ["send-keys", "-t", tmuxSessionName, "C-m"]);
    assertSuccess(enter, "tmux send-keys Enter");
    enteredKeys.push("C-m");
  }

  return {
    cwd,
    tmuxSessionName,
    attachCommand,
    created: false,
    tmuxVersion,
    launchMode: "existing",
    sent: true,
    enteredKeys,
  };
}

export function interruptTuiSession(tmuxSessionName: string): boolean {
  if (!hasTmuxSession(tmuxSessionName)) return false;
  const result = spawnSync("tmux", ["send-keys", "-t", tmuxSessionName, "C-c"]);
  assertSuccess(result, "tmux send-keys C-c");
  return true;
}

export function tuiSessionExists(tmuxSessionName: string): boolean {
  requireTmux();
  return hasTmuxSession(tmuxSessionName);
}

export function killTuiSession(tmuxSessionName: string): boolean {
  requireTmux();
  if (!hasTmuxSession(tmuxSessionName)) return false;
  const result = spawnSync("tmux", ["kill-session", "-t", tmuxSessionName]);
  assertSuccess(result, "tmux kill-session");
  return true;
}

export function captureTuiScreen(input: {
  cwd?: string;
  tmuxSessionName?: string;
  lines?: number;
}): TuiScreen {
  const cwd = normalizeCwd(input.cwd);
  requireTmux();
  const tmuxSessionName = input.tmuxSessionName ?? tmuxSessionNameForCwd(cwd);
  const attachCommand = buildAttachCommand(tmuxSessionName);
  if (!hasTmuxSession(tmuxSessionName)) {
    return {
      cwd,
      tmuxSessionName,
      attachCommand,
      exists: false,
      capturedAt: new Date().toISOString(),
      text: "",
    };
  }

  const lines = Math.max(20, Math.min(input.lines ?? 120, 500));
  const result = spawnSync("tmux", ["capture-pane", "-pt", tmuxSessionName, "-S", `-${lines}`], {
    encoding: "utf8",
  });
  assertSuccess(result, "tmux capture-pane");

  return {
    cwd,
    tmuxSessionName,
    attachCommand,
    exists: true,
    capturedAt: new Date().toISOString(),
    text: String(result.stdout ?? ""),
  };
}

function requireTmux(): string {
  try {
    execFileSync("command", ["-v", "tmux"], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // `command` is a shell builtin on many systems; fall through to tmux -V.
  }

  try {
    return execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "TUI backend requires tmux, but `tmux` was not found on PATH. Install tmux, then retry. On macOS: brew install tmux.",
    );
  }
}

function hasTmuxSession(tmuxSessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", tmuxSessionName], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function buildClaudeTuiCommand(
  claude: string,
  launchMode: TuiSessionInfo["launchMode"],
  sessionId?: string,
): string {
  switch (launchMode) {
    case "resume":
      if (!sessionId) throw new Error("sessionId is required for Claude Code --resume.");
      return `${shellQuote(claude)} --resume ${shellQuote(sessionId)}`;
    case "continue":
      return `${shellQuote(claude)} --continue`;
    case "new":
    case "existing":
      return shellQuote(claude);
  }
}

function assertSuccess(result: ReturnType<typeof spawnSync>, label: string): void {
  if (result.status === 0) return;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr ?? "");
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
  throw new Error(`${label} failed: ${stderr || stdout || `exit ${result.status}`}`);
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
