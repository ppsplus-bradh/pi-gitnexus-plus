---
date: 2026-05-17T17:41:24-0500
author: Brad Huffman
commit: 79c7722
branch: feature/sdk-mcp-transport
repository: pi-gitnexus
topic: "Replace handrolled MCP client with @modelcontextprotocol/sdk + HTTP transport support"
tags: [plan, mcp-client, sdk, http-transport, docker, server-api]
status: ready
parent: "thoughts/shared/research/sdk-based-mcp-proposal.md"
last_updated: 2026-05-17T17:41:24-0500
last_updated_by: Brad Huffman
---

# SDK MCP Transport Implementation Plan

## Overview

Replace the handrolled 175-line stdio JSON-RPC 2.0 client (`GitNexusMcpClient`) with the official `@modelcontextprotocol/sdk` v1.29.0 `Client` class. This gains multi-transport support (stdio + Streamable HTTP), registers all 13 server tools + MCP resources, and adds Docker server management via REST API. Design decisions are documented in the [proposal](../research/sdk-based-mcp-proposal.md).

## Desired End State

- The extension connects to GitNexus via **stdio** (default, backwards-compatible) or **Streamable HTTP** (configurable)
- All **13 MCP tools** and **10 MCP resources** exposed by the server are registered in pi
- Users can configure transport, server URL, auth token, and workspace directory via settings or CLI flags
- `/gitnexus analyze` triggers server-side analysis via `POST /api/analyze` when in HTTP mode
- `/gitnexus status` shows server info and repo list when in HTTP mode
- Auto-augment hook works in both modes (HTTP mode uses `query` tool instead of CLI subprocess)
- All existing tests pass; new tests cover HTTP-mode behavior
- `npm run typecheck` and `npm run lint` pass

## What We're NOT Doing

- OAuth 2.1 flows (simple Bearer token auth only)
- SSE fallback transport (Streamable HTTP only for now)
- Server-initiated notifications (e.g., `tools/list_changed`)
- Conditional tool registration based on server capabilities
- Prompt support (server has capabilities but no prompts today)

---

## Phase 1: SDK Foundation + MCP Client Rewrite

### Overview

Replace the handrolled `GitNexusMcpClient` with an SDK-based wrapper. Install the SDK dependency. Rewrite tests. After this phase, the extension works identically to before (stdio only) but the transport layer is the SDK.

### Changes Required:

#### 1. Package Dependencies
**File**: `package.json`
**Changes**: Add `@modelcontextprotocol/sdk` as a dependency. Add `zod` as a peer dependency. Keep `cross-spawn` (still needed for `runAugment()` and `runGitNexusAnalyze()` CLI subprocess spawning).

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.29.0",
  "cross-spawn": "7.0.6"
},
"peerDependencies": {
  "@earendil-works/pi-ai": ">=0.74",
  "@earendil-works/pi-coding-agent": ">=0.74",
  "@earendil-works/pi-tui": ">=0.74",
  "typebox": ">=1.0",
  "zod": ">=3.25"
}
```

#### 2. MCP Client Rewrite
**File**: `src/mcp-client.ts`
**Changes**: Complete rewrite. Delete the handrolled `GitNexusMcpClient` class (buffer management, pending map, JSON-RPC framing, manual handshake, spawn logic). Replace with a thin wrapper around SDK `Client` that:

- Exports `TransportConfig` type (`{ type: 'stdio', cmd, env }` | `{ type: 'http', url, authToken? }`)
- Creates `StdioClientTransport` or `StreamableHTTPClientTransport` based on config
- Exposes `callTool(name, args, cwd)` — same signature as before, returns `'[GitNexus]\n' + text`
- Exposes `readResource(uri, cwd)` — new, for MCP resource reads
- Exposes `setConfig(config)` to switch transport config
- Exposes `transportType` getter
- Exposes `getServerTools()`, `getServerResources()`, `getServerResourceTemplates()` — cached from connection
- Lazy connection via `ensureConnected(cwd)` — same pattern as before
- Idle timer with `setMcpIdleTimeout()` and `refreshIdleTimer()` — same public API
- `stop()` — async now (HTTP needs `terminateSession()` + `close()`)
- Retains `MAX_OUTPUT_CHARS` import from `./gitnexus` for output truncation
- Singleton `export const mcpClient`

The key external API stays the same: `callTool(name, args, cwd): Promise<string>` and `stop()`. Callers don't need to change.

#### 3. MCP Client Tests
**File**: `tests/mcp-client.test.ts`
**Changes**: Rewrite all 3 tests to mock the SDK instead of `cross-spawn`. The existing tests verify:
1. Error when tool response has `isError: true` → still needed, mock `Client.callTool()` return
2. Idle timeout kills process → still needed, verify `transport.close()` called after timeout
3. `stop()` mid-handshake rejects pending → still needed, verify `transport.close()` during `connect()`

New mocking strategy: mock `@modelcontextprotocol/sdk/client/index.js` and `@modelcontextprotocol/sdk/client/stdio.js` instead of `cross-spawn`. The `Client` mock provides `connect()`, `callTool()`, `listTools()`, `listResources()`, `listResourceTemplates()`, `close()`. The `StdioClientTransport` mock is a constructor that returns a transport object.

### Success Criteria:

#### Automated Verification:
- [ ] `npm install` succeeds with the new dependency
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] All tests pass: `npm test`
- [ ] `mcpClient.callTool('query', { query: 'test' }, '/tmp')` interface is unchanged

#### Manual Verification:
- [ ] Stdio mode works: with `gitnexus` on PATH, `/gitnexus query <pattern>` returns results
- [ ] All 7 existing tools respond correctly

---

## Phase 2: Config + Server API + Gitnexus Utilities

> **Can run in parallel with Phase 3 after Phase 1.**

### Overview

Add HTTP transport configuration fields, create the `GitNexusServerApi` REST client for Docker server management, and update `runAugment()` / `runGitNexusAnalyze()` to branch on transport type.

### Changes Required:

#### 1. Configuration Interface & Augment Routing
**File**: `src/gitnexus.ts`
**Changes**:

- Extend `GitNexusConfig` interface with 4 new optional fields:
  ```typescript
  mcpTransport?: 'stdio' | 'http';
  mcpServerUrl?: string;
  mcpAuthToken?: string;
  workspaceDir?: string;
  ```

- Update `runAugment()` to branch on transport type:
  - HTTP mode: call `mcpClient.callTool('query', { query: pattern, limit: 3, max_symbols: 5 }, cwd)`, strip `[GitNexus]\n` prefix, catch errors → return `''`
  - Stdio mode: existing subprocess spawn logic unchanged

- Update `runGitNexusAnalyze()` to branch on transport type:
  - HTTP mode: import and use `GitNexusServerApi` to call `analyzeAndWait()`. Map cwd to container path using `workspaceDir` config. Return 0 on success, 1 on failure.
  - Stdio mode: existing subprocess spawn logic unchanged

- Import `mcpClient` for transport type checks. Note: this creates a circular dependency risk since `mcp-client.ts` imports from `gitnexus.ts`. Resolve by having `runAugment()` and `runGitNexusAnalyze()` accept a `transportType` parameter instead of importing `mcpClient` directly, or by extracting the transport type into a shared module.

#### 2. Server REST API Client
**File**: `src/server-api.ts` (NEW)
**Changes**: Create the `GitNexusServerApi` class with:

- `static fromMcpUrl(mcpUrl, authToken?)` — factory that derives base URL from MCP endpoint URL
- `health()` → `Promise<boolean>` — GET `/api/health`
- `info()` → `Promise<ServerInfo>` — GET `/api/info`
- `listRepos()` → `Promise<RepoInfo[]>` — GET `/api/repos`
- `analyze(target: { path?, url?, name? })` → `Promise<AnalyzeJob>` — POST `/api/analyze`
- `analyzeStatus(jobId)` → `Promise<AnalyzeJobStatus>` — GET `/api/analyze/:jobId`
- `analyzeAndWait(target, onProgress?, pollIntervalMs?)` → `Promise<AnalyzeJobStatus>` — poll loop

All types exported: `ServerInfo`, `RepoInfo`, `AnalyzeJob`, `AnalyzeJobStatus`.

Uses built-in `fetch()` (Node 20+). No new dependencies.

#### 3. Config Tests
**File**: `tests/config.test.ts`
**Changes**: Add tests for new config fields:
- New fields are optional and default correctly
- `loadSavedConfig()` returns new fields when present in JSON
- `mcpTransport` validates as `'stdio' | 'http'`

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] All tests pass: `npm test`
- [ ] `GitNexusServerApi.fromMcpUrl('http://localhost:4747/api/mcp')` constructs correctly

#### Manual Verification:
- [ ] `new GitNexusServerApi('http://localhost:4747').health()` returns `true` against running server
- [ ] `new GitNexusServerApi('http://localhost:4747').listRepos()` returns repo list
- [ ] `new GitNexusServerApi('http://localhost:4747').analyze({ path: '/workspace/test' })` returns jobId

---

## Phase 3: Register New Tools + Resources

> **Can run in parallel with Phase 2 after Phase 1.**

### Overview

Register all 13 MCP tools (6 new) and the `gitnexus_read_resource` meta-tool. Update `shouldAllowQuery()` and `buildRepoArgs()` to handle HTTP mode.

### Changes Required:

#### 1. Tool Registration + Guard Updates
**File**: `src/tools.ts`
**Changes**:

- Import `mcpClient` from the rewritten `./mcp-client` (already imported)
- Update `shouldAllowQuery()`: in HTTP mode (`mcpClient.transportType === 'http'`), always return `true`
- Update `buildRepoArgs()`: in HTTP mode, skip `findGitNexusRoot()` — return params without injecting a repo path (let the server decide)

- Register 6 new tools with TypeBox schemas:
  - `gitnexus_route_map` → `route_map` — params: `route?`, `repo?`
  - `gitnexus_tool_map` → `tool_map` — params: `tool?`, `repo?`
  - `gitnexus_shape_check` → `shape_check` — params: `route?`, `repo?`
  - `gitnexus_api_impact` → `api_impact` — params: `route?`, `file?`, `repo?`
  - `gitnexus_group_list` → `group_list` — params: `name?`
  - `gitnexus_group_sync` → `group_sync` — params: `name` (required), `skipEmbeddings?`, `exactOnly?`

- Register `gitnexus_read_resource` tool:
  - params: `uri` (required string)
  - calls `mcpClient.readResource(params.uri, ctx.cwd)`
  - description lists all available resource URIs

- All new tools follow the existing pattern: `buildRepoArgs()` for repo resolution, `mcpClient.callTool()` for execution, `text()` wrapper for return

#### 2. Tool Tests
**File**: `tests/tools.test.ts`
**Changes**:

- Add mock for `readResource` to the existing `mcpClient` mock: `{ callTool: callToolMock, readResource: readResourceMock }`
- Update the tool name list assertion to include all 14 tools (7 existing + 6 new + 1 resource)
- Add test: `shouldAllowQuery` returns true in HTTP mode even without local index
- Add test: `buildRepoArgs` skips local root resolution in HTTP mode
- Add test: `gitnexus_read_resource` calls `readResource` with correct URI
- Add test: `gitnexus_group_sync` requires `name` parameter
- Add test: new tools pass repo through `buildRepoArgs` correctly

Mock `mcpClient.transportType` as a getter: use `Object.defineProperty` or a mutable variable in the mock factory.

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] All tests pass: `npm test`
- [ ] `pi.tools.map(t => t.name)` includes all 14 tool names

#### Manual Verification:
- [ ] In HTTP mode, `gitnexus_route_map` with no params returns results (or clear "no routes" message)
- [ ] `gitnexus_read_resource` with `uri: 'gitnexus://repos'` returns repo list

---

## Phase 4: Session Lifecycle + Commands + UI

### Overview

Wire everything together: HTTP-mode session lifecycle, `/gitnexus` command branching, system prompt updates, new CLI flag, and settings menu additions.

### Changes Required:

#### 1. Extension Entry Point
**File**: `src/index.ts`
**Changes**:

- Import `GitNexusServerApi` from `./server-api`
- Add module-level `let serverApi: GitNexusServerApi | null = null`

- Register new CLI flag:
  ```typescript
  pi.registerFlag('gitnexus-server', {
    type: 'string',
    default: '',
    description: 'GitNexus server URL for HTTP transport. Overrides saved config.',
  });
  ```

- Update `onSession()`:
  - After loading config, check `gitnexus-server` flag — if set, override `cfg.mcpTransport = 'http'` and `cfg.mcpServerUrl`
  - Branch on `cfg.mcpTransport === 'http' && cfg.mcpServerUrl`:
    - HTTP: call `mcpClient.setConfig({ type: 'http', ... })`, create `serverApi`, probe with `serverApi.health()`, notify result
    - Stdio: existing behavior — `mcpClient.setConfig({ type: 'stdio', ... })`, probe binary, check index
  - `mcpClient.stop()` is now async — await it

- Update `session_shutdown`: `await mcpClient.stop()`

- Update `before_agent_start` hook:
  - In HTTP mode, include all 14 tool names in the system prompt injection
  - In HTTP mode, skip the `findGitNexusIndex(ctx.cwd)` guard — tools are always available

- Update `/gitnexus status` handler:
  - HTTP mode: use `serverApi.info()` + `serverApi.listRepos()` to build status output
  - Stdio mode: existing spawn behavior

- Update `/gitnexus analyze` handler:
  - HTTP mode: determine target from args (`url` if starts with `http`, else `workspaceDir/name`, else derive from `cwd` basename). Call `serverApi.analyzeAndWait()` with progress notifications. On completion, `await mcpClient.stop()` + clear caches. 
  - Stdio mode: existing `runGitNexusAnalyze()` behavior

- Update `/gitnexus help` to mention new tools and HTTP mode

#### 2. Main Menu
**File**: `src/ui/main-menu.ts`
**Changes**:

- Accept `mcpClient` transport type info in `MenuContext` (add `transportType: 'stdio' | 'http'` and `serverApi: GitNexusServerApi | null`)
- Update `getStatusLine()`: in HTTP mode, use `serverApi.info()` + `serverApi.listRepos()` instead of spawning `gitnexus status`
- Update `runAnalyze()`: in HTTP mode, use `serverApi.analyzeAndWait()` instead of `runGitNexusAnalyze()`

#### 3. Settings Menu
**File**: `src/ui/settings-menu.ts`
**Changes**:

Add 4 new `SettingItem` entries after the existing items:

- `mcpTransport` — label: "MCP transport", values: `['stdio', 'http']`
- `mcpServerUrl` — label: "Server URL", submenu with `Input` widget (same pattern as `cmd`)
- `mcpAuthToken` — label: "Auth token", submenu with `Input` widget, display `'••••••••'` when set
- `workspaceDir` — label: "Workspace directory", submenu with `Input` widget, default `'/workspace'`

Update the `onChange` handler to persist new fields to config and call `applyChanges()`.

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] All tests pass: `npm test`

#### Manual Verification:
- [ ] Start pi with `--gitnexus-server http://localhost:4747/api/mcp` — see "connected to server" notification
- [ ] `/gitnexus status` shows server version, transport, and repo list in HTTP mode
- [ ] `/gitnexus analyze <repo-name>` triggers server-side analysis and reports progress
- [ ] `/gitnexus analyze https://github.com/user/repo.git` clones and analyzes via server
- [ ] `/gitnexus settings` shows the 4 new settings items
- [ ] Switching transport from `stdio` to `http` in settings takes effect on next session
- [ ] Auto-augment works in HTTP mode (grep results get graph context appended)

