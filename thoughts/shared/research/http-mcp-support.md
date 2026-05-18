# Research: Adding HTTP-Based MCP Support to pi-gitnexus

**Date**: 2026-05-17  
**Context**: GitNexus backend running in Docker, exposing MCP server at `http://localhost:4747/api/mcp`

---

## 1. Current Architecture

### How the Extension Works Today

pi-gitnexus is a pi coding agent extension that communicates with GitNexus exclusively via **stdio JSON-RPC 2.0** — it spawns `gitnexus mcp` as a child process and pipes messages through stdin/stdout.

**Key components:**

| File                | Role                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `src/mcp-client.ts` | `GitNexusMcpClient` — stdio JSON-RPC client; spawns `gitnexus mcp`, manages lifecycle |
| `src/tools.ts`      | 7 registered tools, all delegate to `mcpClient.callTool()`                            |
| `src/gitnexus.ts`   | Utilities: `runAugment()` (CLI subprocess), config, path resolution                   |
| `src/index.ts`      | Entry point: registers tools/commands/events, auto-augment hook, session lifecycle    |

**Two communication channels currently exist:**

1. **Persistent MCP stdio client** (`GitNexusMcpClient`) — for all 7 registered tools and `/gitnexus query|context|impact` slash commands
2. **CLI subprocess** (`gitnexus augment <pattern>`) — for the auto-augment `tool_result` hook; spawned per-invocation

### What the Stdio Client Does

```
┌──────────────┐  stdin (JSON-RPC)  ┌──────────────────┐
│  pi-gitnexus │ ───────────────── │  gitnexus mcp    │
│  extension   │ ◄─────────────── │  (child process)  │
└──────────────┘  stdout (JSON-RPC) └──────────────────┘
```

- Lazily spawns on first `callTool()` — no network, no port
- MCP initialize handshake (protocol `2024-11-05`)
- Newline-delimited JSON framing
- Idle timeout (default 600s) kills the process; next call re-spawns
- `stop()` on session_start, session_shutdown, and before/after `gitnexus analyze`

---

## 2. The HTTP MCP Server (Probed Live)

The GitNexus backend at `http://localhost:4747/api/mcp` implements **MCP Streamable HTTP** (protocol version `2025-03-26`).

### Server Identity

```
serverInfo: { name: "gitnexus", version: "1.6.5" }
capabilities: { tools: {}, resources: {}, prompts: {} }
```

### Transport Behavior (Confirmed)

| Aspect              | Behavior                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Protocol            | MCP Streamable HTTP (single endpoint)                                                                   |
| Endpoint            | `POST http://localhost:4747/api/mcp`                                                                    |
| Session header      | `Mcp-Session-Id` returned on initialize                                                                 |
| Response format     | `text/event-stream` (SSE) — all responses wrapped in `event: message\ndata: {...}\n\n`                  |
| Session enforcement | Returns `{"error":{"code":-32001,"message":"Session not found. Re-initialize."}}` without valid session |

### Tools Available (13 total)

The HTTP server exposes **13 tools** — 6 more than the extension currently registers:

| Tool             | Registered in Extension?     | Description               |
| ---------------- | ---------------------------- | ------------------------- |
| `list_repos`     | ✅ `gitnexus_list_repos`     | List indexed repos        |
| `query`          | ✅ `gitnexus_query`          | Search knowledge graph    |
| `context`        | ✅ `gitnexus_context`        | 360° symbol view          |
| `detect_changes` | ✅ `gitnexus_detect_changes` | Analyze git changes       |
| `rename`         | ✅ `gitnexus_rename`         | Multi-file rename         |
| `impact`         | ✅ `gitnexus_impact`         | Blast radius analysis     |
| `cypher`         | ✅ `gitnexus_cypher`         | Raw Cypher queries        |
| `route_map`      | ❌                           | API route mappings        |
| `tool_map`       | ❌                           | MCP/RPC tool definitions  |
| `shape_check`    | ❌                           | Response shape validation |
| `api_impact`     | ❌                           | Pre-change API impact     |
| `group_list`     | ❌                           | Repository groups         |
| `group_sync`     | ❌                           | Rebuild contract registry |

### Resources Available

**Static resources:**

- `gitnexus://repos` — All indexed repos with stats
- `gitnexus://setup` — AGENTS.md content for onboarding

**Resource templates:**

- `gitnexus://repo/{name}/context` — Repo overview
- `gitnexus://repo/{name}/clusters` — Functional areas
- `gitnexus://repo/{name}/processes` — Execution flows
- `gitnexus://repo/{name}/schema` — Graph schema for Cypher
- `gitnexus://repo/{name}/cluster/{clusterName}` — Module detail
- `gitnexus://repo/{name}/process/{processName}` — Process trace
- `gitnexus://group/{name}/contracts` — Cross-repo contracts
- `gitnexus://group/{name}/status` — Group index status

