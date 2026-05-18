# pi-gitnexus-plus

[GitNexus](https://github.com/abhigyanpatwari/GitNexus) knowledge graph integration for [pi](https://github.com/mariozechner/pi). Enriches every search, file read, and symbol lookup with call chains, callers/callees, and execution flows — automatically. Supports both local CLI (stdio) and HTTP server (Docker) transports.

> Forked from [tintinweb/pi-gitnexus](https://github.com/tintinweb/pi-gitnexus) with expanded tool coverage, MCP SDK integration, HTTP transport, and Docker server management.

<img height="298" alt="pi-gitnexus-plus screenshot" src="https://github.com/ppsplus-bradh/pi-gitnexus-plus/raw/master/media/screenshot.png" />


https://github.com/user-attachments/assets/49e61667-f508-4d22-abad-05241e414664

> The graph view in the demo is from [gitnexus-web](https://github.com/abhigyanpatwari/GitNexus) and is not part of this extension.

## What it does

When the agent reads a file or runs a search (grep, find, bash, read_many), the extension appends graph context from the knowledge graph inline with the results. The agent sees both together and can follow call chains without additional queries.

```
Agent reads auth/session.ts
  → file content returned normally
  → [GitNexus] appended: callers of the module, what it imports, related tests

Agent runs grep("validateUser")
  → grep results returned normally
  → [GitNexus] appended: Called by: login, signup / Calls: checkPermissions, getUser
  → filenames in the grep output are also looked up in parallel

Agent calls read_many([api.ts, db.ts, router.ts])
  → file contents returned normally
  → [GitNexus] appended with per-file labeled sections:
      ### api.ts
      <call graph context for api>
      ### db.ts
      <call graph context for db>
```

Fourteen tools are registered directly in pi — the agent can use them explicitly for deeper analysis without any setup.

## Requirements

You need **one** of the following:

- **Local CLI**: [gitnexus](https://github.com/abhigyanpatwari/GitNexus) >= 1.4.8 on PATH (e.g. `npm i -g gitnexus`), OR
- **HTTP server**: A GitNexus server accessible over HTTP (e.g. running in Docker at `http://localhost:4747/api/mcp`)

The extension never installs anything automatically. If your local CLI setup differs from the default, use `/gitnexus settings` to set a custom command (e.g. `npx gitnexus@latest`).

## Getting started

### Option A: Local CLI (stdio transport)

1. Install the extension: `pi install npm:pi-gitnexus-plus`
2. Install gitnexus: `npm i -g gitnexus`
3. Open your project in pi
4. Run `/gitnexus analyze` to build the knowledge graph
5. Done — file reads and searches are now enriched automatically

### Option B: HTTP server (e.g. Docker)

1. Install the extension: `pi install npm:pi-gitnexus-plus`
2. Start the GitNexus server (e.g. `docker run -p 4747:4747 -v /path/to/repos:/workspace gitnexus/server`)
3. Start pi with the server flag: `pi --gitnexus-server http://localhost:4747/api/mcp`
4. Run `/gitnexus analyze` to trigger server-side indexing
5. Done — all tools and auto-augment work over HTTP

Or configure permanently via `/gitnexus settings` → MCP transport → `http`, then set the Server URL.

## What triggers augmentation

| Tool | Pattern used |
|---|---|
| `grep` | Longest identifier literal extracted from the search pattern |
| `bash` with grep/rg | First non-flag argument after `grep`/`rg` (quote-aware, pipe-safe) |
| `bash` with cat/head/tail | Filename of the target file (quote-aware) |
| `bash` with find | Value of `-name`/`-iname` |
| `find` | Glob pattern basename |
| `read` | Filename of the file being read (indexed code/docs files only) |
| `read_many` | Each indexed code/docs file in the batch (up to 5), labeled per-file in output |
| Any grep/bash result | Filenames extracted from result lines (`path/file.ts:line:`) |

Each tool result augments up to 3 patterns in parallel (up to 5 for `read_many`). Patterns already augmented this session are skipped.

## Commands

| Command | Description |
|---|---|
| `/gitnexus` | Open the main menu (status, Analyze, Settings, Help) |
| `/gitnexus status` | Show index status and session enrichment count |
| `/gitnexus analyze` | Build or rebuild the knowledge graph (local CLI or server-side) |
| `/gitnexus analyze <url>` | Clone and index a git repo by URL (HTTP mode only) |
| `/gitnexus on` / `/gitnexus off` | Enable/disable auto-augment (tools unaffected) |
| `/gitnexus settings` | Open the settings panel |
| `/gitnexus <pattern>` | Manual graph lookup for a symbol or pattern |
| `/gitnexus query <text>` | Search execution flows |
| `/gitnexus context <name>` | 360° view of a symbol: callers, callees, processes |
| `/gitnexus impact <name>` | Upstream blast radius of a change |
| `/gitnexus help` | Show command reference |

## Agent tools

The following tools are registered in pi and always available to the agent:

| Tool | Description |
|---|---|
| `gitnexus_list_repos` | List all indexed repositories |
| `gitnexus_query` | Search the knowledge graph for execution flows |
| `gitnexus_context` | 360° view of a symbol: callers, callees, processes |
| `gitnexus_impact` | Blast radius analysis for a symbol |
| `gitnexus_detect_changes` | Analyze staged/unstaged/all/compare git changes and affected execution flows |
| `gitnexus_rename` | Coordinated multi-file rename preview/apply through the knowledge graph |
| `gitnexus_cypher` | Execute raw Cypher queries against the graph |
| `gitnexus_route_map` | Show API route mappings: consumers, handlers, middleware |
| `gitnexus_tool_map` | Show MCP/RPC tool definitions and handler locations |
| `gitnexus_shape_check` | Check API response shapes against consumer property accesses |
| `gitnexus_api_impact` | Pre-change impact report for an API route handler |
| `gitnexus_group_list` | List configured repository groups |
| `gitnexus_group_sync` | Rebuild the contract registry for a repository group |
| `gitnexus_read_resource` | Read a GitNexus MCP resource by URI (repo context, clusters, processes, schema, etc.) |

## Skills

The extension bundles 5 workflow skills that guide the agent through common tasks:

| Skill | When to use |
|---|---|
| `/skill:gitnexus-exploring` | Understand architecture, trace execution flows, explore unfamiliar code |
| `/skill:gitnexus-debugging` | Debug a bug, trace an error, find why something fails |
| `/skill:gitnexus-pr-review` | Review a PR, assess merge risk, check blast radius |
| `/skill:gitnexus-refactoring` | Rename, extract, split, or restructure code safely |
| `/skill:gitnexus-impact-analysis` | Know what breaks before changing something |

Skills are loaded on-demand — only the description is in context until the agent or user invokes one.

## How it works

**Auto-augment hook** — fires after every grep/find/bash/read/read_many tool result. Extracts up to 3 patterns (primary from input, secondary filenames from result content) and calls `gitnexus augment` for each in parallel. Regex patterns are parsed to extract the longest identifier-like literal; bash commands are tokenized with quote and pipe boundary awareness. Results are wrapped in `---` delimiters and appended to the tool result. For `read_many`, each file in the batch gets its own labeled section so the agent knows exactly which context belongs to which file.

**Session dedup cache** — each symbol or filename is augmented at most once per session (case-insensitive). Patterns with results are cached in `augmentedCache`; patterns that returned empty are tracked in a separate `emptyCache` to prevent unbounded retries while still allowing retries after an index rebuild (both caches clear on session reset and after a successful `/gitnexus analyze`).

**MCP transport** — tools communicate with GitNexus via the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`). Two transports are supported:

- **Stdio** (default) — spawns `gitnexus mcp` as a child process. Communication over stdin/stdout pipe. Lazily started on first tool call, stopped after 10 minutes of inactivity (configurable). No network socket, no port.
- **Streamable HTTP** — connects to a GitNexus HTTP server (e.g. running in Docker). Uses the MCP Streamable HTTP protocol with session management. Configure via `--gitnexus-server` flag or `/gitnexus settings`.

In HTTP mode, auto-augment routes through the `query` tool instead of the CLI subprocess. All 14 tools and MCP resources work over both transports.

**Session lifecycle** — on session start/switch, the extension resolves the full shell PATH through `/bin/sh` (picking up nvm/fnm/volta without depending on a user shell like nushell), probes the binary (stdio) or server health (HTTP), and notifies accordingly. The MCP connection is restarted with the new working directory.

**Auto-augment toggle** — `/gitnexus off` disables the hook without affecting tools. Useful when the graph output is noisy for a particular task. Resets to enabled on session switch.

**Analyze guard** — auto-augment is paused during `/gitnexus analyze` to avoid injecting stale or partially-built index results.

## Settings

Open `/gitnexus settings` or `/gitnexus` → Settings to configure:

| Setting | Description | Default |
|---|---|---|
| Auto-augment | Enrich search results with graph context | on |
| Augment timeout | Max wait time for graph augmentation (seconds) | 8 |
| Max augments per result | Patterns to augment in parallel per search result | 3 |
| Max secondary patterns | File-based patterns extracted from grep/bash output | 2 |
| MCP idle timeout | Stop the MCP process after inactivity (seconds; `off` = never) | 600 |
| GitNexus command | Shell command to invoke gitnexus (stdio mode) | `gitnexus` |
| MCP transport | `stdio` (local CLI) or `http` (remote server) | `stdio` |
| Server URL | MCP endpoint URL (HTTP mode) | — |
| Auth token | Bearer token for server authentication (HTTP mode) | — |
| Workspace directory | Path inside Docker container where repos are mounted | `/workspace` |

## License note

This extension (pi-gitnexus-plus) is MIT licensed. Originally forked from [tintinweb/pi-gitnexus](https://github.com/tintinweb/pi-gitnexus). [GitNexus](https://github.com/abhigyanpatwari/GitNexus) itself is published under the [PolyForm Noncommercial License](https://polyformproject.org/licenses/noncommercial/1.0.0/) — commercial use requires a separate agreement with its author. Install and use gitnexus in accordance with its license terms.

## CLI flags

| Flag | Description |
|---|---|
| `--gitnexus-cmd <command>` | Override the gitnexus command (e.g. `npx gitnexus@latest`) |
| `--gitnexus-server <url>` | Connect to a GitNexus HTTP server (e.g. `http://localhost:4747/api/mcp`). Overrides saved config. |

## Notes

- Tested with gitnexus 1.4.8+. Older versions may have incompatible MCP schemas.
- The extension never runs `gitnexus analyze` automatically — indexing is always user-initiated via `/gitnexus analyze`.
- The index is a static snapshot. Re-run `/gitnexus analyze` after significant code changes. The agent will suggest this when the index appears stale.
- In multi-repo GitNexus setups the extension automatically passes the current repo root path to MCP tools, but every tool also accepts an explicit `repo` override.
- In HTTP mode, `/gitnexus analyze` triggers server-side analysis. The repo must exist inside the container's workspace directory (configured via settings), or you can pass a git URL to clone it: `/gitnexus analyze https://github.com/user/repo.git`.
- `gitnexus_detect_changes` follows the current MCP API: use `scope` (`unstaged`, `staged`, `all`, or `compare`) and optional `base_ref` instead of pasting raw diffs.
- Markdown files (`.md`, `.mdx`) participate in augmentation alongside code files when GitNexus has indexed them.
- `gitnexus_rename` and `gitnexus_cypher` are exposed intentionally; use `gitnexus_rename` with `dry_run` first because it can propose multi-file edits.
- `gitnexus_read_resource` can read any MCP resource by URI — use `gitnexus://repos` to discover available repos, or `gitnexus://repo/{name}/schema` to get the graph schema for Cypher queries.
- The enrichment is appended to the tool result the agent receives — files on disk and raw tool outputs are never modified.
