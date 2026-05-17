# Proposal: Replace Handrolled MCP Client with `@modelcontextprotocol/sdk`

**Date**: 2026-05-17
**Status**: Draft
**Scope**: Replace `GitNexusMcpClient` with SDK `Client`, support stdio + HTTP transports, register all 13 tools + resources, add Docker server management

---

## 1. Motivation

The current `src/mcp-client.ts` is a handrolled ~175-line stdio JSON-RPC 2.0 client. It works, but:

- It only speaks **stdio** - no HTTP, no SSE, no Streamable HTTP
- It implements its own **JSON-RPC framing**, handshake, pending-request tracking, and error handling - all of which the official SDK already provides
- It cannot call **resources** (`readResource`, `listResourceTemplates`) or **prompts** - the server exposes 10 resources today
- It only registers **7 of 13 tools** the server offers
- Adding HTTP support means either duplicating all of this for a second transport, or abstracting behind an interface - either way the handrolled code becomes the maintenance burden, not the feature

The `@modelcontextprotocol/sdk` v1.29.0 provides a `Client` class with `StdioClientTransport`, `StreamableHTTPClientTransport`, and `SSEClientTransport`. Swapping to it **deletes** the handrolled client, gains multi-transport support, and unlocks resources/prompts for free.

---

## 2. What Gets Deleted

| File / Code                                                       | Lines             | Why                                                                |
| ----------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| `src/mcp-client.ts` - entire file                                 | ~175              | Replaced by SDK `Client` + transport classes                       |
| `cross-spawn` dependency                                          | -                 | SDK's `StdioClientTransport` uses its own `cross-spawn` internally |
| Manual JSON-RPC framing (`buffer`, `pending` Map, `nextId`)       | ~50               | SDK handles all protocol mechanics                                 |
| Manual MCP handshake (`initialize` + `notifications/initialized`) | ~20               | SDK `Client.connect()` does this automatically                     |
| Manual SSE parsing in the HTTP path                               | 0 (never existed) | SDK handles SSE natively                                           |

---

## 3. What Gets Added