---

## 3. MCP Streamable HTTP Protocol

### How It Works

Unlike the legacy SSE transport (which required two endpoints — `GET /sse` for receiving and `POST /messages` for sending), Streamable HTTP uses a **single endpoint** for everything:

```
Client                                    Server
  │                                          │
  │── POST /mcp (initialize) ──────────────►│
  │◄── 200 + Mcp-Session-Id header ─────────│
  │                                          │
  │── POST /mcp (notifications/initialized)►│
  │◄── 202 Accepted ────────────────────────│
  │                                          │
  │── POST /mcp (tools/list) ──────────────►│
  │◄── 200 (JSON or SSE stream) ────────────│
  │                                          │
  │── POST /mcp (tools/call) ──────────────►│
  │◄── 200 (JSON or SSE stream) ────────────│
  │                                          │
  │── DELETE /mcp (terminate session) ─────►│
  │◄── 200 ─────────────────────────────────│
```

### Required Headers

Every request MUST include:

- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`
- `Mcp-Session-Id: <id>` (after initialization, if server assigned one)

### Response Formats

The server can respond in three ways:

1. **`202 Accepted`** (no body) — for notifications
2. **`200` with `Content-Type: application/json`** — direct JSON response
3. **`200` with `Content-Type: text/event-stream`** — SSE stream (what the GitNexus server does)

The GitNexus server always returns SSE format:

```
event: message
data: {"result":{...},"jsonrpc":"2.0","id":1}
```

---

## 4. Implementation Approach

### Option A: Use the Official MCP SDK (Recommended)

The `@modelcontextprotocol/sdk` package (v1.29.0, production) provides `StreamableHTTPClientTransport`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "pi-gitnexus", version: "0.6.3" });
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:4747/api/mcp"),
);
await client.connect(transport);

// List tools
const { tools } = await client.listTools();

// Call a tool
const result = await client.callTool({
  name: "query",
  arguments: { query: "auth flow" },
});

// Read a resource
const resource = await client.readResource({ uri: "gitnexus://repos" });

// Cleanup
await transport.terminateSession();
await client.close();
```

**Pros:**

- Full protocol compliance (session management, SSE parsing, reconnection)
- Handles both JSON and SSE response formats automatically
- Built-in auth support (Bearer tokens, OAuth 2.1)
- Maintained by the MCP team
- Also supports resources, prompts, and notifications out of the box

**Cons:**

- Adds ~600KB dependency (the full SDK)
- Bundles server-side code you don't need
- API surface is larger than what the extension uses

### Option B: Thin Custom HTTP Client (Lighter Weight)

Build a minimal HTTP client that speaks Streamable HTTP, similar to how `GitNexusMcpClient` is a thin stdio client today:

```typescript
class GitNexusHttpClient {
  private sessionId: string | null = null;
  private nextId = 2;

  constructor(private url: string) {}

  async start(): Promise<void> {
    const response = await this.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "pi-gitnexus", version: "0.6.3" },
      },
    });
    this.sessionId = response.headers.get("mcp-session-id");
    // Send initialized notification
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return this.extractText(await this.parseResponse(response));
  }

  private async send(msg: object): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    return fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
    });
  }

  private async parseResponse(response: Response): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // Parse SSE: extract data lines
      const text = await response.text();
      const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(dataLine!.slice(6));
    }
    return response.json();
  }

  async stop(): Promise<void> {
    if (this.sessionId) {
      await fetch(this.url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": this.sessionId },
      }).catch(() => {});
    }
    this.sessionId = null;
  }
}
```

**Pros:**

- Zero new dependencies (uses built-in `fetch`)
- ~100 lines vs ~600KB SDK
- Exactly the same pattern as the existing stdio client
- Easy to understand and maintain

**Cons:**

- Must handle SSE parsing manually
- No built-in reconnection/resumability
- Must implement session lifecycle management
- No resource/prompt support without adding it

### Recommendation

**Option B (thin custom client)** aligns better with the extension's existing architecture. The current `GitNexusMcpClient` is already a thin client (~175 lines). A parallel `GitNexusHttpClient` of similar size keeps the codebase consistent and avoids pulling in a large SDK for what amounts to simple POST+parse operations.

However, if the extension later needs to support arbitrary third-party MCP servers (not just GitNexus), the SDK would be the better foundation.

---

## 5. Architecture Changes Required

### 5.1 New File: `src/http-client.ts`

A `GitNexusHttpClient` class that mirrors `GitNexusMcpClient`'s interface but communicates over HTTP:

```typescript
interface McpClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<string>;
  stop(): void;
  refreshIdleTimer(): void;
}
```

Key differences from the stdio client:

- No process spawning — uses `fetch()` to a configured URL
- Session management via `Mcp-Session-Id` header instead of process lifecycle
- SSE response parsing (the GitNexus server returns `text/event-stream`)
- No `cwd` needed for spawning — but still accepted for interface compatibility
- Idle timeout → session termination (`DELETE`) instead of `SIGTERM`

### 5.2 Modified: `src/gitnexus.ts` — Configuration

Add HTTP server config:

```typescript
export interface GitNexusConfig {
  cmd?: string;
  autoAugment?: boolean;
  augmentTimeout?: number;
  maxAugmentsPerResult?: number;
  maxSecondaryPatterns?: number;
  mcpIdleTimeout?: number;
  // New HTTP fields
  mcpTransport?: "stdio" | "http"; // default: 'stdio'
  mcpServerUrl?: string; // e.g. 'http://localhost:4747/api/mcp'
  mcpAuthToken?: string; // optional Bearer token
}
```

### 5.3 Modified: `src/mcp-client.ts` — Transport Abstraction

Introduce a common interface and factory:

```typescript
// Common interface both clients implement
export interface McpTransport {
  callTool(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<string>;
  stop(): void;
  refreshIdleTimer(): void;
}

// Factory that returns the right client based on config
export function createMcpClient(config: GitNexusConfig): McpTransport {
  if (config.mcpTransport === "http" && config.mcpServerUrl) {
    return new GitNexusHttpClient(config.mcpServerUrl, config.mcpAuthToken);
  }
  return new GitNexusMcpClient();
}
```

The exported `mcpClient` singleton becomes a `let` that can be swapped:

```typescript
export let mcpClient: McpTransport = new GitNexusMcpClient();

export function setMcpClient(client: McpTransport): void {
  mcpClient.stop();
  mcpClient = client;
}
```

### 5.4 Modified: `src/index.ts` — Session Lifecycle

On `session_start`, after loading config, create the appropriate client:

```typescript
async function onSession(ctx: ExtensionContext) {
  mcpClient.stop();
  // ... existing setup ...

  cfg = loadSavedConfig();

  // Create the right transport
  if (cfg.mcpTransport === "http" && cfg.mcpServerUrl) {
    setMcpClient(new GitNexusHttpClient(cfg.mcpServerUrl, cfg.mcpAuthToken));
    // Skip binary probe — not needed for HTTP mode
    binaryAvailable = true; // tools are available via HTTP
  } else {
    setMcpClient(new GitNexusMcpClient());
    binaryAvailable = await probeGitNexusBinary();
  }
}
```

### 5.5 Modified: `src/tools.ts` — Repo Resolution

In HTTP mode, there's no local `.gitnexus/` directory to find. The `shouldAllowQuery()` and `buildRepoArgs()` logic needs to handle this:

```typescript
function shouldAllowQuery(
  ctx: ExtensionContext,
  params: Record<string, unknown>,
): boolean {
  // In HTTP mode, always allow (the server manages repos)
  if (isHttpMode()) return true;
  return hasRepoOverride(params) || findGitNexusIndex(ctx.cwd);
}
```

### 5.6 Modified: `src/gitnexus.ts` — Augment in HTTP Mode

The `runAugment()` function currently spawns `gitnexus augment <pattern>` as a subprocess. In HTTP mode, there are two options:

**Option A**: Route augment through the HTTP MCP client using the `query` tool:

```typescript
export async function runAugment(
  pattern: string,
  cwd: string,
): Promise<string> {
  if (isHttpMode()) {
    try {
      return await mcpClient.callTool(
        "query",
        { query: pattern, limit: 3 },
        cwd,
      );
    } catch {
      return "";
    }
  }
  // existing subprocess logic...
}
```

**Option B**: Keep augment as a separate concept and call the server's augment endpoint if one exists. Based on the probed tools, the `query` tool is the closest equivalent.

### 5.7 Modified: `src/ui/settings-menu.ts` — Settings UI

Add settings for transport selection and server URL:

```typescript
// New settings items
{ key: 'mcpTransport', label: 'MCP Transport', values: ['stdio', 'http'] },
{ key: 'mcpServerUrl', label: 'Server URL', type: 'text', placeholder: 'http://localhost:4747/api/mcp' },
{ key: 'mcpAuthToken', label: 'Auth Token', type: 'text', sensitive: true },
```

### 5.8 New Tools (Optional)

Register the 6 additional tools exposed by the HTTP server:

| New Tool               | MCP Method    | Notes                     |
| ---------------------- | ------------- | ------------------------- |
| `gitnexus_route_map`   | `route_map`   | API route mappings        |
| `gitnexus_tool_map`    | `tool_map`    | Tool definitions          |
| `gitnexus_shape_check` | `shape_check` | Response shape validation |
| `gitnexus_api_impact`  | `api_impact`  | Pre-change API impact     |
| `gitnexus_group_list`  | `group_list`  | List repo groups          |
| `gitnexus_group_sync`  | `group_sync`  | Rebuild contract registry |

