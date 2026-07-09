import fs from "node:fs";

// OpenClaw (bundleMcpMode: claude-config-file) injects
// `--strict-mcp-config --mcp-config <path>` and sets env vars that the
// generated config references as ${VAR} placeholders in headers. The shim
// resolves everything against its own env and hands the daemon a plain
// server list, since the daemon does not inherit per-turn env.

export function extractMcpConfigPath(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") return args[i + 1];
    if (arg.startsWith("--mcp-config=")) return arg.slice(13);
  }
}

export function interpolateEnvPlaceholders(value, env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name) => env[name] ?? all);
}

/** Reads a Claude-style mcp config and returns env-resolved server entries. */
export function loadResolvedMcpServers(configPath, env = process.env) {
  if (!configPath) return {};
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
  const servers = raw?.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {};
  const resolved = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== "object") continue;
    const entry = { ...server };
    delete entry.type; // Cursor infers transport from `url`.
    if (entry.headers && typeof entry.headers === "object") {
      entry.headers = Object.fromEntries(
        Object.entries(entry.headers).map(([k, v]) => [k, interpolateEnvPlaceholders(v, env)]),
      );
    }
    if (typeof entry.url === "string") entry.url = interpolateEnvPlaceholders(entry.url, env);
    resolved[name] = entry;
  }
  return resolved;
}

/** Converts resolved servers into ACP session/new mcpServers entries. */
export function toAcpMcpServers(resolvedServers) {
  const list = [];
  for (const [name, server] of Object.entries(resolvedServers ?? {})) {
    if (typeof server.url === "string") {
      list.push({
        type: "http",
        name,
        url: server.url,
        headers: Object.entries(server.headers ?? {}).map(([hn, hv]) => ({ name: hn, value: hv })),
      });
    } else if (typeof server.command === "string") {
      list.push({
        name,
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        env: Object.entries(server.env ?? {}).map(([en, ev]) => ({ name: en, value: ev })),
      });
    }
  }
  return list;
}

/** Converts resolved servers into @cursor/sdk inline mcpServers config. */
export function toSdkMcpServers(resolvedServers) {
  const out = {};
  for (const [name, server] of Object.entries(resolvedServers ?? {})) {
    if (typeof server.url === "string") {
      out[name] = { type: "http", url: server.url, headers: { ...(server.headers ?? {}) } };
    } else if (typeof server.command === "string") {
      out[name] = {
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        env: { ...(server.env ?? {}) },
      };
    }
  }
  return out;
}