### 3.1 New Dependency

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.29.0"
}
```

**Removes:**

```json
"dependencies": {
  "cross-spawn": "7.0.6"   // no longer needed directly - SDK brings its own
}
```

The SDK peer-depends on `zod ^3.25 || ^4.0`. Since pi extensions run inside the pi host process, check whether pi already provides Zod. If not, add it as a dependency.

### 3.2 New/Rewritten Files

| File                                 | Purpose                                                                                                         | Est. Lines      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------- |
| `src/mcp-client.ts` (rewrite)        | Thin wrapper around SDK `Client`; transport factory; lifecycle management                                       | ~200            |
| `src/server-api.ts` (new)            | REST client for GitNexus server management endpoints (`/api/analyze`, `/api/repos`, `/api/health`, `/api/info`) | ~120            |
| `src/tools.ts` (expanded)            | Register all 13 tools + resource-reading tool                                                                   | ~350 (was ~210) |
| `src/gitnexus.ts` (modified)         | Config additions, HTTP-mode augment routing                                                                     | ~30 additions   |
| `src/index.ts` (modified)            | Session lifecycle branching, HTTP-mode status/analyze                                                           | ~60 changes     |
| `src/ui/settings-menu.ts` (modified) | Transport/URL/token settings                                                                                    | ~50 additions   |

---

## 4. Architecture

### 4.1 The New `src/mcp-client.ts`

The SDK `Client` replaces `GitNexusMcpClient` entirely. The new module wraps the SDK in an interface the rest of the extension already expects:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  Tool,
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";

const CLIENT_INFO = { name: "pi-gitnexus", version: "0.6.3" };

/** Idle timeout in ms. 0 = disabled. Set via setMcpIdleTimeout(). */
let idleTimeoutMs = 600_000;

export function setMcpIdleTimeout(seconds: number): void {
  idleTimeoutMs = seconds * 1000;
  mcpClient.refreshIdleTimer();
}

export type TransportConfig =
  | { type: "stdio"; cmd: string[]; env: NodeJS.ProcessEnv }
  | { type: "http"; url: string; authToken?: string };

class GitNexusMcpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private config: TransportConfig = {
    type: "stdio",
    cmd: ["gitnexus"],
    env: process.env,
  };
  private idleTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;

  // Cached server capabilities from the last connection
  private serverTools: Tool[] = [];
  private serverResources: Resource[] = [];
  private serverResourceTemplates: ResourceTemplate[] = [];

  /** Update the transport configuration. Takes effect on next connect. */
  setConfig(config: TransportConfig): void {
    this.config = config;
  }

  /** Returns the current transport type. */
  get transportType(): "stdio" | "http" {
    return this.config.type;
  }

  /**
   * Lazily connect to the MCP server. Idempotent - concurrent calls
   * await the same promise. Creates the appropriate transport based
   * on the current config.
   */
  private ensureConnected(cwd: string): Promise<void> {
    if (this.client) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        const transport = this.createTransport(cwd);
        const client = new Client(CLIENT_INFO);
        await client.connect(transport);

        this.client = client;
        this.transport = transport;

        // Cache server capabilities
        const [toolsResult, resourcesResult, templatesResult] =
          await Promise.all([
            client.listTools().catch(() => ({ tools: [] })),
            client.listResources().catch(() => ({ resources: [] })),
            client
              .listResourceTemplates()
              .catch(() => ({ resourceTemplates: [] })),
          ]);
        this.serverTools = toolsResult.tools;
        this.serverResources = resourcesResult.resources;
        this.serverResourceTemplates = templatesResult.resourceTemplates;
      } catch (err) {
        this.client = null;
        this.transport = null;
        throw err;
      } finally {
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  private createTransport(cwd: string): Transport {
    if (this.config.type === "http") {
      const headers: Record<string, string> = {};
      if (this.config.authToken) {
        headers["Authorization"] = `Bearer ${this.config.authToken}`;
      }
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers },
      });
    }
    // stdio
    const [command, ...args] = this.config.cmd;
    return new StdioClientTransport({
      command,
      args: [...args, "mcp"],
      cwd,
      env: this.config.env as Record<string, string>,
    });
  }

  /**
   * Call an MCP tool and return its formatted text response.
   * Connects lazily if not already connected.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<string> {
    this.clearIdleTimer();
    try {
      await this.ensureConnected(cwd);
      if (!this.client)
        throw new Error("[GitNexus] MCP client is not connected.");

      const result = await this.client.callTool({ name, arguments: args });

      if (result.isError) {
        const text = result.content
          .filter(
            (c): c is { type: "text"; text: string } =>
              c.type === "text" && "text" in c,
          )
          .map((c) => c.text)
          .join("\n");
        throw new Error(`[GitNexus] ${text || "MCP tool reported an error."}`);
      }

      const text = result.content
        .filter(
          (c): c is { type: "text"; text: string } =>
            c.type === "text" && "text" in c,
        )
        .map((c) => c.text)
        .join("\n");

      if (!text) throw new Error("[GitNexus] MCP returned an empty response.");
      return "[GitNexus]\n" + text.slice(0, MAX_OUTPUT_CHARS);
    } finally {
      this.rearmIdleTimer();
    }
  }

  /**
   * Read an MCP resource by URI.
   * Returns the text content, or throws on error.
   */
  async readResource(uri: string, cwd: string): Promise<string> {
    this.clearIdleTimer();
    try {
      await this.ensureConnected(cwd);
      if (!this.client)
        throw new Error("[GitNexus] MCP client is not connected.");

      const result = await this.client.readResource({ uri });
      const text = result.contents
        .filter((c): c is { uri: string; text: string } => "text" in c)
        .map((c) => c.text)
        .join("\n");

      return text || "";
    } finally {
      this.rearmIdleTimer();
    }
  }

  /** Get the list of tools the server reported. */
  getServerTools(): Tool[] {
    return this.serverTools;
  }

  /** Get the list of resources the server reported. */
  getServerResources(): Resource[] {
    return this.serverResources;
  }

  /** Get the resource templates the server reported. */
  getServerResourceTemplates(): ResourceTemplate[] {
    return this.serverResourceTemplates;
  }

  // ── Idle timer ──────────────────────────────────────────────────

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private rearmIdleTimer(): void {
    this.clearIdleTimer();
    if (idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => this.stop(), idleTimeoutMs);
  }

  refreshIdleTimer(): void {
    if (this.client) this.rearmIdleTimer();
    else this.clearIdleTimer();
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Disconnect and clean up. Called on session boundaries and idle timeout. */
  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.connectPromise = null;
    this.serverTools = [];
    this.serverResources = [];
    this.serverResourceTemplates = [];

    const transport = this.transport;
    this.client = null;
    this.transport = null;

    if (transport) {
      // For HTTP: terminateSession sends DELETE to clean up server-side
      if (
        "terminateSession" in transport &&
        typeof transport.terminateSession === "function"
      ) {
        await transport.terminateSession().catch(() => {});
      }
      await transport.close().catch(() => {});
    }
  }
}

export const mcpClient = new GitNexusMcpClient();
```

**Key differences from the handrolled client:**

