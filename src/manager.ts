import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ensureRecord,
  getRecord,
  MUTATING_TOOLS,
  normalizeCwd,
  pushEvent,
  resetRecord,
  updateRecord,
} from "./state.js";
import { loadStatuslineSnapshot, type StatuslineSnapshot } from "./statusline.js";
import {
  captureTuiScreen,
  ensureTuiSession,
  interruptTuiSession,
  killTuiSession,
  sendPromptToTui,
  sendRawToTui,
  tmuxSessionNameForCwd,
  tuiSessionExists,
  type TuiScreen,
  type TuiSessionInfo,
} from "./tui.js";
import type {
  CompanionConfig,
  CompanionEvent,
  CompanionRecord,
  SendResult,
  StartResult,
} from "./types.js";

interface RunHandle {
  runId: string;
  cwd: string;
  abortController: AbortController;
  promise: Promise<SendResult>;
  lastProgressAt: number;
  timeout?: ReturnType<typeof setTimeout>;
  stallTimer?: ReturnType<typeof setInterval>;
}

interface TurnOverrides {
  maxBudgetUsd?: number;
}

type CompanionInput = Partial<CompanionConfig> & {
  cwd?: string;
  sessionId?: string;
  continueLatest?: boolean;
};

type CompanionResumeInput = CompanionInput & {
  backend?: "sdk" | "tui";
  replaceTui?: boolean;
};

interface CompactCheckResult {
  cwd: string;
  backend?: string;
  tmuxSessionName?: string;
  attachCommand?: string;
  exists: boolean;
  checkpointReady: boolean;
  pressure: "unknown" | "low" | "medium" | "high";
  recommendation: "open_tui" | "wait" | "no_need" | "consider_at_next_checkpoint" | "compact_now";
  reasons: string[];
  nextAction: string;
  metrics: {
    status?: string;
    bootstrapped?: boolean;
    eventCount: number;
    capturedLines: number;
    capturedChars: number;
    source: "statusline" | "screen_heuristic";
    statuslineAgeMs?: number;
    contextWindowSize?: number;
    contextUsedPercentage?: number;
    contextRemainingPercentage?: number;
    contextUsedTokens?: number;
    totalInputTokens?: number;
  };
  caveat: string;
}

interface CompanionWaitResult {
  cwd: string;
  status?: string;
  timedOut: boolean;
  eventCursor: number;
  events: CompanionEvent[];
  activeRun?: CompanionRecord["activeRun"];
  lastResult?: CompanionRecord["lastResult"];
  nextAction: string;
}

const running = new Map<string, RunHandle>();

export async function openCompanion(
  input?: CompanionInput,
): Promise<CompanionRecord> {
  if (input?.backend === "tui") {
    const prepared = await prepareExplicitTuiRecord(input);
    return publicRecord(await openTuiCompanion(prepared.record, prepared.session), 20);
  }

  const record = await reconcileRecord(await ensureRecord(input));
  if (record.backend === "tui") {
    return publicRecord(await openTuiCompanion(record), 20);
  }
  return publicRecord(record, 20);
}

export async function companionStatus(cwd?: string): Promise<CompanionRecord | undefined> {
  const record = await getRecord(cwd);
  if (!record) return undefined;
  return publicRecord(await reconcileRecord(record), 20);
}

export async function companionRecent(cwd?: string, limit = 20): Promise<CompanionRecord | undefined> {
  const record = await companionStatus(cwd);
  if (!record) return undefined;
  return publicRecord(record, Math.max(1, Math.min(limit, 200)));
}

export async function companionResult(cwd?: string): Promise<CompanionRecord | undefined> {
  return companionStatus(cwd);
}

export async function companionWait(input: {
  cwd?: string;
  sinceCursor?: number;
  timeoutMs?: number;
}): Promise<CompanionWaitResult> {
  const cwd = normalizeCwd(input.cwd);
  const timeoutMs = Math.max(1000, Math.min(input.timeoutMs ?? 60_000, 5 * 60_000));
  let sinceCursor = input.sinceCursor;
  if (sinceCursor === undefined) {
    sinceCursor = (await getRecord(cwd))?.cursor ?? 0;
  }
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const record = await getRecord(cwd);
    if (!record) {
      return {
        cwd,
        timedOut: false,
        eventCursor: sinceCursor,
        events: [],
        nextAction: "No companion exists for this cwd. Open or start a companion first.",
      };
    }

    const current = await reconcileRecord(record);
    const events = current.events.filter((event) => event.id >= sinceCursor).map(publicEvent);
    if (events.length > 0 || current.status !== "running") {
      return {
        cwd: current.cwd,
        status: current.status,
        timedOut: false,
        eventCursor: current.cursor,
        events,
        activeRun: current.activeRun,
        lastResult: current.lastResult,
        nextAction: current.status === "running"
          ? "New companion events are available; inspect them and continue waiting if needed."
          : "The companion is not running; inspect lastResult before deciding the next action.",
      };
    }

    await sleep(1000);
  }

  const record = await getRecord(cwd);
  return {
    cwd,
    status: record?.status,
    timedOut: true,
    eventCursor: record?.cursor ?? sinceCursor,
    events: record?.events.filter((event) => event.id >= sinceCursor).map(publicEvent) ?? [],
    activeRun: record?.activeRun,
    lastResult: record?.lastResult,
    nextAction: "No new companion events arrived before timeout. Continue waiting, inspect status, or cancel if this looks stuck.",
  };
}