These could be registered conditionally (only when connected via HTTP and the server reports them in `tools/list`), or always registered and guarded like the existing tools.

### 5.9 Resource Support (Optional)

The HTTP server exposes resources that the stdio mode doesn't. Resources could be exposed as:

- Additional tools (e.g., `gitnexus_read_resource`)
- Slash commands (e.g., `/gitnexus schema <repo>`)
- Used internally by the augment hook for richer context

---

## 6. What Changes vs. What Stays the Same

### Stays the Same

- All 7 existing tools and their parameter schemas
- The `tool_result` auto-augment hook (pattern extraction, caching, append logic)
- Slash command structure (`/gitnexus status|analyze|query|...`)
- Settings persistence (`~/.pi/pi-gitnexus.json`)
- Path normalization and safety checks
- System prompt injection on `before_agent_start`

### Changes

- `mcpClient` becomes a swappable interface instead of a concrete class
- Config gains `mcpTransport`, `mcpServerUrl`, `mcpAuthToken` fields
- Session startup branches on transport type
- `shouldAllowQuery()` bypasses local index check in HTTP mode
- `runAugment()` routes through HTTP client instead of CLI subprocess
- Settings menu gains transport configuration
- `/gitnexus analyze` behavior changes in HTTP mode (could trigger server-side reindex or be disabled)
- `/gitnexus status` fetches status from server instead of CLI subprocess

---

## 7. Key Decisions to Make

### 7.1 Transport Selection UX

**Option A: Config-only** — User sets `mcpTransport: "http"` and `mcpServerUrl` in settings.  
**Option B: Auto-detect** — Try to connect to configured URL; if it fails, fall back to stdio.  
**Option C: CLI flag** — `--gitnexus-server http://localhost:4747/api/mcp` flag on pi startup.

Recommendation: **A + C** — config for persistence, flag for one-off override. Auto-detect adds complexity and latency.

### 7.2 Augment Behavior in HTTP Mode

The `gitnexus augment` CLI command doesn't exist on the server. Options:

- **Use `query` tool** as the augment equivalent (closest match)
- **Add an augment endpoint** to the GitNexus server (requires server changes)
- **Disable augment** in HTTP mode and rely solely on registered tools

Recommendation: **Use `query`** with a small limit (3-5 results) and format the output to match augment's format.

### 7.3 `/gitnexus analyze` in HTTP Mode

When the backend is in Docker, the user can't run `gitnexus analyze` locally. Options:

- **Server-side reindex** — if the server exposes an analyze/reindex endpoint
- **Disable the command** and show a message like "Reindex from the GitNexus dashboard"
- **Keep it** for local-first users who also have the CLI installed

Recommendation: **Keep it for local mode, disable/redirect for HTTP mode**.

### 7.4 Session ID Lifecycle

The stdio client kills the process to reset. The HTTP client needs to:

- `DELETE` the session on `session_shutdown`
- Create a new session on `session_start`
- Handle `404 Not Found` (stale session) by re-initializing

### 7.5 Error Handling for Network Issues

Unlike stdio (where process death is the only failure), HTTP has:

- Connection refused (server down)
- Timeout (server slow)
- Session expired (server restarted)
- Auth failures (401)

All need clear user-facing messages and graceful degradation.

---

## 8. Dependency Impact

### If Using SDK (Option A)

```json
"dependencies": {
  "cross-spawn": "7.0.6",
  "@modelcontextprotocol/sdk": "^1.29.0"  // adds ~600KB
}
```

### If Using Custom Client (Option B)

```json
"dependencies": {
  "cross-spawn": "7.0.6"
  // No new dependencies — uses built-in fetch()
}
```

Node.js has built-in `fetch` since v18 (stable since v21). The extension targets Node 20+ (CI runs on Node 20), so `fetch` is available.

---

## 9. Estimated Scope

| Component                                      | Effort | Lines (Est.)       |
| ---------------------------------------------- | ------ | ------------------ |
| `src/http-client.ts` (new)                     | Medium | ~150-200           |
| `src/mcp-client.ts` (refactor to interface)    | Small  | ~30 changes        |
| `src/gitnexus.ts` (config + augment routing)   | Small  | ~20-30 additions   |
| `src/index.ts` (session lifecycle branching)   | Medium | ~40-50 changes     |
| `src/tools.ts` (shouldAllowQuery + new tools)  | Medium | ~100-150 additions |
| `src/ui/settings-menu.ts` (transport settings) | Small  | ~30 additions      |
| Tests                                          | Medium | ~200-300           |
| **Total**                                      |        | **~600-800 lines** |