---

## Phase 5: Integration Testing + Polish

### Overview

Add test coverage for HTTP-mode behavior in the integration test files, and verify the full end-to-end flow.

### Changes Required:

#### 1. Command Handler Tests
**File**: `tests/index-command.test.ts`
**Changes**:

- Add test: `/gitnexus status` in HTTP mode calls `serverApi.info()` and `serverApi.listRepos()` instead of spawning subprocess
- Add test: `/gitnexus analyze` in HTTP mode calls `serverApi.analyzeAndWait()` with correct workspace path
- Add test: `gitnexus-server` flag overrides config to HTTP mode

Mock strategy: mock `../src/server-api` module alongside existing mocks.

#### 2. Augment Hook Tests
**File**: `tests/augment-hook.test.ts`
**Changes**:

- Add test: in HTTP mode, augment hook calls `mcpClient.callTool('query', ...)` instead of spawning `gitnexus augment`
- Add test: in HTTP mode, augment hook strips `[GitNexus]\n` prefix from query result before appending

Mock strategy: configure `mcpClient` mock with `transportType: 'http'` getter and verify `callTool` is called with query params.

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] All tests pass: `npm test`
- [ ] `npm run check` passes (typecheck + test combined)

#### Manual Verification:
- [ ] Full stdio workflow: install extension, run `/gitnexus analyze`, run search, see augmented results
- [ ] Full HTTP workflow: configure server URL, run `/gitnexus status`, run `/gitnexus analyze`, use tools
- [ ] Switching between stdio and HTTP mode works across sessions

