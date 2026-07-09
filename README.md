# openclaw-cursor-turbo

Experimental low-latency Cursor backends for OpenClaw. Where
[openclaw-cursor-agent](https://github.com/davidgeorgehope/openclaw-cursor-agent)
spawns a fresh `cursor-agent` process per turn, this plugin keeps a warm
daemon alive and exposes two transports as separate CLI backends:

| Backend ref | Transport | How it runs |
| --- | --- | --- |
| `cursor-acp/<model>` | ACP | Persistent `agent acp` child (JSON-RPC over stdio) inside the daemon |
| `cursor-sdk/<model>` | SDK | In-process `@cursor/sdk` local agents inside the daemon (needs `CURSOR_API_KEY`) |

## Measured latency (trivial prompt, gemini-3.5-flash, medians of 3)

| Transport | Fresh turn | Resumed turn |
| --- | --- | --- |
| spawn (`cursor-agent -p`) | 4.6s | 4.2s |
| ACP (warm daemon) | 6.5s | **2.2s** |

Fresh ACP turns pay for `session/new` on top of daemon startup, but resumed
turns — which is what a chat assistant does all day — are roughly twice as
fast as re-spawning the CLI.

## Architecture

```
OpenClaw gateway
  └─ spawns bin/shim.mjs per turn (CLI backend contract, stdin prompt,
     claude-stream-json stdout)
       └─ unix socket ~/.openclaw-cursor-turbo/daemon.sock
            └─ bin/daemon.mjs (warm, auto-started, idle-exits after 2h)
                 ├─ AcpTransport: one persistent `agent acp` child,
                 │  sessions resumed via session/load
                 └─ SdkTransport: cached @cursor/sdk local agents,
                    rehydrated via Agent.resume()
```

- The shim resolves OpenClaw's per-turn MCP bridge config (Claude-style
  `--mcp-config` + `${VAR}` header placeholders) against its own environment
  and hands the daemon plain server definitions, so OpenClaw tools work on
  both transports.
- OpenClaw MCP bridge endpoints are per-run; the ACP transport reloads the
  session (`session/load`) whenever the resolved server set changes so tool
  connections never go stale.
- The system prompt is delivered as `.cursor/rules/openclaw.mdc`
  (`alwaysApply`), same trick and same file as openclaw-cursor-agent.
- Permission requests from the ACP harness are auto-granted with the broadest
  allow option (equivalent to `--force`).

## Install

```bash
openclaw plugins install ~/Projects/openclaw-cursor-turbo
openclaw config set plugins.entries.cursor-turbo.enabled true
# allowlist models, e.g. cursor-acp/grok-4.5-fast-xhigh, then:
openclaw gateway restart
```

For the SDK transport, create a user API key at
[cursor.com/dashboard → API Keys](https://cursor.com/dashboard) and either:

```bash
echo '{"apiKey": "cursor_..."}' > ~/.openclaw-cursor-turbo/config.json
```

or export `CURSOR_API_KEY` in the daemon's environment.

## Model ids

Cursor-CLI-style ids (`grok-4.5-fast-xhigh`, `claude-opus-4-8-thinking-high`,
`composer-2.5`, `auto`) plus the same aliases as openclaw-cursor-agent
(`grok`, `gpt`, `opus`, `fable`, `sonnet`, `composer`).

Limitation: ACP's `session/set_model` only accepts the exact model ids it
advertises (one variant per base model), so effort/fast suffixes collapse to
the advertised default variant on the ACP transport. Example: today
`grok-4.5-fast-xhigh` runs as `grok-4.5[effort=high,fast=true]`. The SDK
transport passes effort/fast as model params instead.

## Daemon management

```bash
tail -f ~/.openclaw-cursor-turbo/daemon.log
kill "$(cat ~/.openclaw-cursor-turbo/daemon.pid)"   # shim restarts it on next turn
```

## Development

```bash
npm test              # unit tests (node:test)
node scripts/bench.mjs [model] [iterations]
node scripts/probe-acp.mjs   # raw ACP protocol dump
```

## Status

Experimental. Known gaps vs openclaw-cursor-agent:

- Tool-call activity is emitted as nonstandard `tool_call` events (ignored by
  OpenClaw's renderer); thinking deltas and final text come through fine.
- No `/cursor`-style chat command, model catalog provider, or media
  understanding provider.
- The ACP transport ignores per-model effort variants (see above).
- SDK transport is untested end to end until an API key is configured.