export async function resumeCompanion(input: CompanionResumeInput): Promise<CompanionRecord> {
  if (input.sessionId && input.continueLatest) {
    throw new Error("Use either sessionId or continueLatest, not both.");
  }
  if (!input.sessionId && !input.continueLatest) {
    throw new Error("resumeCompanion needs a Claude Code sessionId, or continueLatest:true for the TUI backend.");
  }

  const cwd = normalizeCwd(input.cwd);
  const backend = input.backend ?? "sdk";

  if (backend === "sdk") {
    if (!input.sessionId) {
      throw new Error(
        "The SDK backend needs an explicit sessionId to resume. Use backend:'tui' with continueLatest:true to run `claude --continue`, then let statusline bind the session id.",
      );
    }

    const record = await ensureRecord({ ...input, cwd, backend: "sdk" });
    const current = await updateRecord(
      pushEvent(
        {
          ...record,
          backend: "sdk",
          sessionId: input.sessionId,
          status: "idle",
          activeRun: undefined,
          lastError: undefined,
          bootstrapped: undefined,
        },
        {
          type: "system",
          text: `Bound SDK companion to Claude Code session ${input.sessionId}. Future SDK sends will resume it.`,
        },
      ),
    );
    return publicRecord(current, 20);
  }

  return publicRecord(await resumeTuiCompanion(input, cwd), 20);
}

export async function companionTuiScreen(cwd?: string, lines?: number): Promise<TuiScreen> {
  const record = await getRecord(cwd);
  return captureTuiScreen({
    cwd: record?.cwd ?? cwd,
    tmuxSessionName: record?.tmuxSessionName,
    lines,
  });
}

export async function companionTuiCompactCheck(input: {
  cwd?: string;
  lines?: number;
}): Promise<CompactCheckResult> {
  const record = await getRecord(input.cwd);
  const screen = captureTuiScreen({
    cwd: record?.cwd ?? input.cwd,
    tmuxSessionName: record?.tmuxSessionName,
    lines: input.lines ?? 500,
  });
  const capturedLines = screen.text ? screen.text.split("\n").length : 0;
  const capturedChars = screen.text.length;
  const eventCount = record?.events.length ?? 0;
  const tail = screen.text.split("\n").slice(-16).join("\n");
  const snapshot = await loadStatuslineSnapshot(record?.cwd ?? input.cwd);

  if (!screen.exists) {
    return {
      cwd: screen.cwd,
      backend: record?.backend,
      tmuxSessionName: screen.tmuxSessionName,
      attachCommand: screen.attachCommand,
      exists: false,
      checkpointReady: false,
      pressure: "unknown",
      recommendation: "open_tui",
      reasons: ["No visible Claude Code TUI session exists for this cwd."],
      nextAction: "Open the TUI session before considering compact.",
      metrics: {
        status: record?.status,
        bootstrapped: record?.bootstrapped,
        eventCount,
        capturedLines,
        capturedChars,
        source: snapshot ? "statusline" : "screen_heuristic",
        ...statuslineMetrics(snapshot),
      },
      caveat: compactCheckCaveat(),
    };
  }

  const active = hasActiveTuiWork(tail);
  const atPrompt = tuiLooksIdleAtPrompt(tail);
  const checkpointReady = atPrompt && !active;
  const pressure = estimateCompactPressure(eventCount, capturedLines, capturedChars, snapshot);
  const reasons = compactCheckReasons({
    active,
    atPrompt,
    pressure,
    eventCount,
    capturedLines,
    capturedChars,
    snapshot,
  });
  const recommendation = chooseCompactRecommendation(checkpointReady, pressure);

  return {
    cwd: screen.cwd,
    backend: record?.backend,
    tmuxSessionName: screen.tmuxSessionName,
    attachCommand: screen.attachCommand,
    exists: true,
    checkpointReady,
    pressure,
    recommendation,
    reasons,
    nextAction: compactNextAction(recommendation),
    metrics: {
      status: record?.status,
      bootstrapped: record?.bootstrapped,
      eventCount,
      capturedLines,
      capturedChars,
      source: snapshot ? "statusline" : "screen_heuristic",
      ...statuslineMetrics(snapshot),
    },
    caveat: compactCheckCaveat(),
  };
}

export async function resetCompanion(cwd?: string): Promise<boolean> {
  const key = normalizeCwd(cwd);
  stopRun(key, "Companion reset by caller.");
  return resetRecord(key);
}

export async function cancelCompanion(cwd?: string): Promise<CompanionRecord | undefined> {
  const key = normalizeCwd(cwd);
  stopRun(key, "Companion cancelled by caller.");
  const record = await getRecord(key);
  if (!record) return undefined;
  const tuiInterrupted = record.backend === "tui" && record.tmuxSessionName
    ? interruptTuiSession(record.tmuxSessionName)
    : false;
  const next = pushEvent(
    {
      ...record,
      status: "cancelled",
      activeRun: undefined,
      lastResult: record.activeRun
        ? {
            runId: record.activeRun.runId,
            at: new Date().toISOString(),
            status: "cancelled",
            result: "Cancelled by caller.",
          }
        : record.lastResult,
    },
    {
      type: "system",
      text: tuiInterrupted
        ? `Sent Ctrl-C to Claude Code TUI session ${record.tmuxSessionName}.`
        : "Companion turn cancelled.",
    },
  );
  return publicRecord(await updateRecord(next), 20);
}