---

## Testing Strategy

### Automated:
- `npm run typecheck` — TypeScript compilation with strict mode
- `npm run lint` — Biome linting on `src/`
- `npm test` — Vitest test suite

### Manual Testing Steps:
1. Install extension in pi, verify no regressions in stdio mode
2. Start GitNexus Docker container at `http://localhost:4747`
3. Configure `--gitnexus-server http://localhost:4747/api/mcp`
4. Run `/gitnexus status` — verify server info displayed
5. Run `/gitnexus analyze` — verify server-side analysis completes
6. Run a grep search — verify auto-augment appends graph context
7. Use `gitnexus_route_map`, `gitnexus_read_resource` tools — verify they work
8. Switch back to stdio mode — verify everything still works

## Performance Considerations

- SDK `Client.connect()` performs the MCP handshake (initialize + notifications/initialized) — same as before but through the SDK
- HTTP mode adds network latency per tool call vs. local stdio pipe — acceptable for a Docker-hosted server
- `ensureConnected()` caches the connection — no reconnect per call
- Idle timeout behavior preserved — prevents stale connections in both modes

## Migration Notes

- **Backwards compatible**: `mcpTransport` defaults to `'stdio'`. No config migration needed.
- **Existing config** (`~/.pi/pi-gitnexus.json`) is forward-compatible — new fields are optional.
- **Tool names unchanged**: The 7 existing tools keep identical names and schemas. 7 new tools are additive.
- **Version bump**: This is a feature release — bump minor version.

## References

- Proposal: `thoughts/shared/research/sdk-based-mcp-proposal.md`
- HTTP transport research: `thoughts/shared/research/http-mcp-support.md`
- MCP SDK: `@modelcontextprotocol/sdk` v1.29.0 — [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
- MCP Streamable HTTP spec: [spec/2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
