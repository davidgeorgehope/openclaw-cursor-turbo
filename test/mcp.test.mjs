import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  extractMcpConfigPath,
  interpolateEnvPlaceholders,
  loadResolvedMcpServers,
  toAcpMcpServers,
  toSdkMcpServers,
} from "../lib/mcp.mjs";

test("extractMcpConfigPath handles both flag forms", () => {
  assert.equal(extractMcpConfigPath(["--mcp-config", "/tmp/a.json"]), "/tmp/a.json");
  assert.equal(extractMcpConfigPath(["--mcp-config=/tmp/b.json"]), "/tmp/b.json");
  assert.equal(extractMcpConfigPath(["-p"]), undefined);
});

test("interpolateEnvPlaceholders resolves known vars, keeps unknown", () => {
  const env = { TOKEN: "secret" };
  assert.equal(interpolateEnvPlaceholders("Bearer ${TOKEN}", env), "Bearer secret");
  assert.equal(interpolateEnvPlaceholders("${MISSING}", env), "${MISSING}");
});

test("loadResolvedMcpServers resolves headers and strips type", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-mcp-"));
  const configPath = path.join(dir, "mcp.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        openclaw: {
          type: "http",
          url: "http://127.0.0.1:9999/mcp",
          headers: { Authorization: "Bearer ${OPENCLAW_TOKEN}" },
        },
        localtool: { command: "mytool", args: ["--serve"], env: { A: "1" } },
      },
    }),
  );
  const servers = loadResolvedMcpServers(configPath, { OPENCLAW_TOKEN: "tok123" });
  assert.equal(servers.openclaw.headers.Authorization, "Bearer tok123");
  assert.equal(servers.openclaw.type, undefined);
  assert.equal(servers.localtool.command, "mytool");
});

test("loadResolvedMcpServers tolerates missing file", () => {
  assert.deepEqual(loadResolvedMcpServers("/nonexistent/mcp.json"), {});
  assert.deepEqual(loadResolvedMcpServers(undefined), {});
});

test("toAcpMcpServers emits http and stdio entries", () => {
  const list = toAcpMcpServers({
    web: { url: "http://x/mcp", headers: { A: "b" } },
    cli: { command: "tool", args: ["-x"], env: { E: "v" } },
  });
  assert.deepEqual(list, [
    { type: "http", name: "web", url: "http://x/mcp", headers: [{ name: "A", value: "b" }] },
    { name: "cli", command: "tool", args: ["-x"], env: [{ name: "E", value: "v" }] },
  ]);
});

test("toSdkMcpServers emits sdk-shaped config", () => {
  const servers = toSdkMcpServers({
    web: { url: "http://x/mcp", headers: { A: "b" } },
    cli: { command: "tool", args: [], env: {} },
  });
  assert.deepEqual(servers.web, { type: "http", url: "http://x/mcp", headers: { A: "b" } });
  assert.deepEqual(servers.cli, { command: "tool", args: [], env: {} });
});
