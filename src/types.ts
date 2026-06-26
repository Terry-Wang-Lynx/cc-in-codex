export type CompanionMode = "read-only" | "workspace-write";

export type CompanionStatus = "idle" | "running" | "error" | "cancelled" | "stale";

export type CompanionBackend = "sdk" | "tui";

export type PermissionPolicy = "balanced" | "trusted" | "strict";

export interface CompanionConfig {
  cwd: string;
  title: string;
  backend: CompanionBackend;
  mode: CompanionMode;
  permissionPolicy: PermissionPolicy;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxRuntimeMs: number;
  stallTimeoutMs?: number;
  claudePath?: string;
  tmuxSessionName?: string;
  attachCommand?: string;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface CompanionEvent {
  id: number;
  at: string;
  type: "user" | "assistant" | "progress" | "result" | "error" | "system" | "tool";
  text: string;
  raw?: unknown;
}

export interface CompanionRun {
  runId: string;
  prompt: string;
  startedAt: string;
  deadlineAt?: string;
  lastProgressAt: string;
}

export interface CompanionLastResult {
  runId: string;
  at: string;
  status: "success" | "error" | "cancelled";
  result: string;
  costUsd?: number;
  turns?: number;
}

export interface CompanionRecord {
  cwd: string;
  sessionId?: string;
  resumeCommand?: string;
  backend: CompanionBackend;
  tmuxSessionName?: string;
  attachCommand?: string;
  title: string;
  mode: CompanionMode;
  permissionPolicy: PermissionPolicy;
  model?: string;
  effort?: CompanionConfig["effort"];
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxRuntimeMs: number;
  stallTimeoutMs?: number;
  claudePath?: string;
  bootstrapped?: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  status: CompanionStatus;
  cursor: number;
  activeRun?: CompanionRun;
  lastResult?: CompanionLastResult;
  createdAt: string;
  lastUsedAt: string;
  lastError?: string;
  events: CompanionEvent[];
}

export interface StateFile {
  version: 1;
  companions: Record<string, CompanionRecord>;
}

export interface SendResult {
  cwd: string;
  sessionId?: string;
  resumeCommand?: string;
  backend?: CompanionBackend;
  tmuxSessionName?: string;
  attachCommand?: string;
  runId?: string;
  status: CompanionStatus;
  result: string;
  costUsd?: number;
  turns?: number;
  events: CompanionEvent[];
}

export interface StartResult {
  cwd: string;
  sessionId?: string;
  backend?: CompanionBackend;
  tmuxSessionName?: string;
  attachCommand?: string;
  runId: string;
  status: "running";
  startedAt: string;
  deadlineAt?: string;
}
