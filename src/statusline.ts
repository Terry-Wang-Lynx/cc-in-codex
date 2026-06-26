import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { normalizeCwd } from "./state.js";

export interface StatuslineSnapshot {
  cwd: string;
  sessionId?: string;
  capturedAt: string;
  model?: {
    id?: string;
    displayName?: string;
  };
  contextWindow?: {
    size?: number;
    usedPercentage?: number;
    remainingPercentage?: number;
    currentInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    usedTokens?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
  };
  rateLimits?: unknown;
}

interface ClaudeStatuslineInput {
  session_id?: string;
  model?: {
    id?: string;
    display_name?: string;
  };
  workspace?: {
    project_dir?: string;
  };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  rate_limits?: unknown;
}

export async function runStatuslineCommand(): Promise<void> {
  const input = await readStdin();
  const parsed = JSON.parse(input) as ClaudeStatuslineInput;
  const snapshot = toSnapshot(parsed);
  await writeStatuslineSnapshot(snapshot);
  process.stdout.write(formatStatusline(snapshot));
}

export async function loadStatuslineSnapshot(
  cwd?: string,
  maxAgeMs = 5 * 60 * 1000,
): Promise<(StatuslineSnapshot & { ageMs: number }) | undefined> {
  const path = statuslineSnapshotPath(normalizeCwd(cwd));
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StatuslineSnapshot;
    const ageMs = Date.now() - Date.parse(parsed.capturedAt);
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) return undefined;
    return { ...parsed, ageMs };
  } catch {
    return undefined;
  }
}

function toSnapshot(input: ClaudeStatuslineInput): StatuslineSnapshot {
  const cwd = normalizeCwd(input.workspace?.project_dir);
  const current = input.context_window?.current_usage;
  const currentInputTokens = current?.input_tokens;
  const cacheCreationInputTokens = current?.cache_creation_input_tokens;
  const cacheReadInputTokens = current?.cache_read_input_tokens;
  const usedTokens = sumNumbers(currentInputTokens, cacheCreationInputTokens, cacheReadInputTokens);
  const size = input.context_window?.context_window_size;
  const usedPercentage =
    input.context_window?.used_percentage ??
    (size && usedTokens !== undefined ? (usedTokens * 100) / size : undefined);
  const remainingPercentage =
    input.context_window?.remaining_percentage ??
    (usedPercentage !== undefined ? Math.max(0, 100 - usedPercentage) : undefined);

  return {
    cwd,
    sessionId: input.session_id,
    capturedAt: new Date().toISOString(),
    model: {
      id: input.model?.id,
      displayName: input.model?.display_name,
    },
    contextWindow: {
      size,
      usedPercentage,
      remainingPercentage,
      currentInputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      usedTokens,
      totalInputTokens: input.context_window?.total_input_tokens,
      totalOutputTokens: input.context_window?.total_output_tokens,
    },
    rateLimits: input.rate_limits,
  };
}

async function writeStatuslineSnapshot(snapshot: StatuslineSnapshot): Promise<void> {
  const path = statuslineSnapshotPath(snapshot.cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function statuslineSnapshotPath(cwd: string): string {
  const hash = createHash("sha1").update(normalizeCwd(cwd)).digest("hex").slice(0, 16);
  return resolve(homedir(), ".cc-in-codex", "statusline", `${hash}.json`);
}

function formatStatusline(snapshot: StatuslineSnapshot): string {
  const model = snapshot.model?.displayName ?? "Claude";
  const remaining = snapshot.contextWindow?.remainingPercentage;
  const used = snapshot.contextWindow?.usedPercentage;
  if (typeof remaining === "number" && typeof used === "number") {
    return `cc-in-codex | ${model} | ctx ${used.toFixed(1)}% used, ${remaining.toFixed(1)}% left`;
  }
  return `cc-in-codex | ${model}`;
}

function sumNumbers(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  if (!present.length) return undefined;
  return present.reduce((sum, value) => sum + value, 0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
