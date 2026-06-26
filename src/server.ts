import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  cancelCompanion,
  companionRecent,
  companionResult,
  companionStatus,
  companionTuiCompactCheck,
  companionTuiCompact,
  companionTuiRaw,
  companionTuiScreen,
  openCompanion,
  resetCompanion,
  resumeCompanion,
  startCompanionRun,
  sendToCompanion,
} from "./manager.js";
import { initProject } from "./project.js";
import { DEFAULT_ALLOWED_TOOLS, READ_ONLY_TOOLS } from "./state.js";

const modeSchema = z.enum(["read-only", "workspace-write"]).optional();
const backendSchema = z.enum(["sdk", "tui"]).optional();
const permissionPolicySchema = z.enum(["balanced", "trusted", "strict"]).optional();
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();

const configShape = {
  cwd: z.string().optional().describe("Project working directory. Defaults to the MCP server cwd."),
  title: z.string().optional().describe("Human-readable companion title."),
  backend: backendSchema.describe(
    "Companion backend. sdk is the default managed Claude Agent SDK path; tui opens a native Claude Code CLI in tmux.",
  ),
  mode: modeSchema.describe(
    "SDK backend: read-only denies mutating tools; workspace-write may edit files. TUI backend receives this as visible companion context and still relies on Claude Code CLI/user supervision.",
  ),
  permissionPolicy: permissionPolicySchema.describe(
    "SDK backend policy: balanced allows local project work and blocks detected out-of-cwd paths; trusted allows all non-disallowed tools; strict allows only allowedTools. TUI backend is human-visible and cannot enforce the same path-level MCP guardrails.",
  ),
  model: z.string().optional().describe("Optional Claude model override. Omit to use Claude Code defaults."),
  effort: effortSchema.describe("Optional Claude effort override. Defaults to high."),
  maxTurns: z.number().int().positive().optional().describe("Optional max agent turns for a single send."),
  maxBudgetUsd: z
    .number()
    .positive()
    .optional()
    .describe("Optional SDK USD stop-loss cap for a single Claude turn. Omit for normal Claude Max/subscription workflows unless you explicitly want a hard per-turn cap."),
  maxRuntimeMs: z.number().int().positive().optional().describe("Stop-loss wall clock timeout for a single run."),
  stallTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Stop-loss timeout when no Claude SDK progress events arrive."),
  claudePath: z
    .string()
    .optional()
    .describe("Optional local Claude Code executable path. Defaults to the local `claude` on PATH."),
  tmuxSessionName: z
    .string()
    .optional()
    .describe("Optional tmux session name for the tui backend. Defaults to a stable project-derived name."),
  allowedTools: z.array(z.string()).optional().describe("Optional auto-allowed Claude Code tools."),
  disallowedTools: z.array(z.string()).optional().describe("Optional tools removed from use."),
};