export async function startCompanionRun(
  prompt: string,
  input?: CompanionInput,
): Promise<StartResult> {
  const prepared = input?.backend === "tui" ? await prepareExplicitTuiRecord(input) : undefined;
  const record = prepared?.record ?? (await ensureRecord(input));
  if (record.backend === "tui") {
    const current = await sendTuiCompanionPrompt(prompt, record, prepared?.session);
    return {
      cwd: current.cwd,
      sessionId: current.sessionId,
      backend: current.backend,
      tmuxSessionName: current.tmuxSessionName,
      attachCommand: current.attachCommand,
      runId: current.activeRun?.runId ?? current.lastResult?.runId ?? randomUUID(),
      status: "running",
      startedAt: current.activeRun?.startedAt ?? new Date().toISOString(),
      deadlineAt: current.activeRun?.deadlineAt,
      eventCursor: current.cursor,
    };
  }

  if (running.has(record.cwd)) {
    throw new Error(`Companion for ${record.cwd} is already running.`);
  }

  const runId = randomUUID();
  const now = new Date();
  const deadlineAt =
    record.maxRuntimeMs > 0 ? new Date(now.getTime() + record.maxRuntimeMs).toISOString() : undefined;
  const abortController = new AbortController();

  let current = pushEvent(
    {
      ...record,
      status: "running",
      lastError: undefined,
      activeRun: {
        runId,
        prompt,
        startedAt: now.toISOString(),
        deadlineAt,
        lastProgressAt: now.toISOString(),
      },
    },
    { type: "user", text: prompt },
  );
  current = await updateRecord(current);

  const promise = runCompanionTurn(current, prompt, runId, abortController, {
    maxBudgetUsd: input?.maxBudgetUsd,
  });
  const handle: RunHandle = {
    runId,
    cwd: current.cwd,
    abortController,
    promise,
    lastProgressAt: Date.now(),
  };
  installStopLoss(handle, current);
  running.set(current.cwd, handle);

  promise.finally(() => {
    clearRunTimers(handle);
    if (running.get(current.cwd)?.runId === runId) {
      running.delete(current.cwd);
    }
  });

  return {
    cwd: current.cwd,
    sessionId: current.sessionId,
    backend: current.backend,
    runId,
    status: "running",
    startedAt: now.toISOString(),
    deadlineAt,
    eventCursor: current.cursor,
  };
}

export async function sendToCompanion(
  prompt: string,
  input?: CompanionInput,
): Promise<SendResult> {
  const prepared = input?.backend === "tui" ? await prepareExplicitTuiRecord(input) : undefined;
  const record = prepared?.record ?? (await ensureRecord(input));
  if (record.backend === "tui") {
    const current = await sendTuiCompanionPrompt(prompt, record, prepared?.session);
    return toSendResult(current, tuiSentMessage(current));
  }

  const started = await startCompanionRun(prompt, input);
  const handle = running.get(started.cwd);
  if (!handle) {
    throw new Error(`Companion run ${started.runId} did not start.`);
  }
  return handle.promise;
}

async function prepareExplicitTuiRecord(input: CompanionInput): Promise<{
  record: CompanionRecord;
  session: TuiSessionInfo;
}> {
  const cwd = normalizeCwd(input.cwd);
  const existing = await getRecord(cwd);
  const session = ensureTuiSession({
    cwd,
    sessionId: existing?.sessionId,
    continueLatest: input.continueLatest,
    dangerouslySkipPermissions: input.permissionPolicy === "bypass" || existing?.permissionPolicy === "bypass",
    claudePath: input.claudePath ?? existing?.claudePath ?? detectLocalClaudePath(),
    tmuxSessionName: input.tmuxSessionName ?? existing?.tmuxSessionName,
  });
  const record = await ensureRecord({
    ...input,
    cwd,
    backend: "tui",
    tmuxSessionName: session.tmuxSessionName,
    attachCommand: session.attachCommand,
  });
  return { record, session };
}

async function resumeTuiCompanion(input: CompanionResumeInput, cwd: string): Promise<CompanionRecord> {
  const existing = await getRecord(cwd);
  const tmuxSessionName = input.tmuxSessionName ?? existing?.tmuxSessionName ?? tmuxSessionNameForCwd(cwd);
  const sameBoundSession = Boolean(input.sessionId && existing?.sessionId === input.sessionId);

  if (tuiSessionExists(tmuxSessionName) && !input.replaceTui && !sameBoundSession) {
    throw new Error(
      [
        `A Claude Code TUI session already exists: ${tmuxSessionName}.`,
        "Attach to it, or pass replaceTui:true if you intentionally want to close that pane and launch a resumed one.",
      ].join(" "),
    );
  }

  if (input.replaceTui) {
    killTuiSession(tmuxSessionName);
  }

  const session = ensureTuiSession({
    cwd,
    sessionId: input.sessionId,
    continueLatest: input.continueLatest,
    dangerouslySkipPermissions: input.permissionPolicy === "bypass" || existing?.permissionPolicy === "bypass",
    claudePath: input.claudePath ?? existing?.claudePath ?? detectLocalClaudePath(),
    tmuxSessionName,
  });
  const record = await ensureRecord({
    ...input,
    cwd,
    backend: "tui",
    tmuxSessionName: session.tmuxSessionName,
    attachCommand: session.attachCommand,
  });
  const current = await updateRecord(
    pushEvent(
      {
        ...record,
        backend: "tui",
        sessionId: input.sessionId ?? record.sessionId,
        tmuxSessionName: session.tmuxSessionName,
        attachCommand: session.attachCommand,
        bootstrapped: session.created ? false : record.bootstrapped,
        status: "idle",
        activeRun: undefined,
        lastError: undefined,
      },
      {
        type: "system",
        text: describeResume(session, input),
      },
    ),
  );
  return current;
}