| Aspect             | Old (Handrolled)                                          | New (SDK)                                                  |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------- |
| Transport          | Manually `spawn()` + pipe stdin/stdout                    | `StdioClientTransport` or `StreamableHTTPClientTransport`  |
| Handshake          | Manual `initialize` + `notifications/initialized` writes  | `Client.connect()` handles it                              |
| Framing            | Manual newline-delimited JSON parsing + buffer management | SDK handles internally                                     |
| Pending tracking   | Manual `Map<id, {resolve, reject}>`                       | SDK handles internally                                     |
| Error handling     | Manual JSON parsing of `msg.error` + `isError`            | SDK throws `McpError`; `callTool` returns `CallToolResult` |
| Process lifecycle  | Manual SIGTERM + event handling                           | SDK `StdioClientTransport.close()` handles SIGTERM→SIGKILL |
| Session management | N/A (stdio only)                                          | SDK manages `Mcp-Session-Id` header automatically          |
| Resources          | Not supported                                             | `Client.readResource()` / `Client.listResources()`         |
| SSE parsing        | Not supported                                             | SDK handles internally                                     |

### 4.2 New File: `src/server-api.ts` - Docker Server Management

When running against an HTTP server (Docker), certain operations that were previously CLI subprocesses need to go through the REST API instead.

**Discovered REST API surface** (probed on `http://localhost:4747`):

| Endpoint              | Method | Purpose            | Request                  | Response                                                                                            |
| --------------------- | ------ | ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `/api/health`         | GET    | Health check       | -                        | `{ status: "ok" }`                                                                                  |
| `/api/info`           | GET    | Server version     | -                        | `{ version, launchContext, nodeVersion }`                                                           |
| `/api/repos`          | GET    | List indexed repos | -                        | `[{ name, path, indexedAt, lastCommit, stats }]`                                                    |
| `/api/analyze`        | POST   | Start indexing     | `{ path?, url?, name? }` | `{ jobId, status: "analyzing"\|"cloning" }`                                                         |
| `/api/analyze/:jobId` | GET    | Job status         | -                        | `{ id, status, repoPath, repoName, progress: { phase, percent, message }, startedAt, completedAt }` |
| `/api/graph`          | GET    | Graph data         | `?repo=name`             | `{ nodes, relationships }`                                                                          |
| `/api/search`         | POST   | Search             | `{ query, repo }`        | `{ results }`                                                                                       |
| `/api/heartbeat`      | GET    | SSE heartbeat      | -                        | SSE stream                                                                                          |

