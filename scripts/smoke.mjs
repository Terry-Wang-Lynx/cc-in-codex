import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCompanion, resumeCompanion } from "../dist/manager.js";

const root = new URL("..", import.meta.url);
const distIndex = new URL("../dist/index.js", import.meta.url);

await assertMcpTools();
await assertSdkResumeBinding();
assertAttachHelp();

console.log("cc-in-codex smoke ok");

async function assertMcpTools() {
  const tools = await listMcpTools();
  const required = [
    "companion_open",
    "companion_resume",
    "companion_send",
    "companion_tui_open",
    "companion_tui_resume",
    "companion_tui_send",
    "companion_tui_raw",
    "companion_tui_compact_check",
    "companion_tui_compact",
    "companion_tui_screen",
    "companion_start",
    "companion_recent",
    "companion_result",
    "companion_status",
    "companion_cancel",
    "companion_init_project",
    "companion_reset",
  ];
  for (const name of required) {
    if (!tools.includes(name)) throw new Error(`MCP tool missing: ${name}`);
  }
}

function listMcpTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distIndex.pathname], {
      cwd: root.pathname,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let nextId = 1;
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for MCP tools/list."));
    }, 5000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) reject(new Error(stderr || `MCP server exited with ${code}`));
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 1) send("tools/list", {});
        if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(message.result.tools.map((tool) => tool.name));
        }
      }
    });

    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cc-in-codex-smoke", version: "0.0.0" },
    });

    function send(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })}\n`);
    }
  });
}

async function assertSdkResumeBinding() {
  const cwd = await mkdtemp(join(tmpdir(), "ccic-smoke-"));
  const sessionId = "00000000-0000-0000-0000-000000000000";
  try {
    const record = await resumeCompanion({ cwd, backend: "sdk", sessionId });
    if (record.sessionId !== sessionId) throw new Error("SDK resume did not bind sessionId.");
    if (!record.resumeCommand?.includes(sessionId)) throw new Error("SDK resume command missing sessionId.");
  } finally {
    await resetCompanion(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

function assertAttachHelp() {
  const result = spawnSync(process.execPath, [distIndex.pathname, "attach", "--help"], {
    cwd: root.pathname,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "attach --help failed.");
  if (!result.stderr.includes("--continue") || !result.stderr.includes("--resume")) {
    throw new Error("attach help does not describe resume options.");
  }
}