async function openTuiCompanion(record: CompanionRecord, existingSession?: TuiSessionInfo): Promise<CompanionRecord> {
  const session =
    existingSession ??
    ensureTuiSession({
      cwd: record.cwd,
      sessionId: record.sessionId,
      claudePath: record.claudePath ?? detectLocalClaudePath(),
      tmuxSessionName: record.tmuxSessionName,
    });
  let current: CompanionRecord = {
    ...record,
    backend: "tui",
    cwd: session.cwd,
    tmuxSessionName: session.tmuxSessionName,
    attachCommand: session.attachCommand,
    // A freshly launched pane has no cc-in-codex context yet; the next send re-bootstraps.
    bootstrapped: session.created ? false : record.bootstrapped,
    status: record.activeRun ? record.status : "idle",
    lastError: record.activeRun ? record.lastError : undefined,
  };
  current = pushEvent(current, {
    type: "system",
    text: session.created
      ? `Opened Claude Code TUI session. Attach with: ${session.attachCommand}`
      : `Reusing Claude Code TUI session. Attach with: ${session.attachCommand}`,
  });
  return updateRecord(current);
}

async function sendTuiCompanionPrompt(
  prompt: string,
  record: CompanionRecord,
  session?: TuiSessionInfo,
): Promise<CompanionRecord> {
  // Bootstrap (role/cwd/policy context) is sent once per live pane; later turns carry only the task.
  const needsBootstrap = (session?.created ?? false) || !record.bootstrapped;
  const payload = needsBootstrap
    ? `${buildTuiBootstrap(record)} ${buildTuiTaskPrompt(prompt)}`
    : buildTuiTaskPrompt(prompt);

  const sent = sendPromptToTui({
    cwd: record.cwd,
    prompt: payload,
    sessionId: record.sessionId,
    continueLatest: record.sessionId ? false : undefined,
    dangerouslySkipPermissions: record.permissionPolicy === "bypass",
    claudePath: record.claudePath ?? detectLocalClaudePath(),
    tmuxSessionName: session?.tmuxSessionName ?? record.tmuxSessionName,
  });
  const now = new Date().toISOString();
  let current: CompanionRecord = {
    ...record,
    backend: "tui",
    cwd: sent.cwd,
    tmuxSessionName: sent.tmuxSessionName,
    attachCommand: sent.attachCommand,
    bootstrapped: true,
    status: "idle",
    lastError: undefined,
    activeRun: undefined,
    lastResult: {
      runId: sent.runId,
      at: now,
      status: "success",
      result: tuiSentMessage({
        ...record,
        tmuxSessionName: sent.tmuxSessionName,
        attachCommand: sent.attachCommand,
      }),
    },
  };
  current = pushEvent(current, { type: "user", text: prompt });
  current = pushEvent(current, {
    type: "system",
    text: needsBootstrap
      ? `Sent bootstrap + task to Claude Code TUI. Attach with: ${sent.attachCommand}`
      : `Sent task to Claude Code TUI. Attach with: ${sent.attachCommand}`,
  });
  return updateRecord(current);
}

export async function companionTuiRaw(input: {
  cwd?: string;
  text?: string;
  keys?: string[];
  enter?: boolean;
}): Promise<SendResult> {
  if (!input.text && !(input.keys && input.keys.length > 0) && !input.enter) {
    throw new Error("companion_tui_raw needs text, keys, or enter:true to send.");
  }
  const cwd = normalizeCwd(input.cwd);
  const existing = await getRecord(cwd);
  const raw = sendRawToTui({
    cwd,
    text: input.text,
    keys: input.keys,
    enter: input.enter,
    tmuxSessionName: existing?.tmuxSessionName,
  });
  const base =
    existing ??
    (await ensureRecord({
      cwd,
      backend: "tui",
      tmuxSessionName: raw.tmuxSessionName,
      attachCommand: raw.attachCommand,
    }));
  let current: CompanionRecord = {
    ...base,
    backend: "tui",
    tmuxSessionName: raw.tmuxSessionName,
    attachCommand: raw.attachCommand,
    bootstrapped: rawClearsContext(input) ? false : base.bootstrapped,
  };
  current = pushEvent(current, { type: "user", text: describeRaw(input, raw.enteredKeys) });
  current = await updateRecord(current);
  return toTuiControlResult(current, describeRaw(input, raw.enteredKeys));
}

export async function companionTuiCompact(input: {
  cwd?: string;
  instructions?: string;
}): Promise<SendResult> {
  const instructions =
    input.instructions?.trim() ||
    [
      "Preserve the cc-in-codex companion contract, current project state, recent decisions,",
      "open tasks, verification status, blockers, and any user-visible workflow assumptions.",
      "Drop low-value transcript noise and repeated boilerplate.",
    ].join(" ");
  return companionTuiRaw({
    cwd: input.cwd,
    text: `/compact ${compactForTui(instructions)}`,
  });
}

function describeRaw(
  input: { text?: string; keys?: string[]; enter?: boolean },
  enteredKeys: string[],
): string {
  const parts: string[] = [];
  if (input.text) parts.push(`text: ${compactForTui(input.text).slice(0, 200)}`);
  if (enteredKeys.length) parts.push(`keys: ${enteredKeys.join(" ")}`);
  return `Raw TUI input → ${parts.join("; ") || "(noop)"}`;
}

