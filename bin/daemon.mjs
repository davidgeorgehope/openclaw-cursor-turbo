#!/usr/bin/env node
// Warm daemon: holds a persistent `agent acp` child and in-process
// @cursor/sdk agents. Shims connect over a unix socket, send one turn
// request as a JSON line, and stream back claude-stream-json events.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { AcpTransport } from "../lib/acp-transport.mjs";
import { SdkTransport } from "../lib/sdk-transport.mjs";
import { LOG_PATH, PID_PATH, SOCKET_PATH, STATE_DIR } from "../lib/paths.mjs";

const IDLE_EXIT_MS = 2 * 60 * 60 * 1000;

fs.mkdirSync(STATE_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
function log(message) {
  logStream.write(`${new Date().toISOString()} ${message}\n`);
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

const config = loadConfig();
const acp = new AcpTransport({ command: config.acpCommand ?? "agent", log });
const sdk = new SdkTransport({ apiKey: config.apiKey, log });

let lastActivity = Date.now();
setInterval(() => {
  if (Date.now() - lastActivity > IDLE_EXIT_MS) {
    log("idle timeout; exiting");
    shutdown(0);
  }
}, 60e3).unref();

async function handleTurn(request, socket) {
  const transport = request.transport === "sdk" ? sdk : acp;
  log(
    `turn: transport=${request.transport} resume=${request.resume ?? "-"} model=${request.model ?? "-"} cwd=${request.cwd} mcp=${Object.keys(request.mcpServers ?? {}).join(",") || "-"}`,
  );
  const emit = (event) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
  };
  try {
    await transport.runTurn(request, emit);
  } catch (error) {
    log(`turn failed (${request.transport}): ${error.stack ?? error.message}`);
    if (error?.rpc) log(`rpc error data: ${JSON.stringify(error.rpc)}`);
    log(`request mcpServers: ${JSON.stringify(request.mcpServers ?? {}).slice(0, 2000)}`);
    emit({
      type: "result",
      subtype: "error",
      is_error: true,
      result: `openclaw-cursor-turbo daemon error: ${error.message}`,
      session_id: request.resume,
    });
  } finally {
    socket.end();
  }
}

const server = net.createServer((socket) => {
  lastActivity = Date.now();
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    const idx = buf.indexOf("\n");
    if (idx < 0) return;
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      socket.end(`${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: `bad request: ${error.message}` })}\n`);
      return;
    }
    lastActivity = Date.now();
    if (request.type === "ping") {
      socket.end(`${JSON.stringify({ type: "pong", pid: process.pid })}\n`);
      return;
    }
    if (request.type === "stop") {
      socket.end(`${JSON.stringify({ type: "stopping" })}\n`);
      shutdown(0);
      return;
    }
    if (request.type === "turn") {
      void handleTurn(request, socket);
      return;
    }
    socket.end(`${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: `unknown request type: ${request.type}` })}\n`);
  });
  socket.on("error", () => {});
});

function shutdown(code) {
  try {
    server.close();
  } catch {}
  acp.stop();
  void sdk.stop().finally(() => {
    try {
      fs.rmSync(SOCKET_PATH, { force: true });
      fs.rmSync(PID_PATH, { force: true });
    } catch {}
    process.exit(code);
  });
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", (error) => {
  log(`uncaught: ${error.stack}`);
});
process.on("unhandledRejection", (error) => {
  log(`unhandled rejection: ${error?.stack ?? error}`);
});

fs.rmSync(SOCKET_PATH, { force: true });
server.listen(SOCKET_PATH, () => {
  fs.writeFileSync(PID_PATH, String(process.pid));
  log(`daemon listening on ${SOCKET_PATH} (pid ${process.pid})`);
});