const resumeShape = {
  ...configShape,
  sessionId: z
    .string()
    .optional()
    .describe("Existing Claude Code session id to bind/resume, equivalent to `claude --resume <session-id>`."),
  continueLatest: z
    .boolean()
    .optional()
    .describe("For the TUI backend only: launch Claude Code with `--continue` for the most recent conversation in this cwd."),
  replaceTui: z
    .boolean()
    .optional()
    .describe("For the TUI backend: close the existing tmux pane before launching the requested resumed conversation."),
};

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "cc-in-codex",
      version: "0.1.0",
      title: "Claude Code Companion for Codex",
      description:
        "Gives Codex one persistent local Claude Code companion per project. Use companion_send to continue the same Claude session instead of starting one-shot tasks.",
    },
    {
      instructions: [
        "You are Codex, the lead agent. Use this MCP server when Claude Code should act as your persistent coding companion.",
        "For the same project cwd, use the existing companion. The server automatically resumes the existing Claude Code session.",
        "Use companion_start for long coding work, companion_recent/status to monitor, companion_cancel to stop loss, and companion_result to collect final output.",
        "Use companion_resume to bind an existing Claude Code session id, or to start the visible TUI with `claude --continue` for an existing project conversation.",
        "Use companion_tui_open and companion_tui_send when the user wants a visible native Claude Code TUI that Codex can drive and the user can attach to.",
        "Use companion_tui_raw for slash commands or control keys (e.g. /clear, C-c) in that TUI, and companion_tui_screen to read what the user sees.",
        "Use companion_tui_compact_check before companion_tui_compact; compact only at a clean checkpoint with enough estimated context pressure.",
        "Do not paste large repo summaries. Give Claude Code the task, constraints, and acceptance criteria; let it inspect the repository itself.",
        "You are responsible for reviewing Claude's result before answering the user.",
      ].join("\n"),
      capabilities: { tools: {}, resources: {} },
    },
  );

  server.registerTool(
    "companion_open",
    {
      title: "Open Companion",
      description:
        "Create or restore the persistent Claude Code companion for a project cwd. This does not send work to Claude.",
      inputSchema: configShape,
    },
    async (input) => jsonResult(await openCompanion(input)),
  );

  server.registerTool(
    "companion_resume",
    {
      title: "Resume Existing Claude Code Session",
      description:
        "Bind cc-in-codex to an existing Claude Code conversation. SDK needs sessionId; TUI can use sessionId or continueLatest:true.",
      inputSchema: resumeShape,
    },
    async (input) => jsonResult(await resumeCompanion(input)),
  );

  server.registerTool(
    "companion_send",
    {
      title: "Send To Companion",
      description:
        "Send a short task or follow-up to the persistent Claude Code companion and wait for completion. For long coding work, prefer companion_start plus polling.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("Task or follow-up for Claude Code. Keep it goal-oriented; do not paste large repo summaries."),
        ...configShape,
      },
    },
    async (input) => {
      const { prompt, ...config } = input;
      return jsonResult(await sendToCompanion(prompt, config));
    },
  );

  server.registerTool(
    "companion_tui_open",
    {
      title: "Open Visible Claude Code TUI",
      description:
        "Create or restore a native Claude Code CLI in tmux for this project. Returns the attach command for the side terminal.",
      inputSchema: configShape,
    },
    async (input) => jsonResult(await openCompanion({ ...input, backend: "tui" })),
  );

  server.registerTool(
    "companion_tui_resume",
    {
      title: "Resume Existing Session In Visible TUI",
      description:
        "Launch the visible tmux-hosted Claude Code CLI with `--resume <sessionId>` or `--continue`, then bind it to this project companion.",
      inputSchema: resumeShape,
    },
    async (input) => jsonResult(await resumeCompanion({ ...input, backend: "tui" })),
  );

  server.registerTool(
    "companion_tui_send",
    {
      title: "Send To Visible Claude Code TUI",
      description:
        "Paste a prompt into the persistent native Claude Code TUI and press Enter. Returns immediately with the tmux attach command.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("Task or follow-up for Claude Code. It is pasted into the visible Claude Code CLI."),
        ...configShape,
      },
    },
    async (input) => {
      const { prompt, ...config } = input;
      return jsonResult(await sendToCompanion(prompt, { ...config, backend: "tui" }));
    },
  );

  server.registerTool(
    "companion_tui_raw",
    {
      title: "Send Raw Input To Claude Code TUI",
      description:
        "Send literal text and/or tmux key names to the existing Claude Code TUI pane without the cc-in-codex wrapper. Use for slash commands (e.g. /clear), control keys (C-c), or Escape. Requires an open tui session.",
      inputSchema: {
        cwd: z.string().optional(),
        text: z
          .string()
          .optional()
          .describe("Literal text pasted into the pane as-is (no cc-in-codex framing)."),
        keys: z
          .array(z.string())
          .optional()
          .describe('tmux key names sent after text, e.g. ["Enter"], ["C-c"], ["Escape"].'),
        enter: z
          .boolean()
          .optional()
          .describe("Press Enter after the input. Defaults to true for a plain text send with no keys."),
      },
    },
    async (input) => jsonResult(await companionTuiRaw(input)),
  );

  server.registerTool(
    "companion_tui_compact_check",
    {
      title: "Check Claude Code TUI Compact Readiness",
      description:
        "Inspect the visible Claude Code TUI and cc-in-codex metadata to decide whether this is a good checkpoint to run /compact. This is a heuristic, not a true token-limit reading.",
      inputSchema: {
        cwd: z.string().optional(),
        lines: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Recent pane lines to inspect. Defaults to 500."),
      },
    },
    async (input) => jsonResult(await companionTuiCompactCheck(input)),
  );

  server.registerTool(
    "companion_tui_compact",
    {
      title: "Compact Claude Code TUI Context",
      description:
        "Ask the visible Claude Code TUI to run /compact with cc-in-codex-aware preservation instructions. Prefer companion_tui_compact_check first.",
      inputSchema: {
        cwd: z.string().optional(),
        instructions: z
          .string()
          .optional()
          .describe("Optional extra instructions for what Claude Code should preserve during /compact."),
      },
    },
    async (input) => jsonResult(await companionTuiCompact(input)),
  );

  server.registerTool(
    "companion_tui_screen",
    {
      title: "Read Visible Claude Code TUI Screen",
      description:
        "Capture recent text from the persistent tmux-hosted Claude Code TUI so Codex can monitor what the user sees.",
      inputSchema: {
        cwd: z.string().optional(),
        lines: z.number().int().positive().max(500).optional(),
      },
    },
    async (input) => jsonResult(await companionTuiScreen(input.cwd, input.lines)),
  );

  server.registerTool(
    "companion_start",
    {
      title: "Start Companion Run",
      description:
        "Start a background Claude Code companion run for this cwd. Returns quickly with runId; use companion_status/recent/result to monitor.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("Task or follow-up for Claude Code. Give goals, constraints, and acceptance criteria."),
        ...configShape,
      },
    },
    async (input) => {
      const { prompt, ...config } = input;
      return jsonResult(await startCompanionRun(prompt, config));
    },
  );

  server.registerTool(
    "companion_recent",
    {
      title: "Recent Companion Context",
      description:
        "Read recent events from the persistent companion, similar to scrolling the Claude Code window.",
      inputSchema: {
        cwd: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (input) => jsonResult((await companionRecent(input.cwd, input.limit)) ?? { found: false }),
  );

  server.registerTool(
    "companion_result",
    {
      title: "Companion Result",
      description:
        "Read the latest companion result, resume command, and session metadata for a cwd.",
      inputSchema: {
        cwd: z.string().optional(),
      },
    },
    async (input) => jsonResult((await companionResult(input.cwd)) ?? { found: false }),
  );

  server.registerTool(
    "companion_status",
    {
      title: "Companion Status",
      description: "Inspect the current companion session for a cwd.",
      inputSchema: {
        cwd: z.string().optional(),
      },
    },
    async (input) => jsonResult((await companionStatus(input.cwd)) ?? { found: false }),
  );

  server.registerTool(
    "companion_cancel",
    {
      title: "Cancel Companion",
      description: "Cancel the currently running companion turn for a cwd, if any.",
      inputSchema: {
        cwd: z.string().optional(),
      },
    },
    async (input) => jsonResult((await cancelCompanion(input.cwd)) ?? { found: false }),
  );

  server.registerTool(
    "companion_init_project",
    {
      title: "Initialize Shared Project Context",
      description:
        "Create AGENTS.md and CLAUDE.md in the project cwd so Codex and Claude Code share the same project instructions. Existing files are skipped unless force=true.",
      inputSchema: {
        cwd: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async (input) => jsonResult(await initProject(input.cwd, input.force ?? false)),
  );

  server.registerTool(
    "companion_reset",
    {
      title: "Reset Companion",
      description:
        "Forget the project-to-Claude-session binding for a cwd. Use only when the user wants a fresh Claude Code companion.",
      inputSchema: {
        cwd: z.string().optional(),
      },
    },
    async (input) => jsonResult({ reset: await resetCompanion(input.cwd) }),
  );

  server.registerResource(
    "companion_policy",
    "cc-in-codex:///policy",
    {
      title: "Companion Policy",
      description: "Default tool policy and interaction rules for the Claude Code companion.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(
            {
              defaultMode: "workspace-write",
              defaultPermissionPolicy: "balanced",
              readOnlyTools: READ_ONLY_TOOLS,
              workspaceWriteTools: DEFAULT_ALLOWED_TOOLS,
              rule: "Codex leads; Claude Code executes as a persistent local companion per cwd using the local Claude Code login.",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

function jsonResult(value: unknown) {
  const structuredContent =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}