function rawClearsContext(input: { text?: string }): boolean {
  const command = input.text?.trim().toLowerCase();
  return command?.startsWith("/clear") || command?.startsWith("/compact") || false;
}

function hasActiveTuiWork(text: string): boolean {
  return /(?:Running|Reading|Writing|Flamb[eé]ing|thinking|almost done|Bash command|Do you want|requires approval|Press Ctrl-C again|esc to interrupt)/i.test(
    text,
  );
}

function tuiLooksIdleAtPrompt(text: string): boolean {
  return /(?:^|\n)❯/.test(text) || /for shortcuts/.test(text);
}

function estimateCompactPressure(
  eventCount: number,
  capturedLines: number,
  capturedChars: number,
  snapshot?: StatuslineSnapshot,
): CompactCheckResult["pressure"] {
  const usedPercentage = snapshot?.contextWindow?.usedPercentage;
  if (typeof usedPercentage === "number") {
    if (usedPercentage >= 75) return "high";
    if (usedPercentage >= 60) return "medium";
    return "low";
  }
  if (eventCount >= 250 || capturedLines >= 450 || capturedChars >= 45_000) return "high";
  if (eventCount >= 100 || capturedLines >= 250 || capturedChars >= 25_000) return "medium";
  return "low";
}

function compactCheckReasons(input: {
  active: boolean;
  atPrompt: boolean;
  pressure: CompactCheckResult["pressure"];
  eventCount: number;
  capturedLines: number;
  capturedChars: number;
  snapshot?: StatuslineSnapshot;
}): string[] {
  const reasons: string[] = [];
  if (input.active) {
    reasons.push("The visible TUI still shows active work, a prompt, or an approval flow; compacting now would interrupt the task boundary.");
  }
  if (!input.atPrompt) {
    reasons.push("The visible TUI does not clearly look idle at the input prompt.");
  }
  if (!input.active && input.atPrompt) {
    reasons.push("The visible TUI appears to be at an idle checkpoint.");
  }
  const usedPercentage = input.snapshot?.contextWindow?.usedPercentage;
  const remainingPercentage = input.snapshot?.contextWindow?.remainingPercentage;
  if (typeof usedPercentage === "number") {
    reasons.push(
      `Statusline context: ${usedPercentage.toFixed(1)}% used, ${
        typeof remainingPercentage === "number" ? `${remainingPercentage.toFixed(1)}% remaining` : "remaining unknown"
      }.`,
    );
  }
  reasons.push(`Estimated compact pressure is ${input.pressure}.`);
  reasons.push(`Metadata events: ${input.eventCount}; captured pane: ${input.capturedLines} lines, ${input.capturedChars} chars.`);
  return reasons;
}

function chooseCompactRecommendation(
  checkpointReady: boolean,
  pressure: CompactCheckResult["pressure"],
): CompactCheckResult["recommendation"] {
  if (!checkpointReady) return "wait";
  if (pressure === "high") return "compact_now";
  if (pressure === "medium") return "consider_at_next_checkpoint";
  return "no_need";
}

function compactNextAction(recommendation: CompactCheckResult["recommendation"]): string {
  switch (recommendation) {
    case "open_tui":
      return "Open or attach a Claude Code TUI session first.";
    case "wait":
      return "Do not compact yet. Wait for Claude Code to finish the current work and report back.";
    case "compact_now":
      return "This is a reasonable checkpoint with high estimated pressure; run companion_tui_compact before sending more substantial work.";
    case "consider_at_next_checkpoint":
      return "No urgent compact is required, but consider compacting after the next clean report or verification boundary.";
    case "no_need":
      return "Do not compact yet; preserve the full live context.";
  }
}

function compactCheckCaveat(): string {
  return "When cc-in-codex statusline capture is configured, this uses Claude Code's statusline context_window data. Otherwise it falls back to visible-pane and metadata heuristics.";
}

function statuslineMetrics(
  snapshot?: StatuslineSnapshot & { ageMs?: number },
): Partial<CompactCheckResult["metrics"]> {
  if (!snapshot) return {};
  return {
    statuslineAgeMs: snapshot.ageMs,
    contextWindowSize: snapshot.contextWindow?.size,
    contextUsedPercentage: snapshot.contextWindow?.usedPercentage,
    contextRemainingPercentage: snapshot.contextWindow?.remainingPercentage,
    contextUsedTokens: snapshot.contextWindow?.usedTokens,
    totalInputTokens: snapshot.contextWindow?.totalInputTokens,
  };
}

