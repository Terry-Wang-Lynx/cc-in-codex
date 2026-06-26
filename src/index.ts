#!/usr/bin/env node
import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { runStatuslineCommand } from "./statusline.js";
import { ensureTuiSession, killTuiSession, tmuxSessionNameForCwd } from "./tui.js";

if (process.argv[2] === "statusline") {
  try {
    await runStatuslineCommand();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`cc-in-codex statusline error: ${message}`);
    process.exit(0);
  }
}

if (process.argv[2] === "attach") {
  try {
    const options = parseAttachArgs(process.argv.slice(3));
    if (options.replace) {
      killTuiSession(tmuxSessionNameForCwd(options.cwd));
    }
    const session = ensureTuiSession({
      cwd: options.cwd,
      sessionId: options.sessionId,
      continueLatest: options.continueLatest,
    });
    console.error(`Attaching to Claude Code TUI: ${session.tmuxSessionName}`);
    console.error("Detach with tmux prefix + d.");
    const child = spawn("tmux", ["attach", "-t", session.tmuxSessionName], { stdio: "inherit" });
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (exitCode) => resolve(exitCode));
    });
    process.exit(code ?? 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

interface AttachOptions {
  cwd: string;
  sessionId?: string;
  continueLatest?: boolean;
  replace?: boolean;
}

function parseAttachArgs(args: string[]): AttachOptions {
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let continueLatest = false;
  let replace = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--continue" || arg === "-c") {
      continueLatest = true;
      continue;
    }
    if (arg === "--replace") {
      replace = true;
      continue;
    }
    if (arg === "--resume" || arg === "-r") {
      sessionId = args[index + 1];
      if (!sessionId) throw new Error(`${arg} needs a Claude Code session id.`);
      index += 1;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      sessionId = arg.slice("--resume=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printAttachHelp();
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown attach option: ${arg}`);
    }
    if (cwd) throw new Error(`Unexpected extra attach argument: ${arg}`);
    cwd = arg;
  }

  if (sessionId && continueLatest) {
    throw new Error("Use either --resume <session-id> or --continue, not both.");
  }

  return { cwd: cwd ?? process.cwd(), sessionId, continueLatest, replace };
}

function printAttachHelp(): void {
  console.error(`Usage: cc-in-codex attach [cwd] [--continue | --resume <session-id>] [--replace]

Open or attach the tmux-hosted Claude Code TUI for a project.

Options:
  -c, --continue              Start Claude Code with --continue for the cwd.
  -r, --resume <session-id>   Start Claude Code with --resume <session-id>.
      --replace               Kill the existing cc-in-codex tmux pane first.
  -h, --help                  Show this help.
`);
}

const server = createServer();
const transport = new StdioServerTransport();

await server.connect(transport);
