#!/usr/bin/env node
// Thin per-turn client spawned by OpenClaw as a CLI backend. Reads the
// prompt from stdin, forwards the turn to the warm daemon over a unix
// socket (starting the daemon if needed), and prints claude-stream-json
// events on stdout. All heavy lifting stays in the daemon.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractMcpConfigPath, loadResolvedMcpServers } from "../lib/mcp.mjs";
import { SOCKET_PATH, STATE_DIR } from "../lib/paths.mjs";

const DAEMON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs");

function parseArgs(argv) {
  const parsed = {
    transport: "acp",
    model: undefined,
    thinking: undefined,
    resume: undefined,
    images: [],
    mcpConfigPath: extractMcpConfigPath(argv),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--transport":
        parsed.transport = argv[++i];
        break;
      case "--model":
        parsed.model = argv[++i];
        break;
      case "--thinking":
        parsed.thinking = argv[++i];
        break;
      case "--resume":
        parsed.resume = argv[++i];
        break;
      case "--image":
        parsed.images.push(argv[++i]);
        break;
      default:
        // -p, --output-format, --trust, --strict-mcp-config, --mcp-config <path>
        // and anything else OpenClaw appends are accepted and ignored.
        break;
    }
  }
  return parsed;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

function connectOnce() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function connectWithSpawn() {
  try {
    return await connectOnce();
  } catch {
    // Daemon not running; start it detached and poll for the socket.
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    try {
      return await connectOnce();
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("openclaw-cursor-turbo daemon did not start within 15s");
}

const parsed = parseArgs(process.argv.slice(2));
const prompt = (await readStdin()).trim();
const mcpServers = loadResolvedMcpServers(parsed.mcpConfigPath, process.env);

let socket;
try {
  socket = await connectWithSpawn();
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: error.message })}\n`,
  );
  process.exit(1);
}

const request = {
  type: "turn",
  transport: parsed.transport,
  cwd: process.cwd(),
  model: parsed.model,
  thinkingLevel: parsed.thinking,
  prompt,
  imagePaths: parsed.images,
  resume: parsed.resume,
  mcpServers,
};
socket.write(`${JSON.stringify(request)}\n`);

let sawError = false;
let buf = "";
socket.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    process.stdout.write(`${line}\n`);
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && event.is_error) sawError = true;
    } catch {
      // Pass through verbatim.
    }
  }
});
socket.on("end", () => process.exit(sawError ? 1 : 0));
socket.on("error", (error) => {
  process.stdout.write(
    `${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: `daemon connection lost: ${error.message}` })}\n`,
  );
  process.exit(1);
});