async function runCompanionTurn(
  initialRecord: CompanionRecord,
  prompt: string,
  runId: string,
  abortController: AbortController,
  turnOverrides: TurnOverrides = {},
): Promise<SendResult> {
  let current = initialRecord;
  let finalResult = "";
  let costUsd: number | undefined;
  let turns: number | undefined;

  const canUseTool = buildPermissionHandler(current);
  const options = buildOptions(current, abortController, canUseTool, turnOverrides);

  try {
    for await (const message of query({ prompt: buildPrompt(prompt, current), options })) {
      touchRun(current.cwd);
      current = applySdkMessage(current, message);
      current = captureSessionId(current, message);
      if (message.type === "result") {
        const result = message as SDKResultMessage;
        costUsd = result.total_cost_usd;
        turns = result.num_turns;
        if (result.subtype === "success") {
          finalResult = result.result;
        } else {
          finalResult = result.errors.join("\n") || result.stop_reason || "Claude Code returned an error.";
        }
      }
      current = await updateRecord(current);
    }

    const lastResult = {
      runId,
      at: new Date().toISOString(),
      status: finalResult ? ("success" as const) : ("error" as const),
      result: finalResult || "Claude Code finished without a result message.",
      costUsd,
      turns,
    };
    current = await updateRecord({
      ...current,
      status: lastResult.status === "success" ? "idle" : "error",
      activeRun: undefined,
      lastResult,
      lastError: lastResult.status === "success" ? undefined : lastResult.result,
    });

    return toSendResult(current, lastResult.result, costUsd, turns);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = abortController.signal.aborted ? "cancelled" : "error";
    current = pushEvent(
      {
        ...current,
        status,
        activeRun: undefined,
        lastError: status === "error" ? message : undefined,
        lastResult: {
          runId,
          at: new Date().toISOString(),
          status,
          result: message,
          costUsd,
          turns,
        },
      },
      { type: status === "cancelled" ? "system" : "error", text: message },
    );
    current = await updateRecord(current);
    return toSendResult(current, message, costUsd, turns);
  }
}

function buildOptions(
  record: CompanionRecord,
  abortController: AbortController,
  canUseTool: CanUseTool,
  turnOverrides: TurnOverrides = {},
): Options {
  const claudePath = record.claudePath ?? detectLocalClaudePath();
  return {
    cwd: record.cwd,
    resume: record.sessionId,
    abortController,
    canUseTool,
    tools: { type: "preset", preset: "claude_code" },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildSystemAppend(),
    },
    permissionMode: record.permissionPolicy === "bypass"
      ? "bypassPermissions"
      : record.mode === "read-only"
        ? "dontAsk"
        : "acceptEdits",
    allowDangerouslySkipPermissions: record.permissionPolicy === "bypass" ? true : undefined,
    allowedTools: record.permissionPolicy === "strict" ? record.allowedTools : undefined,
    disallowedTools: record.disallowedTools,
    model: record.model,
    effort: record.effort,
    maxTurns: record.maxTurns,
    maxBudgetUsd: turnOverrides.maxBudgetUsd,
    pathToClaudeCodeExecutable: claudePath,
    persistSession: true,
    settingSources: ["user", "project", "local"],
    includePartialMessages: false,
    includeHookEvents: false,
    forwardSubagentText: true,
    promptSuggestions: true,
    agentProgressSummaries: true,
  };
}

function buildPermissionHandler(record: CompanionRecord): CanUseTool {
  const allowed = new Set(record.allowedTools);
  const disallowed = new Set(record.disallowedTools);

  return async (toolName, input, details): Promise<PermissionResult> => {
    if (disallowed.has(toolName)) {
      return deny(toolName, details.toolUseID, `Tool ${toolName} is disallowed by companion policy.`);
    }

    if (record.permissionPolicy === "bypass") {
      return {
        behavior: "allow",
        updatedPermissions: details.suggestions,
        toolUseID: details.toolUseID,
      };
    }

    if (record.mode === "read-only" && MUTATING_TOOLS.has(toolName)) {
      return deny(toolName, details.toolUseID, `Read-only companion mode denied ${toolName}.`);
    }

    if (record.permissionPolicy === "strict" && !allowed.has(toolName)) {
      return deny(toolName, details.toolUseID, `Tool ${toolName} is not in allowedTools.`);
    }

    if (record.permissionPolicy === "balanced") {
      const blocked = findOutOfScopePath(record.cwd, input, details.blockedPath);
      if (blocked) {
        return deny(toolName, details.toolUseID, `Path is outside companion cwd: ${blocked}`);
      }
    }

    return {
      behavior: "allow",
      updatedPermissions: details.suggestions,
      toolUseID: details.toolUseID,
    };
  };
}

function deny(toolName: string, toolUseID: string, message: string): PermissionResult {
  return {
    behavior: "deny",
    message: `${message} Tool: ${toolName}`,
    toolUseID,
  };
}

function buildPrompt(prompt: string, record: CompanionRecord): string {
  return [
    "<cc_in_codex_context>",
    "Codex is the lead agent. You are the persistent Claude Code companion for implementation work.",
    `cwd: ${record.cwd}`,
    `mode: ${record.mode}`,
    `permission_policy: ${record.permissionPolicy}`,
    record.sessionId ? `resume_session_id: ${record.sessionId}` : "resume_session_id: new",
    "The user only talks to Codex. Do not ask the user directly; report blockers to Codex.",
    "Use the repository context directly. Prefer reading AGENTS.md and CLAUDE.md when present.",
    "</cc_in_codex_context>",
    "",
    "<division_of_labor>",
    "Codex handles scientific reasoning, task decomposition, review, and final synthesis.",
    "Claude Code handles coding execution, repository inspection, edits, tests, refactors, and subagent orchestration when useful.",
    "Use Claude Code capabilities naturally, including project instructions, skills, hooks, and subagents where they improve execution.",
    "</division_of_labor>",
    "",
    "<efficiency_rules>",
    "Do not repeat large file contents unless necessary.",
    "Do not summarize the whole repository. Inspect only what the task requires.",
    "Make the smallest coherent changes that satisfy the task.",
    "Stop and report if the task is ambiguous, risky, blocked, or exceeding budget.",
    "</efficiency_rules>",
    "",
    "<task>",
    prompt,
    "</task>",
    "",
    "<output_contract>",
    "Return a concise engineering report for Codex:",
    "1. What you changed or found.",
    "2. Files touched, if any.",
    "3. Verification performed with exact commands/results.",
    "4. Remaining risks or blockers.",
    "5. Suggested next Codex action, if useful.",
    "</output_contract>",
  ].join("\n");
}