```typescript
// src/server-api.ts

export interface ServerInfo {
  version: string;
  launchContext: string;
  nodeVersion: string;
}

export interface RepoInfo {
  name: string;
  path: string;
  indexedAt: string;
  lastCommit: string;
  stats: {
    files: number;
    nodes: number;
    edges: number;
    communities: number;
    processes: number;
    embeddings: number;
  };
}

export interface AnalyzeJob {
  jobId: string;
  status: "analyzing" | "cloning";
}

export interface AnalyzeJobStatus {
  id: string;
  status: "analyzing" | "cloning" | "complete" | "failed";
  repoPath?: string;
  repoUrl?: string;
  repoName?: string;
  progress: {
    phase: string;
    percent: number;
    message: string;
  };
  startedAt: number;
  completedAt?: number;
  error?: string;
}

/**
 * REST client for GitNexus server management endpoints.
 *
 * These are non-MCP endpoints exposed by the GitNexus HTTP server
 * for operations that don't fit the MCP tool/resource model:
 * triggering analysis, checking health, polling job status.
 */
export class GitNexusServerApi {
  constructor(
    private baseUrl: string,
    private authToken?: string,
  ) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) h["Authorization"] = `Bearer ${this.authToken}`;
    return h;
  }

  /** Derive the REST base URL from the MCP endpoint URL. */
  static fromMcpUrl(mcpUrl: string, authToken?: string): GitNexusServerApi {
    // MCP URL: http://localhost:4747/api/mcp → base: http://localhost:4747
    const url = new URL(mcpUrl);
    const base = `${url.protocol}//${url.host}`;
    return new GitNexusServerApi(base, authToken);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        headers: this.headers,
      });
      const data = (await res.json()) as { status: string };
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  async info(): Promise<ServerInfo> {
    const res = await fetch(`${this.baseUrl}/api/info`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Server info failed: ${res.status}`);
    return res.json() as Promise<ServerInfo>;
  }

  async listRepos(): Promise<RepoInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/repos`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`List repos failed: ${res.status}`);
    return res.json() as Promise<RepoInfo[]>;
  }

  /**
   * Start an analyze job on the server.
   *
   * @param target.path - Filesystem path inside the container (e.g. `/workspace/my-repo`).
   *   Must exist inside the Docker container's workspace_dir. Mutually exclusive with `url`.
   * @param target.url - Git URL to clone and index. The server clones to its
   *   managed repos directory. If already cloned, pulls latest. Mutually exclusive with `path`.
   * @param target.name - Optional repo name override. Otherwise derived from path basename or URL.
   */
  async analyze(target: {
    path?: string;
    url?: string;
    name?: string;
  }): Promise<AnalyzeJob> {
    const res = await fetch(`${this.baseUrl}/api/analyze`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(target),
    });
    const data = (await res.json()) as AnalyzeJob | { error: string };
    if ("error" in data) throw new Error(data.error);
    return data as AnalyzeJob;
  }

  /** Poll a running analyze job for status. */
  async analyzeStatus(jobId: string): Promise<AnalyzeJobStatus> {
    const res = await fetch(`${this.baseUrl}/api/analyze/${jobId}`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Job status failed: ${res.status}`);
    return res.json() as Promise<AnalyzeJobStatus>;
  }

  /**
   * Start analysis and poll until completion or failure.
   * Calls `onProgress` with status updates.
   *
   * @returns The final job status.
   */
  async analyzeAndWait(
    target: { path?: string; url?: string; name?: string },
    onProgress?: (status: AnalyzeJobStatus) => void,
    pollIntervalMs = 2000,
  ): Promise<AnalyzeJobStatus> {
    const job = await this.analyze(target);
    let status: AnalyzeJobStatus;

    do {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      status = await this.analyzeStatus(job.jobId);
      onProgress?.(status);
    } while (status.status !== "complete" && status.status !== "failed");

    return status;
  }
}
```

### 4.3 Config Changes in `src/gitnexus.ts`

```typescript
export interface GitNexusConfig {
  // Existing
  cmd?: string;
  autoAugment?: boolean;
  augmentTimeout?: number;
  maxAugmentsPerResult?: number;
  maxSecondaryPatterns?: number;
  mcpIdleTimeout?: number;

  // New: transport selection
  mcpTransport?: "stdio" | "http"; // default: 'stdio'
  mcpServerUrl?: string; // e.g. 'http://localhost:4747/api/mcp'
  mcpAuthToken?: string; // optional Bearer token
  workspaceDir?: string; // Docker container workspace path (e.g. '/workspace')
}
```

### 4.4 Tool Registration - All 13 Tools + Resources

The current `src/tools.ts` registers 7 tools. The HTTP server exposes 13 tools and 10 resources. The new version registers everything:

**New tools to add (6):**

| Pi Tool Name           | MCP Tool      | Parameters                              |
| ---------------------- | ------------- | --------------------------------------- |
| `gitnexus_route_map`   | `route_map`   | `route?`, `repo?`                       |
| `gitnexus_tool_map`    | `tool_map`    | `tool?`, `repo?`                        |
| `gitnexus_shape_check` | `shape_check` | `route?`, `repo?`                       |
| `gitnexus_api_impact`  | `api_impact`  | `route?`, `file?`, `repo?`              |
| `gitnexus_group_list`  | `group_list`  | `name?`                                 |
| `gitnexus_group_sync`  | `group_sync`  | `name`, `skipEmbeddings?`, `exactOnly?` |

**New resource tool (1):**

| Pi Tool Name             | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `gitnexus_read_resource` | Read any GitNexus resource by URI (repo context, clusters, processes, schema, etc.) |

```typescript
// Example of the resource-reading tool
pi.registerTool({
  name: "gitnexus_read_resource",
  label: "GitNexus Read Resource",
  description:
    "Read a GitNexus resource by URI. Available resources:\n" +
    "  gitnexus://repos - all indexed repos\n" +
    "  gitnexus://setup - onboarding content\n" +
    "  gitnexus://repo/{name}/context - repo overview\n" +
    "  gitnexus://repo/{name}/clusters - functional areas\n" +
    "  gitnexus://repo/{name}/processes - execution flows\n" +
    "  gitnexus://repo/{name}/schema - graph schema for Cypher\n" +
    "  gitnexus://repo/{name}/cluster/{clusterName} - module detail\n" +
    "  gitnexus://repo/{name}/process/{processName} - process trace\n" +
    "  gitnexus://group/{name}/contracts - cross-repo contracts\n" +
    "  gitnexus://group/{name}/status - group index status",
  parameters: Type.Object({
    uri: Type.String({ minLength: 1, maxLength: 500 }),
  }),
  execute: async (_id, params, _signal, _onUpdate, ctx) => {
    const out = await mcpClient.readResource(params.uri, ctx.cwd);
    return text(out || "No content.");
  },
});
```

**Registration strategy:**

All 13 tools + the resource tool are always registered. In stdio mode, tools that the local `gitnexus mcp` server doesn't support will return an MCP error - the agent sees a clear error and moves on. In HTTP mode, all 13 are available. This avoids conditional registration complexity and keeps the tool surface stable.

### 4.5 Session Lifecycle Changes in `src/index.ts`

```typescript
async function onSession(ctx: ExtensionContext) {
  await mcpClient.stop(); // was sync, now async (HTTP needs DELETE)
  clearIndexCache();
  augmentHits = 0;
  hookFires = 0;
  resetAugmentCaches();
  sessionCwd = ctx.cwd;
  await resolveShellPath();

  cfg = loadSavedConfig();
  augmentEnabled = cfg.autoAugment !== false;
  if (cfg.augmentTimeout) setAugmentTimeout(cfg.augmentTimeout);
  if (cfg.mcpIdleTimeout != null) setMcpIdleTimeout(cfg.mcpIdleTimeout);

  const flag = pi.getFlag("gitnexus-cmd") as string | undefined;

  if (cfg.mcpTransport === "http" && cfg.mcpServerUrl) {
    // ── HTTP mode ──────────────────────────────────────────────
    mcpClient.setConfig({
      type: "http",
      url: cfg.mcpServerUrl,
      authToken: cfg.mcpAuthToken,
    });

    // Probe server health instead of binary
    serverApi = GitNexusServerApi.fromMcpUrl(
      cfg.mcpServerUrl,
      cfg.mcpAuthToken,
    );
    const healthy = await serverApi.health();
    binaryAvailable = healthy; // reuse flag - means "backend is available"

    if (healthy) {
      ctx.ui.notify(
        `GitNexus: connected to server at ${cfg.mcpServerUrl}`,
        "info",
      );
    } else {
      ctx.ui.notify(
        `GitNexus: server at ${cfg.mcpServerUrl} is not reachable.`,
        "warning",
      );
    }
  } else {
    // ── Stdio mode (existing behavior) ─────────────────────────
    const cmd = resolveGitNexusCmd(flag, cfg.cmd);
    setGitnexusCmd(cmd);
    mcpClient.setConfig({
      type: "stdio",
      cmd,
      env: spawnEnv,
    });

    binaryAvailable = await probeGitNexusBinary();
    if (!findGitNexusIndex(ctx.cwd)) return;

    if (binaryAvailable) {
      ctx.ui.notify(
        "GitNexus: knowledge graph active - searches will be enriched automatically.",
        "info",
      );
    } else {
      ctx.ui.notify(
        "GitNexus index found but gitnexus is not on PATH. Install: npm i -g gitnexus",
        "warning",
      );
    }
  }
}
```

### 4.6 Analyze in HTTP Mode

The `/gitnexus analyze` command and the `Analyze` menu option need to work differently when connected to a Docker server:

```typescript
// In /gitnexus analyze handler and runAnalyze menu action:

if (mcpClient.transportType === "http" && serverApi) {
  // HTTP mode: trigger server-side analysis
  ctx.ui.notify("GitNexus: starting server-side analysis...", "info");

  try {
    // Determine the target:
    //   /gitnexus analyze https://github.com/... → clone by URL
    //   /gitnexus analyze my-repo               → path in container workspace
    //   /gitnexus analyze                        → derive from cwd + workspaceDir
    let target: { path?: string; url?: string; name?: string };
    if (rest?.startsWith("http")) {
      target = { url: rest };
    } else if (rest) {
      // Treat as a path inside the container's workspace
      const wsDir = cfg.workspaceDir || "/workspace";
      target = { path: `${wsDir}/${rest}` };
    } else {
      // Use cwd basename mapped to workspaceDir
      const repoName = path.basename(ctx.cwd);
      const wsDir = cfg.workspaceDir || "/workspace";
      target = { path: `${wsDir}/${repoName}` };
    }

    const finalStatus = await serverApi.analyzeAndWait(target, (status) => {
      if (status.progress) {
        ctx.ui.notify(
          `GitNexus: ${status.progress.phase} (${status.progress.percent}%) - ${status.progress.message}`,
          "info",
        );
      }
    });

    if (finalStatus.status === "complete") {
      // Reconnect MCP to pick up the new index
      await mcpClient.stop();
      resetAugmentCaches();
      clearIndexCache();
      ctx.ui.notify(
        "GitNexus: analysis complete. Knowledge graph ready.",
        "info",
      );
    } else {
      ctx.ui.notify(
        `GitNexus: analysis failed - ${finalStatus.error || "unknown error"}`,
        "error",
      );
    }
  } catch (error) {
    ctx.ui.notify(
      `GitNexus: ${error instanceof Error ? error.message : "analysis request failed"}`,
      "error",
    );
  }
} else {
  // Stdio mode: existing CLI subprocess behavior
  // ... existing runGitNexusAnalyze(ctx.cwd) logic ...
}
```

### 4.7 Augment in HTTP Mode

The `runAugment()` function spawns `gitnexus augment <pattern>` as a CLI subprocess. In HTTP mode, there's no local binary. Route through the MCP `query` tool instead:

```typescript
// In src/gitnexus.ts

export async function runAugment(
  pattern: string,
  cwd: string,
): Promise<string> {
  if (mcpClient.transportType === "http") {
    // HTTP mode: use the query tool as the augment equivalent
    try {
      const result = await mcpClient.callTool(
        "query",
        {
          query: pattern,
          limit: 3,
          max_symbols: 5,
        },
        cwd,
      );
      // Strip the "[GitNexus]\n" prefix that callTool adds - the hook adds its own label
      return result.startsWith("[GitNexus]\n") ? result.slice(11) : result;
    } catch {
      return "";
    }
  }

  // Stdio mode: existing subprocess behavior
  return new Promise((resolve_) => {
    // ... existing spawn logic ...
  });
}
```

### 4.8 Status in HTTP Mode

```typescript
// In /gitnexus status handler:

if (mcpClient.transportType === "http" && serverApi) {
  try {
    const [info, repos] = await Promise.all([
      serverApi.info(),
      serverApi.listRepos(),
    ]);
    const repoLines = repos
      .map(
        (r) =>
          `  ${r.name}: ${r.stats.nodes} nodes, ${r.stats.edges} edges, ${r.stats.processes} processes`,
      )
      .join("\n");
    const augmentLine = augmentEnabled
      ? `Auto-augment: on (${hookFires} intercepted, ${augmentHits} enriched)`
      : "Auto-augment: off";
    ctx.ui.notify(
      `GitNexus Server v${info.version} (${info.launchContext})\n` +
        `Transport: HTTP → ${cfg.mcpServerUrl}\n` +
        `Repos:\n${repoLines || "  (none indexed)"}\n` +
        augmentLine,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `GitNexus: server not reachable - ${error instanceof Error ? error.message : "unknown error"}`,
      "error",
    );
  }
} else {
  // existing stdio status logic
}
```

### 4.9 Settings Menu Additions

New settings items for `src/ui/settings-menu.ts`:

```typescript
{
  id: 'mcpTransport',
  label: 'MCP transport',
  description:
    'How to connect to GitNexus. "stdio" spawns a local gitnexus process. ' +
    '"http" connects to a remote/Docker server via Streamable HTTP.',
  currentValue: cfg.mcpTransport ?? 'stdio',
  values: ['stdio', 'http'],
},
{
  id: 'mcpServerUrl',
  label: 'Server URL',
  description:
    'The MCP endpoint URL when using HTTP transport. ' +
    'Example: http://localhost:4747/api/mcp',
  currentValue: cfg.mcpServerUrl ?? '',
  submenu: (currentValue, finish) => {
    const input = new Input();
    input.setValue(currentValue);
    input.focused = true;
    input.onSubmit = (value) => finish(value.trim() || undefined);
    input.onEscape = () => finish(undefined);
    return { /* same pattern as the cmd setting */ };
  },
},
{
  id: 'mcpAuthToken',
  label: 'Auth token',
  description:
    'Optional Bearer token for authenticating with the MCP server. ' +
    'Leave empty if the server does not require authentication.',
  currentValue: cfg.mcpAuthToken ? '••••••••' : '(none)',
  submenu: (currentValue, finish) => {
    const input = new Input();
    input.setValue(currentValue === '••••••••' ? '' : currentValue);
    input.focused = true;
    input.onSubmit = (value) => finish(value.trim() || undefined);
    input.onEscape = () => finish(undefined);
    return { /* same pattern as the cmd setting */ };
  },
},
{
  id: 'workspaceDir',
  label: 'Workspace directory',
  description:
    'The workspace directory inside the Docker container where repos are mounted. ' +
    'Used to construct paths for /gitnexus analyze in HTTP mode. ' +
    'Example: /workspace',
  currentValue: cfg.workspaceDir ?? '/workspace',
  submenu: (currentValue, finish) => {
    const input = new Input();
    input.setValue(currentValue);
    input.focused = true;
    input.onSubmit = (value) => finish(value.trim() || undefined);
    input.onEscape = () => finish(undefined);
    return { /* same pattern as the cmd setting */ };
  },
},
```

### 4.10 System Prompt Injection Update

The `before_agent_start` hook should list all available tools, and in HTTP mode, mention resources:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const isHttp = mcpClient.transportType === "http";
  if (!isHttp && !findGitNexusIndex(ctx.cwd)) return;
  if (event.systemPrompt == null) return;

  const toolList = isHttp
    ? "gitnexus_query, gitnexus_context, gitnexus_impact, gitnexus_detect_changes, " +
      "gitnexus_list_repos, gitnexus_rename, gitnexus_cypher, gitnexus_route_map, " +
      "gitnexus_tool_map, gitnexus_shape_check, gitnexus_api_impact, " +
      "gitnexus_group_list, gitnexus_group_sync, gitnexus_read_resource"
    : "gitnexus_query, gitnexus_context, gitnexus_impact, gitnexus_detect_changes, " +
      "gitnexus_list_repos, gitnexus_rename, gitnexus_cypher";

  return {
    systemPrompt:
      event.systemPrompt +
      `\n\n[GitNexus active] Graph context will appear after search results. ` +
      `Use ${toolList} for deeper analysis. ` +
      (isHttp
        ? "Connected to GitNexus server via HTTP."
        : "If the index is stale after code changes, run /gitnexus analyze to rebuild it."),
  };
});
```

### 4.11 Guard Changes - `shouldAllowQuery()`

```typescript
function shouldAllowQuery(
  ctx: ExtensionContext,
  params: Record<string, unknown>,
): boolean {
  // In HTTP mode, always allow - the server manages repos
  if (mcpClient.transportType === "http") return true;
  // In stdio mode, need a local index or explicit repo override
  return hasRepoOverride(params) || findGitNexusIndex(ctx.cwd);
}
```

### 4.12 CLI Flag for Server URL

Add a second flag for quick one-off HTTP connections:

```typescript
pi.registerFlag("gitnexus-server", {
  type: "string",
  default: "",
  description:
    'GitNexus server URL for HTTP transport (e.g. "http://localhost:4747/api/mcp"). Overrides saved config.',
});
```

Session startup checks the flag first:

```typescript
const serverFlag = pi.getFlag("gitnexus-server") as string | undefined;
if (serverFlag?.trim()) {
  // Override config - force HTTP mode
  cfg.mcpTransport = "http";
  cfg.mcpServerUrl = serverFlag.trim();
}
```

---

## 5. Repo Resolution in HTTP Mode

In stdio mode, `buildRepoArgs()` walks up directories looking for `.gitnexus/`. In HTTP mode, there's no local `.gitnexus/` directory - the server manages its own repo index.

**Behavior change:**

```typescript
function buildRepoArgs(
  ctx: ExtensionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  // If the user explicitly passed a repo, normalize it
  const normalizedRepo =
    typeof params.repo === "string"
      ? normalizeRepoOverride(params.repo)
      : undefined;
  if (normalizedRepo) return { ...params, repo: normalizedRepo };

  if (mcpClient.transportType === "http") {
    // HTTP mode: don't inject a repo path - let the server use its default
    // (or the agent can pass repo explicitly from gitnexus_list_repos results)
    return params;
  }

  // Stdio mode: existing behavior - find local .gitnexus root
  const repoRoot = findGitNexusRoot(ctx.cwd);
  return repoRoot ? { ...params, repo: repoRoot } : params;
}
```

---

## 6. File-by-File Change Summary

| File                       | Action      | What Changes                                                                                             |
| -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `src/mcp-client.ts`        | **Rewrite** | Delete handrolled client; new SDK wrapper (~200 lines replaces ~175)                                     |
| `src/server-api.ts`        | **New**     | REST client for `/api/analyze`, `/api/repos`, `/api/health`, `/api/info` (~120 lines)                    |
| `src/tools.ts`             | **Expand**  | Add 6 new tools + `gitnexus_read_resource`; update `shouldAllowQuery` and `buildRepoArgs` for HTTP mode  |
| `src/gitnexus.ts`          | **Modify**  | Config interface additions; `runAugment()` HTTP routing; `runGitNexusAnalyze()` HTTP branching           |
| `src/index.ts`             | **Modify**  | Session lifecycle branching; status/analyze HTTP paths; new `gitnexus-server` flag; system prompt update |
| `src/ui/settings-menu.ts`  | **Modify**  | Add transport/URL/token/workspaceDir settings (4 new items)                                              |
| `src/ui/main-menu.ts`      | **Modify**  | Status and analyze functions branch on transport type                                                    |
| `package.json`             | **Modify**  | Add `@modelcontextprotocol/sdk` dep; keep `cross-spawn`; add `zod` peer dep                              |
| `tests/mcp-client.test.ts` | **Rewrite** | Test the new SDK wrapper instead of handrolled client                                                    |
| `tests/tools.test.ts`      | **Expand**  | Add tests for new tools + HTTP-mode guards                                                               |

---

## 7. Migration & Backwards Compatibility

- **Default behavior is unchanged.** `mcpTransport` defaults to `'stdio'`. Users who never configure HTTP see identical behavior.
- **Existing config** (`~/.pi/pi-gitnexus.json`) is forward-compatible - new fields are optional and additive.
- **The 7 existing tools** keep the same names, schemas, and behavior. The agent won't notice the transport changed.
- **`runAugment()`** in stdio mode still spawns `gitnexus augment` - no change to the auto-augment hook's behavior.

---

## 8. Dependency Analysis

### What `@modelcontextprotocol/sdk` v1.29.0 Brings

| Dep                               | Size   | Purpose                                  |
| --------------------------------- | ------ | ---------------------------------------- |
| `@modelcontextprotocol/sdk`       | ~600KB | Client, transports, types                |
| `zod` (peer)                      | ~120KB | Schema validation (may already be in pi) |
| `cross-spawn` (transitive)        | ~12KB  | Used by `StdioClientTransport`           |
| `eventsource-parser` (transitive) | ~8KB   | SSE parsing                              |
| `pkce-challenge` (transitive)     | ~4KB   | OAuth PKCE support                       |

**Net impact:** ~600-750KB added to `node_modules`. `cross-spawn` stays as a direct dep (still needed for `runAugment()` and `runGitNexusAnalyze()` CLI subprocess spawning in stdio mode). The SDK also brings its own `cross-spawn` transitively for `StdioClientTransport`.

### Zod Compatibility

✅ **Resolved.** Pi host provides `zod@4.4.3` at runtime. The SDK peer-depends on `zod ^3.25 || ^4.0`, which is satisfied. Add `zod` as a `peerDependency` to ensure the constraint is documented:

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

---

## 9. Estimated Effort

| Component                           | Effort       | Lines Changed/Added          |
| ----------------------------------- | ------------ | ---------------------------- |
| `src/mcp-client.ts` rewrite         | Medium       | ~200 (replace ~175)          |
| `src/server-api.ts` new             | Small-Medium | ~120 new                     |
| `src/tools.ts` expansion            | Medium       | ~150 additions               |
| `src/gitnexus.ts` modifications     | Small        | ~40 changes                  |
| `src/index.ts` modifications        | Medium       | ~80 changes                  |
| `src/ui/settings-menu.ts` additions | Small        | ~60 additions                |
| `src/ui/main-menu.ts` modifications | Small        | ~30 changes                  |
| `package.json`                      | Trivial      | ~5 changes                   |
| Test updates                        | Medium       | ~200 changes                 |
| **Total**                           |              | **~900 lines changed/added** |

---

## 10. Resolved Questions

1. **Zod availability:** ✅ Pi host provides `zod@4.4.3` at runtime. The SDK peer-depends on `zod ^3.25 || ^4.0`, which is satisfied. Add `zod` as a `peerDependency` (not a direct dep) alongside the existing pi peer deps — the host already supplies it.

2. **Docker volume mounts:** ✅ **User configures path mappings.** The Docker GitNexus server has a `workspace_dir` configured in its environment. Repos must live there. The `POST /api/analyze` endpoint accepts:
   - `path` (required OR `url`) — a filesystem path **inside the container** (e.g. `/workspace/my-repo`)
   - `url` (required OR `path`) — a git URL; the server clones it to its own managed directory
   - `name` (optional) — override the repo name (otherwise derived from path/url)

   If the path doesn't exist inside the container, the job fails with `ENOENT`. The extension should expect the user to have the repo available in the Docker workspace (via volume mount), or fall back to the git URL flow. The config should store a `workspaceDir` to help construct paths.

3. **Augment quality in HTTP mode:** Using `query` as the augment equivalent produces different output than `gitnexus augment`. The auto-augment hook may need its output reformatted or truncated differently. Worth testing empirically.

4. **Tool registration timing:** All tools are always registered. Server errors are clear enough if a tool isn't supported.

5. **`cross-spawn` retention:** ✅ Keep `cross-spawn` as a direct dependency. It's still needed for `runAugment()` and `runGitNexusAnalyze()` in stdio mode — these spawn the CLI binary directly, not through the SDK.
