# pi-gitnexus-plus

[GitNexus](https://github.com/abhigyanpatwari/GitNexus) knowledge graph integration for [pi](https://github.com/mariozechner/pi) — enriches every search, file read, and symbol lookup with call chains, callers/callees, and execution flows, automatically.

Built on [tintinweb/pi-gitnexus](https://github.com/tintinweb/pi-gitnexus), this fork extends the original with multi-transport support, a broader tool surface, and Docker server management.

<img height="298" alt="pi-gitnexus-plus screenshot" src="https://github.com/ppsplus-bradh/pi-gitnexus-plus/raw/master/media/screenshot.png" />

https://github.com/user-attachments/assets/49e61667-f508-4d22-abad-05241e414664

> The graph view in the demo is from [gitnexus-web](https://github.com/abhigyanpatwari/GitNexus) and is not part of this extension.

## What's different from pi-gitnexus

| | [pi-gitnexus](https://github.com/tintinweb/pi-gitnexus) | **pi-gitnexus-plus** |
|---|---|---|
| **Transport** | Stdio only (local `gitnexus mcp` process) | Stdio + [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) |
| **MCP client** | Handrolled JSON-RPC 2.0 | Official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) |
| **Agent tools** | 7 | 14 |
| **MCP resources** | Not supported | All 10 resource types via `gitnexus_read_resource` |
| **Docker/remote** | Not supported | Full support — health checks, server-side analyze, job polling |
| **API analysis** | — | Route maps, shape checks, API impact reports |
| **Multi-repo** | — | Group management and contract registry sync |
| **Server management** | — | REST client for `/api/analyze`, `/api/repos`, `/api/health`, `/api/info` |

Everything from the original is preserved — auto-augment, session caching, skills, settings, all 7 original tools with identical names and schemas.

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

## Agent tools

14 tools are registered in pi and always available to the agent:

### Core tools

| Tool | Description |
|---|---|
| `gitnexus_list_repos` | List all indexed repositories |
| `gitnexus_query` | Search the knowledge graph for execution flows |
| `gitnexus_context` | 360° view of a symbol: callers, callees, processes |
| `gitnexus_impact` | Blast radius analysis for a symbol |
| `gitnexus_detect_changes` | Analyze staged/unstaged/all/compare git changes and affected execution flows |
| `gitnexus_rename` | Coordinated multi-file rename preview/apply through the knowledge graph |
| `gitnexus_cypher` | Execute raw Cypher queries against the graph |

### API & route analysis

| Tool | Description |
|---|---|
| `gitnexus_route_map` | Show API route mappings: consumers, handlers, middleware |
| `gitnexus_tool_map` | Show MCP/RPC tool definitions and handler locations |
| `gitnexus_shape_check` | Check API response shapes against consumer property accesses |
| `gitnexus_api_impact` | Pre-change impact report for an API route handler |

### Multi-repo & resources

| Tool | Description |
|---|---|
| `gitnexus_group_list` | List configured repository groups |
| `gitnexus_group_sync` | Rebuild the contract registry for a repository group |
| `gitnexus_read_resource` | Read a GitNexus MCP resource by URI (repo context, clusters, processes, schema, etc.) |

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

## CLI flags

| Flag | Description |
|---|---|
| `--gitnexus-cmd <command>` | Override the gitnexus command (e.g. `npx gitnexus@latest`) |
| `--gitnexus-server <url>` | Connect to a GitNexus HTTP server (e.g. `http://localhost:4747/api/mcp`). Overrides saved config. |

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

## How it works

### Auto-augment

Fires after every grep/find/bash/read/read_many tool result. Extracts up to 3 patterns (primary from input, secondary filenames from result content) and looks them up in the knowledge graph in parallel. Regex patterns are parsed to extract the longest identifier-like literal; bash commands are tokenized with quote and pipe boundary awareness. Results are wrapped in `---` delimiters and appended to the tool result. For `read_many`, each file in the batch gets its own labeled section.

### What triggers augmentation

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

### MCP transport

Tools communicate with GitNexus via the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`). Two transports are supported:

- **Stdio** (default) — spawns `gitnexus mcp` as a child process. Communication over stdin/stdout pipe. Lazily started on first tool call, stopped after 10 minutes of inactivity (configurable). No network socket, no port.
- **Streamable HTTP** — connects to a GitNexus HTTP server (e.g. running in Docker). Uses the [MCP Streamable HTTP protocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) with automatic session management. Configure via `--gitnexus-server` flag or `/gitnexus settings`.

In HTTP mode, auto-augment routes through the `query` tool instead of the CLI subprocess. All 14 tools and MCP resources work over both transports.

### Session lifecycle

On session start/switch, the extension resolves the full shell PATH through `$SHELL` (picking up nvm/fnm/volta without depending on a specific user shell), probes the binary (stdio) or server health (HTTP), and notifies accordingly. The MCP connection is restarted with the new working directory.

### Docker server management

In HTTP mode, the extension communicates with the GitNexus server's REST API for operations that don't fit the MCP tool/resource model:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Server health check (used during session start) |
| `GET /api/info` | Server version and context (shown by `/gitnexus status`) |
| `GET /api/repos` | List indexed repositories |
| `POST /api/analyze` | Trigger server-side analysis (accepts `path`, `url`, or `name`) |
| `GET /api/analyze/:jobId` | Poll analysis job progress |

`/gitnexus analyze` in HTTP mode constructs the container path from your workspace directory setting and the current directory name, or you can pass a git URL directly: `/gitnexus analyze https://github.com/user/repo.git`.

## Notes

- Tested with gitnexus 1.4.8+. Older versions may have incompatible MCP schemas.
- The extension never runs `gitnexus analyze` automatically — indexing is always user-initiated.
- The index is a static snapshot. Re-run `/gitnexus analyze` after significant code changes. The agent will suggest this when the index appears stale.
- In multi-repo setups the extension automatically passes the current repo root path to MCP tools, but every tool also accepts an explicit `repo` override.
- `gitnexus_rename` and `gitnexus_cypher` are exposed intentionally; use `gitnexus_rename` with `dry_run` first because it can propose multi-file edits.
- `gitnexus_read_resource` can read any MCP resource by URI — use `gitnexus://repos` to discover available repos, or `gitnexus://repo/{name}/schema` to get the graph schema for Cypher queries.
- Markdown files (`.md`, `.mdx`) participate in augmentation alongside code files when GitNexus has indexed them.
- The enrichment is appended to the tool result the agent receives — files on disk and raw tool outputs are never modified.

## Attribution

This project is a fork of [tintinweb/pi-gitnexus](https://github.com/tintinweb/pi-gitnexus) — the original GitNexus integration for pi. The core auto-augment hook, session lifecycle, skills framework, and the first 7 tools originate from that project.

## License

MIT — see [LICENSE](LICENSE) for details.

This extension is MIT licensed. [GitNexus](https://github.com/abhigyanpatwari/GitNexus) itself is published under the [PolyForm Noncommercial License](https://polyformproject.org/licenses/noncommercial/1.0.0/) — commercial use requires a separate agreement with its author. Install and use gitnexus in accordance with its license terms.