function buildTuiBootstrap(record: CompanionRecord): string {
  // Sent once per live tmux pane to establish the companion contract; tasks ride lean afterward.
  return [
    "cc-in-codex companion session.",
    "Codex is the lead agent; you are the persistent Claude Code execution companion in this terminal.",
    `Work in cwd ${record.cwd}.`,
    `Mode: ${record.mode}; permission policy: ${record.permissionPolicy}.`,
    "Use project instructions from AGENTS.md and CLAUDE.md when relevant.",
    "Do not ask the user directly; report blockers to Codex.",
    "Keep context high-signal, avoid dumping large file contents, and make focused verifiable changes.",
    "For each task, return a concise report for Codex: changes/findings, files touched, exact verification, risks/blockers, and suggested next action.",
  ]
    .map(compactForTui)
    .join(" ");
}

function buildTuiTaskPrompt(prompt: string): string {
  return `Task: ${compactForTui(prompt)}`;
}

function compactForTui(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildSystemAppend(): string {
  return [
    "You are the user's persistent Claude Code companion behind Codex.",
    "Codex is the lead agent; you are the execution specialist.",
    "Preserve continuity across turns, use the current repository working directory, and keep context high-signal.",
    "Use Claude Code's normal local capabilities and project instructions. If subagents, skills, hooks, or todos help, use them.",
    "Avoid unrelated changes. Prefer small, verifiable edits. Run relevant checks when practical.",
    "Report concise implementation details, verification, and risks back to Codex.",
  ].join(" ");
}

function applySdkMessage(record: CompanionRecord, message: SDKMessage): CompanionRecord {
  if (message.type === "assistant") {
    const text = extractAssistantText(message);
    if (text) return pushEvent(record, { type: "assistant", text, raw: message });
  }

  if (message.type === "result") {
    if (message.subtype === "success") {
      return pushEvent(record, { type: "result", text: message.result, raw: message });
    }
    const text = message.errors.join("\n") || message.stop_reason || message.subtype;
    return pushEvent(record, { type: "error", text, raw: message });
  }

  if (message.type === "system") {
    const text = summarizeSystemMessage(message);
    if (text) return pushEvent(record, { type: "progress", text, raw: message });
  }

  if (message.type === "tool_use_summary") {
    return pushEvent(record, { type: "tool", text: message.summary, raw: message });
  }

  if (message.type === "tool_progress") {
    return pushEvent(record, {
      type: "tool",
      text: `${message.tool_name}: ${message.elapsed_time_seconds}s`,
      raw: message,
    });
  }

  if (message.type === "prompt_suggestion") {
    return pushEvent(record, { type: "progress", text: `Prompt suggestion: ${message.suggestion}`, raw: message });
  }

  return record;
}

function captureSessionId(record: CompanionRecord, message: SDKMessage): CompanionRecord {
  if ("session_id" in message && typeof message.session_id === "string") {
    return { ...record, sessionId: message.session_id };
  }
  return record;
}

function extractAssistantText(message: Extract<SDKMessage, { type: "assistant" }>): string {
  return message.message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[tool:${block.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeSystemMessage(message: Extract<SDKMessage, { type: "system" }>): string | undefined {
  switch (message.subtype) {
    case "init":
      return `Claude session initialized: ${message.session_id}`;
    case "task_started":
      return `Task started: ${message.description}`;
    case "task_progress":
      return message.summary ?? `Task progress: ${message.description}`;
    case "task_updated":
      return `Task updated: ${JSON.stringify(message.patch)}`;
    case "task_notification":
      return `Task ${message.status}: ${message.summary}`;
    case "files_persisted":
      return `Files persisted: ${message.files.length} ok, ${message.failed.length} failed`;
    case "status":
      return `Claude status: ${message.status}`;
    case "worker_shutting_down":
      return `Claude worker shutting down: ${message.reason}`;
    default:
      return undefined;
  }
}

function installStopLoss(handle: RunHandle, record: CompanionRecord): void {
  if (record.maxRuntimeMs > 0) {
    handle.timeout = setTimeout(() => {
      handle.abortController.abort(new Error(`Max runtime exceeded: ${record.maxRuntimeMs}ms`));
    }, record.maxRuntimeMs);
  }

  if (record.stallTimeoutMs && record.stallTimeoutMs > 0) {
    handle.stallTimer = setInterval(() => {
      if (Date.now() - handle.lastProgressAt > record.stallTimeoutMs!) {
        handle.abortController.abort(new Error(`No Claude progress for ${record.stallTimeoutMs}ms`));
      }
    }, Math.min(record.stallTimeoutMs, 30_000));
    handle.stallTimer.unref?.();
  }

  handle.timeout?.unref?.();
}

function clearRunTimers(handle: RunHandle): void {
  if (handle.timeout) clearTimeout(handle.timeout);
  if (handle.stallTimer) clearInterval(handle.stallTimer);
}

function touchRun(cwd: string): void {
  const handle = running.get(cwd);
  if (handle) handle.lastProgressAt = Date.now();
}

function stopRun(cwd: string, reason: string): void {
  const handle = running.get(cwd);
  if (!handle) return;
  handle.abortController.abort(new Error(reason));
  clearRunTimers(handle);
  running.delete(cwd);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reconcileRecord(record: CompanionRecord): Promise<CompanionRecord> {
  if (record.maxBudgetUsd !== undefined) {
    record = await updateRecord({ ...record, maxBudgetUsd: undefined });
  }

  if (!record.backend) {
    record = await updateRecord({ ...record, backend: "sdk" });
  }

  if (record.backend === "tui") {
    record = await bindTuiSessionIdFromStatusline(record);
    if (
      record.status === "running" &&
      record.activeRun &&
      record.lastResult?.runId === record.activeRun.runId &&
      record.lastResult.status === "success"
    ) {
      return updateRecord({ ...record, status: "idle", activeRun: undefined });
    }
    return record;
  }

  if (record.status === "running" && !running.has(record.cwd)) {
    return updateRecord(
      pushEvent(
        {
          ...record,
          status: "stale",
          activeRun: undefined,
          lastError:
            "The MCP server no longer owns this running process, probably because it restarted. Resume the same Claude session with companion_send.",
        },
        {
          type: "system",
          text: "Marked stale: runtime process is gone, but Claude session metadata was preserved.",
        },
      ),
    );
  }
  return record;
}

async function bindTuiSessionIdFromStatusline(record: CompanionRecord): Promise<CompanionRecord> {
  const snapshot = await loadStatuslineSnapshot(record.cwd);
  if (!snapshot?.sessionId || snapshot.sessionId === record.sessionId) return record;
  return updateRecord(
    pushEvent(
      {
        ...record,
        sessionId: snapshot.sessionId,
      },
      {
        type: "system",
        text: `Captured Claude Code session id from statusline: ${snapshot.sessionId}.`,
      },
    ),
  );
}

function publicRecord(record: CompanionRecord, limit = record.events.length): CompanionRecord {
  return {
    ...record,
    events: record.events.slice(-limit).map(publicEvent),
  };
}

function publicEvent(event: CompanionEvent): CompanionEvent {
  return {
    id: event.id,
    at: event.at,
    type: event.type,
    text: event.text,
  };
}

function toSendResult(
  record: CompanionRecord,
  result: string,
  costUsd?: number,
  turns?: number,
): SendResult {
  // TUI sends are fire-and-forget; the streamed event log lives in the attached pane, so keep
  // the returned breadcrumb trail short. SDK sends still carry the full recent buffer.
  const eventLimit = record.backend === "tui" ? 8 : 80;
  return {
    cwd: record.cwd,
    sessionId: record.sessionId,
    resumeCommand: record.resumeCommand,
    backend: record.backend,
    tmuxSessionName: record.tmuxSessionName,
    attachCommand: record.attachCommand,
    runId: record.lastResult?.runId,
    status: record.status,
    result,
    costUsd,
    turns,
    events: record.events.slice(-eventLimit).map(publicEvent),
  };
}

function toTuiControlResult(record: CompanionRecord, result: string): SendResult {
  return {
    cwd: record.cwd,
    sessionId: record.sessionId,
    resumeCommand: record.resumeCommand,
    backend: record.backend,
    tmuxSessionName: record.tmuxSessionName,
    attachCommand: record.attachCommand,
    status: record.status,
    result,
    events: record.events.slice(-8).map(publicEvent),
  };
}

function tuiSentMessage(record: Pick<CompanionRecord, "tmuxSessionName" | "attachCommand">): string {
  return [
    "Sent prompt to the Claude Code TUI session.",
    record.attachCommand ? `Attach with: ${record.attachCommand}` : undefined,
    record.tmuxSessionName ? `tmux session: ${record.tmuxSessionName}` : undefined,
    "The MCP server cannot reliably infer completion from the full-screen TUI yet; monitor or take over in the attached terminal.",
  ]
    .filter(Boolean)
    .join("\n");
}

function describeResume(session: TuiSessionInfo, input: CompanionResumeInput): string {
  if (session.launchMode === "existing") {
    return `Reusing Claude Code TUI session ${session.tmuxSessionName}. Attach with: ${session.attachCommand}`;
  }
  if (input.sessionId) {
    return `Started Claude Code TUI with --resume ${input.sessionId}. Attach with: ${session.attachCommand}`;
  }
  if (input.continueLatest) {
    return [
      "Started Claude Code TUI with --continue for this cwd.",
      `Attach with: ${session.attachCommand}`,
      "If statusline capture is configured, cc-in-codex will bind the resumed session id after Claude Code reports it.",
    ].join(" ");
  }
  return `Started Claude Code TUI session. Attach with: ${session.attachCommand}`;
}

function detectLocalClaudePath(): string | undefined {
  const explicit = process.env.CC_IN_CODEX_CLAUDE_PATH ?? process.env.CLAUDE_CODE_PATH;
  if (explicit) return explicit;
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function findOutOfScopePath(
  cwd: string,
  input: Record<string, unknown>,
  blockedPath?: string,
): string | undefined {
  const paths = new Set<string>();
  if (blockedPath) paths.add(blockedPath);
  for (const key of ["file_path", "path", "cwd", "directory", "dir", "source", "target", "destination"]) {
    const value = input[key];
    if (typeof value === "string") paths.add(value);
  }

  for (const candidate of paths) {
    if (!looksLikePath(candidate)) continue;
    const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    const rel = relative(cwd, absolute);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) continue;
    return absolute;
  }
  return undefined;
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith(".") || value.includes("/");
}
