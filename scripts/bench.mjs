// Benchmarks total turn latency for a trivial prompt across transports:
//   spawn : cursor-agent -p (fresh process per turn, like openclaw-cursor-agent)
//   acp   : turbo shim -> warm daemon -> persistent `agent acp`
//   sdk   : turbo shim -> warm daemon -> in-process @cursor/sdk (needs CURSOR_API_KEY)
// Usage: node scripts/bench.mjs [model] [iterations]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = process.argv[2] ?? "gemini-3.5-flash";
const ITERATIONS = Number(process.argv[3] ?? 3);
const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "shim.mjs");
const PROMPT = "Reply with exactly: OK";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let firstOutputAt = null;
    let sessionId = null;
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      if (firstOutputAt === null) firstOutputAt = Date.now();
      out += chunk;
    });
    child.on("exit", (code) => {
      const m = out.match(/"session_id":"([^"]+)"/);
      if (m) sessionId = m[1];
      if (code !== 0) return reject(new Error(`exit ${code}: ${out.slice(0, 300)}`));
      resolve({
        total: Date.now() - started,
        firstOutput: firstOutputAt - started,
        sessionId,
      });
    });
    child.stdin.end(PROMPT);
  });
}

const transports = {
  spawn: {
    fresh: (cwd) => run("cursor-agent", ["-p", "--output-format", "stream-json", "--trust", "--model", MODEL], cwd),
    resume: (cwd, sid) =>
      run("cursor-agent", ["-p", "--output-format", "stream-json", "--trust", "--model", MODEL, "--resume", sid], cwd),
  },
  acp: {
    fresh: (cwd) => run(process.execPath, [SHIM, "--transport", "acp", "--model", MODEL], cwd),
    resume: (cwd, sid) =>
      run(process.execPath, [SHIM, "--transport", "acp", "--model", MODEL, "--resume", sid], cwd),
  },
  sdk: {
    fresh: (cwd) => run(process.execPath, [SHIM, "--transport", "sdk", "--model", MODEL], cwd),
    resume: (cwd, sid) =>
      run(process.execPath, [SHIM, "--transport", "sdk", "--model", MODEL, "--resume", sid], cwd),
  },
};

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return `median ${mid}ms  (${sorted.join(", ")})`;
}

for (const [name, t] of Object.entries(transports)) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${name}-`));
  const freshTotals = [];
  const resumeTotals = [];
  try {
    let sid = null;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const fresh = await t.fresh(cwd);
      freshTotals.push(fresh.total);
      sid = fresh.sessionId ?? sid;
      if (sid) {
        const resumed = await t.resume(cwd, sid);
        resumeTotals.push(resumed.total);
      }
    }
    console.log(`${name.padEnd(6)} fresh : ${stats(freshTotals)}`);
    console.log(`${name.padEnd(6)} resume: ${stats(resumeTotals)}`);
  } catch (error) {
    console.log(`${name.padEnd(6)} SKIP: ${error.message.split("\n")[0].slice(0, 160)}`);
  }
}
process.exit(0);
