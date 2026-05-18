# Changelog

## 0.7.0

- **HTTP transport support** — the extension now connects to GitNexus via either **stdio** (default, spawns local `gitnexus mcp` process) or **Streamable HTTP** (for GitNexus servers running in Docker or remotely). Configure via `/gitnexus settings → MCP transport → http` and set the Server URL, or use the new `--gitnexus-server` CLI flag for one-off connections (e.g. `pi --gitnexus-server http://localhost:4747/api/mcp`).
- **MCP SDK migration** — replaced the handrolled ~175-line stdio JSON-RPC 2.0 client with the official `@modelcontextprotocol/sdk` v1.29.0 `Client` class. Eliminates manual JSON-RPC framing, buffer management, handshake code, and pending-request tracking. The SDK handles all protocol mechanics, SSE parsing, and session management.
- **7 new tools** (14 total) — registered 6 additional MCP tools exposed by the server: `gitnexus_route_map` (API route mappings), `gitnexus_tool_map` (tool definitions), `gitnexus_shape_check` (response shape validation), `gitnexus_api_impact` (pre-change API impact report), `gitnexus_group_list` (repository groups), `gitnexus_group_sync` (contract registry rebuild). Plus `gitnexus_read_resource` for reading any MCP resource by URI (repo context, clusters, processes, graph schema, etc.).
- **Docker server management** — new `GitNexusServerApi` REST client for non-MCP server endpoints. `/gitnexus analyze` in HTTP mode triggers server-side analysis via `POST /api/analyze` with job polling and progress notifications. Supports both local paths (inside the container's workspace directory) and git URLs (`/gitnexus analyze https://github.com/user/repo.git`). `/gitnexus status` shows server version, transport info, and indexed repos via REST API.
- **4 new settings** — MCP transport (`stdio`/`http`), Server URL, Auth token (Bearer), and Workspace directory (Docker container path mapping, default `/workspace`). All persist to `~/.pi/pi-gitnexus.json`.
- **New `--gitnexus-server` CLI flag** — overrides saved config to force HTTP transport for a single session. Example: `pi --gitnexus-server http://localhost:4747/api/mcp`.
- **MCP resource support** — `gitnexus_read_resource` can read 10 resource types: repo overview, functional clusters, execution flows, graph schema, process traces, cross-repo contracts, and more.
- **Expanded system prompt** — in HTTP mode, the agent's system prompt lists all 14 tools. In stdio mode, the original 7.
- **Skills updated** — all 5 workflow skills now reference the new API-focused tools (`api_impact`, `shape_check`, `route_map`, `group_list`, `group_sync`).
- **Backwards compatible** — `mcpTransport` defaults to `stdio`. Existing config and tool names are unchanged. Users who never configure HTTP see identical behavior.
- **New dependency** — `@modelcontextprotocol/sdk ^1.29.0`. New peer dependency: `zod >=3.25` (already provided by pi host at runtime).

## 0.6.3

- **MCP idle shutdown** — `gitnexus mcp` now stops after 10 minutes of inactivity (configurable via `/gitnexus settings → MCP idle timeout`; `'off'` keeps it alive for the session, matching prior behavior). Releases the Python process and graph memory during long quiet stretches; the next MCP-routed call respawns at the cold-start cost (~1–3s). Auto-augment is unaffected — it uses a separate one-shot `gitnexus augment` subprocess.
- **MCP startup-race fix** — `stop()` mid-handshake previously orphaned the spawning child because `this.proc` wasn't set yet. Now tracks the in-flight process in `startingProc` and kills it on stop. New regression test covers this path.
- **Session shutdown cleanup** — added `pi.on('session_shutdown', () => mcpClient.stop())` so the MCP child doesn't outlive pi's own exit (was already best-effort via OS reaping; now explicit).
- **`/gitnexus analyze` lifecycle** — stops MCP before reindexing so it cannot serve queries against a half-rebuilt graph, and again after completion so the next tool call respawns against the fresh index. Also clears the auto-augment session caches (`augmentedCache`, `emptyCache`) on success, so previously-augmented files re-augment with the new graph.
- **Analyze auto-fallback to `--skip-git`** — if `gitnexus analyze` fails with "not a git repository", the extension retries once with `--skip-git`.
- **Custom GitNexus command in settings** — the `cmd` row now opens a text input on Enter (instead of cycling a fixed list), so users can enter any path or invocation. Examples remain in the description.
- **Settings apply live** — every change in `/gitnexus settings` (auto-augment, augment timeout, MCP idle timeout, cmd, etc.) takes effect immediately rather than only on menu close. Live re-arming for `mcpIdleTimeout` so toggling on/off or changing the value resets the active timer right away.

## 0.6.2

**Breaking — peer dependency scope change.** The `@mariozechner/*` packages were deprecated in favor of `@earendil-works/*`. Consumers must have `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` ≥ 0.74 installed.

- **Migrated to `@earendil-works/*` scope** — `@mariozechner/pi-ai` → `@earendil-works/pi-ai`, `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`, and the previously-transitive `pi-tui` is now an explicit peer at `@earendil-works/pi-tui`. Pinned to 0.74.0 (was 0.72.1). Closes #12.
- **Slimmer `package.json`** — dropped `devDependencies` duplicates of the `pi-*` peers. npm 7+ auto-installs peer deps when developing the package itself, so the duplication added lockfile churn for no benefit.
- **Routine dev-dep bumps**: `@types/node` ^25.6.0 → ^25.6.2, `typebox` 1.1.37 → 1.1.38 (lockfile-only; peer range `>=1.0` already covered it).

## 0.6.1

- **PATH resolution no longer drops nvm/fnm/volta dirs** — `resolveShellPath` previously *replaced* `process.env.PATH` with the login shell's PATH, which silently dropped any directories the agent already had (e.g. `~/.local/share/nvm/…` inherited from the launching shell). On macOS where users typically place nvm setup in `.zshrc` (interactive) rather than `.zprofile` (login), the login-shell probe returns a PATH without nvm — and the old code then clobbered nvm out of the agent's PATH, producing spurious "gitnexus is not on PATH" warnings even when gitnexus was correctly installed. Now both PATHs are merged with agent-first precedence and platform-aware deduplication via `node:path`'s `delimiter`.
- **Login-shell probe uses `$SHELL` and is bounded by a 3s timeout** — replaced the hardcoded `/bin/sh` (which never sources zsh/bash login files) with `$SHELL`, and short-circuits on Windows where the agent's PATH is already correct. A 3-second timeout prevents a slow or broken `.zprofile`/`.bash_profile` from stalling session initialization.
- **`tool_result` hook no longer crashes on error results** — added a guard for `event.content` being undefined or non-array, which can occur for tool error responses. Previously `event.content.map(...)` threw a `TypeError` and broke the augmentation pipeline for the rest of the session.
- **`session_start` errors are surfaced instead of swallowed** — the previous `void onSession(ctx)` silently dropped any thrown error during session initialization. Now a `.catch` reports the failure via `ctx.ui.notify` so the user sees what went wrong.

## 0.6.0

**Breaking — peer dependency change.** Now requires `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` ≥ 0.70, and `typebox` (unscoped, ≥ 1.x) instead of `@sinclair/typebox`. Users still on the 0.62 line of pi-ai/pi-coding-agent should stay on pi-gitnexus 0.5.x.

- **Migrated to `typebox` 1.x** — `@sinclair/typebox` (legacy 0.x line) was replaced by `typebox` (Sinclair's new 1.x package). pi-ai 0.70 re-exports `Type` from there. The only call site is `src/tools.ts`; API surface used (`Type.Object`, `Type.String`, `Type.Optional`, etc.) is unchanged.
- **Dropped `session_switch` listener** — pi-coding-agent 0.70 unified session activation under a single `session_start` event with a `reason` field (`"startup" | "reload" | "new" | "resume" | "fork"`). The previous `session_switch` event was removed; one `session_start` registration now covers both initial start and switches.
- **Routine dev-dep bumps**: `@biomejs/biome` ^2.4.8 → ^2.4.13, `@types/node` ^25.3.0 → ^25.6.0, `typescript` ^6.0.2 → ^6.0.3, `vitest` ^4.1.1 → ^4.1.5.
- Side effect: `npm audit` now reports 0 vulnerabilities (was 11). The pi-ai 0.70 transitive tree no longer pulls in the previously-flagged packages.

## 0.5.2

- **Windows compatibility — `gitnexus` binary now spawns correctly** — switched all seven `gitnexus`-invoking `child_process.spawn` call sites (binary probe, `/gitnexus status` and `/gitnexus analyze` from both the direct command and the interactive menu, `runAugment`, MCP client) to [`cross-spawn`](https://www.npmjs.com/package/cross-spawn). On Windows, npm-installed global binaries are `.cmd` shims that the native `spawn` cannot execute directly; previously every call silently failed with the "gitnexus not on PATH" warning even when the binary was correctly installed, and `gitnexus_*` tools failed with ENOENT on every MCP call. cross-spawn resolves the binary, dispatches `.cmd`/`.bat` shims through `cmd.exe` with proper per-argument escaping, and is a no-op on macOS/Linux.
- **Defense-in-depth over `shell: true`** — `shell: process.platform === 'win32'` (the obvious one-line fix) would have routed agent-derived `augment <pattern>` args through `cmd.exe` parsing on Windows. Modern Node (≥ 18.20.2 / 20.12.2 / 21.7.3) blocks the worst metacharacters in args under `shell: true` after CVE-2024-27980, so this is hardening, not a CVE patch — but cross-spawn avoids the shell entirely, which is the cleaner property.
- **New runtime dependency** — `cross-spawn@7.0.6` (pinned exactly). Already present transitively via `@google/genai` → `gaxios` → `glob` → `foreground-child`, so no new code in the install tree.

## 0.5.1

- **Smarter pattern extraction** — grep/rg regex patterns are now parsed to extract the longest identifier-like literal instead of blindly stripping all metacharacters. `(Foo|Bar)` correctly extracts `Foo` instead of producing `FooBar`.
- **Quote-aware bash tokenizer** — bash commands are now tokenized with proper quote handling and pipe/`&&`/`;` boundary detection. `grep "validateUser" src/` and `cat file.txt | grep foo` now extract the correct pattern.
- **Cache-after-augment** — patterns are now cached based on results, not before the subprocess runs. Failed or empty augments no longer permanently block retries. A separate `emptyCache` prevents unbounded retries for patterns with no graph data, cleared on session reset.
- **Case-insensitive dedup** — `validateUser` and `ValidateUser` are now recognized as the same pattern, avoiding redundant subprocess spawns.
- **Early-exit on empty content** — skips augmentation when the tool returned no meaningful content (< 10 chars), avoiding wasted subprocess spawns on empty grep results.
- **Cleaner output formatting** — `---` delimiters wrap GitNexus blocks for clearer separation from tool output. Redundant `[GitNexus]` label is omitted when the augment output already includes one.

## 0.5.0

- **Built for gitnexus >= 1.4.8** — aligned all tool schemas and MCP contracts with gitnexus 1.4.8. Adds `gitnexus_rename` and `gitnexus_cypher` tools, updates `detect_changes` to use `scope`/`base_ref`, normalizes parameter names (`maxDepth`, `includeTests`, `file_path`), and adds multi-repo routing with automatic repo root detection.
- **Interactive menu** — `/gitnexus` opens a menu with status display, Analyze, Settings, and Help. Status is shown inline in the menu title. `/gitnexus status` and `/gitnexus analyze` still work as direct shortcuts.
- **Settings panel** — `/gitnexus settings` opens a native TUI settings panel (SettingsList) for auto-augment, timeout, max augments per result, secondary pattern limit, and gitnexus command. All settings persist to `~/.pi/pi-gitnexus.json` and apply immediately.
- **Subcommand autocomplete** — typing `/gitnexus ` now autocompletes subcommands (status, analyze, on, off, settings, query, context, impact, help).
- **Skills** — 5 workflow skills bundled with the extension, available via `/skill:name`:
  - `gitnexus-exploring` — understand architecture, trace execution flows
  - `gitnexus-debugging` — trace bugs, find error sources
  - `gitnexus-pr-review` — review PRs with blast radius analysis
  - `gitnexus-refactoring` — safe rename, extract, split operations
  - `gitnexus-impact-analysis` — pre-change safety analysis
- **Configurable limits** — max augments per result and secondary pattern limit are now settings instead of hardcoded values.

## 0.4.1

- **Settings menu cleanup** — removed duplicate auto-augment toggle. Previously, `/gitnexus settings` showed an auto-augment toggle in the top-level menu *and* inside the Settings panel. The top-level toggle is removed; auto-augment is now configured only in the Settings panel alongside timeout and limit options.
- **`/gitnexus` opens main menu** — running `/gitnexus` with no arguments now opens an interactive menu with **Status** and **Settings** choices instead of printing status directly. `/gitnexus status` still works as a direct shortcut.

## 0.4.0

- **`read_many` augmentation** — batch file reads now trigger per-file labeled graph context. When the agent reads multiple files at once via `read_many`, each code file in the batch (up to 5) is looked up in the knowledge graph and returned as a separate `### filename` section, so the agent always knows which context belongs to which file.

## 0.3.1

- **Package metadata** — added `repository`, `homepage`, and `bugs` fields.

## 0.3.0

- **Configurable command** — the gitnexus binary invocation is now configurable. Default is `gitnexus` on PATH. Use `/gitnexus config` to set a custom command (e.g. `npx gitnexus@latest`) via an input dialog; the value is persisted to `~/.pi/pi-gitnexus.json`. The `--gitnexus-cmd` CLI flag overrides the saved config for one-off runs. Nothing is ever installed automatically.
- **TypeScript compatibility** — `tool_result` handler now uses inferred event types from the API overload instead of a manual annotation, fixing a compile error with `@mariozechner/pi-coding-agent` 0.54.x.
- **Dependency updates** — `@mariozechner/pi-coding-agent` to 0.54.2, `@types/node` to 25.x.

## 0.2.0

### Features

- **`read` tool augmentation** — file reads now trigger augmentation. When the agent reads a code file (`.sol`, `.ts`, `.go`, etc.), the filename is used as the lookup pattern to get callers/callees for that file's symbols.
- **Bash `cat`/`head`/`tail` support** — extractPattern now handles `cat file.sol`, `head file.sol`, etc. alongside grep/rg/find.
- **Multi-pattern augmentation** — each tool result now augments up to 3 patterns in parallel: the primary pattern from the tool input, plus filenames extracted from grep output lines (`path/file.sol:line:`). Results are merged into a single `[GitNexus]` block.
- **Session dedup cache** — each symbol/filename is augmented at most once per session, preventing redundant lookups when the agent repeatedly searches for the same thing.

### Fixes

- **Auto-augment now works** — `gitnexus augment` writes its output to stderr, not stdout. `runAugment` was capturing stdout only, so every augmentation returned empty. Fixed by reading from stderr (`stdio: ['ignore', 'ignore', 'pipe']`).
- **Regex patterns cleaned before augment** — grep/rg patterns like `\bwithdraw\s*\(` are stripped of regex metacharacters before passing to `gitnexus augment`, which expects a plain symbol name.
- **`gitnexus_query` limit raised** — max `limit` parameter increased from 20 to 100. The agent was hitting validation errors when requesting more results.
- **Status counters** — `/gitnexus status` now shows searches intercepted and enrichment count for observability.

## 0.1.0

Initial release.

### Features

- **Auto-augment hook** — intercepts grep, find, and bash tool results and appends knowledge graph context (callers, callees, execution flows) via `gitnexus augment`. Mirrors the Claude Code plugin's PreToolUse integration.
- **Five registered tools** — `gitnexus_list_repos`, `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`, `gitnexus_detect_changes` available to the agent with zero setup.
- **stdio MCP client** — tools communicate with `gitnexus mcp` over a stdin/stdout pipe (no network socket, no port). Process is spawned lazily and kept alive for the session.
- **System prompt hint** — when an index is present, appends a one-liner to the agent's system prompt so it understands graph context and knows to use the tools.
- **Session lifecycle** — on session start/switch: resolves full shell PATH (nvm/fnm/volta), probes binary, checks index, notifies status. MCP process restarted on session switch.
- **`/gitnexus` command** with subcommands: `status`, `analyze`, `on`, `off`, `query`, `context`, `impact`, `<pattern>`, `help`.
- **`/gitnexus analyze`** — runs `gitnexus analyze` from within pi with start/completion notifications. Auto-augment is paused for the duration to avoid stale index results.
- **Toggle** — `/gitnexus on` / `/gitnexus off` enables/disables auto-augment without affecting tools. Resets to enabled on session switch.
- **Shell PATH resolution** — spawns `$SHELL -lc 'echo $PATH'` on session start so nvm/fnm/volta-managed binaries are found when pi is launched as a GUI app.
- **Path traversal guard** — `gitnexus_context` file parameter validated to stay within cwd before passing to the MCP server.
- **Graceful failure** — every code path (augment timeout, MCP spawn error, binary missing) returns empty rather than throwing. Extension never breaks the agent's normal flow.
