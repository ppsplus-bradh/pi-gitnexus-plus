import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MAX_OUTPUT_CHARS } from './gitnexus';

const CLIENT_INFO = { name: 'pi-gitnexus', version: '0.6.3' };

/** Idle timeout in ms. 0 = disabled (kept alive for the session). Set via setMcpIdleTimeout(). */
let idleTimeoutMs = 600_000;

export function setMcpIdleTimeout(seconds: number): void {
  idleTimeoutMs = seconds * 1000;
  mcpClient.refreshIdleTimer();
}

export type TransportConfig =
  | { type: 'stdio'; cmd: string[]; env: NodeJS.ProcessEnv }
  | { type: 'http'; url: string; authToken?: string };

/** Minimal shape we cache from listTools(). */
interface ServerTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] };
}

/** Minimal shape we cache from listResources(). */
interface ServerResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Minimal shape we cache from listResourceTemplates(). */
interface ServerResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * SDK-backed MCP client for `gitnexus mcp` (stdio) or a remote GitNexus
 * server (Streamable HTTP).
 *
 * The MCP connection is started lazily on the first callTool() / readResource()
 * invocation and stopped after `idleTimeoutMs` of inactivity (configurable via
 * setMcpIdleTimeout; default 600 s, 0 = disabled). stop() — also called on
 * session_start and session_shutdown — tears down the connection; the next
 * callTool() reconnects with the new cwd / config.
 */
class GitNexusMcpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private config: TransportConfig = { type: 'stdio', cmd: ['gitnexus'], env: process.env };
  private idleTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  // Cached server capabilities from the last connection
  private serverToolsCache: ServerTool[] = [];
  private serverResourcesCache: ServerResource[] = [];
  private serverResourceTemplatesCache: ServerResourceTemplate[] = [];

  /** Update the transport configuration. Takes effect on next connect. */
  setConfig(config: TransportConfig): void {
    this.config = config;
  }

  /** Returns the current transport type. */
  get transportType(): 'stdio' | 'http' {
    return this.config.type;
  }

  // ── Connection ────────────────────────────────────────────────

  /**
   * Lazily connect to the MCP server. Idempotent — concurrent calls
   * await the same promise; only one connection is created.
   */
  private ensureConnected(cwd: string): Promise<void> {
    if (this.client) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve_, reject_) => {
      this.connectReject = reject_;

      (async () => {
        const transport = this.createTransport(cwd);
        const client = new Client(CLIENT_INFO);
        await client.connect(transport);

        this.client = client;
        this.transport = transport;

        // Cache server capabilities (best-effort — errors → empty arrays)
        const [toolsResult, resourcesResult, templatesResult] = await Promise.all([
          client.listTools().catch(() => ({ tools: [] as ServerTool[] })),
          client.listResources().catch(() => ({ resources: [] as ServerResource[] })),
          client.listResourceTemplates().catch(() => ({ resourceTemplates: [] as ServerResourceTemplate[] })),
        ]);
        this.serverToolsCache = toolsResult.tools as ServerTool[];
        this.serverResourcesCache = resourcesResult.resources as ServerResource[];
        this.serverResourceTemplatesCache = templatesResult.resourceTemplates as ServerResourceTemplate[];

        resolve_();
      })().catch((err) => {
        this.client = null;
        this.transport = null;
        reject_(err);
      }).finally(() => {
        this.connectPromise = null;
        this.connectReject = null;
      });
    });

    return this.connectPromise;
  }

  private createTransport(cwd: string): Transport {
    if (this.config.type === 'http') {
      const headers: Record<string, string> = {};
      if (this.config.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers },
      });
    }

    // stdio
    const [command, ...args] = this.config.cmd;
    return new StdioClientTransport({
      command,
      args: [...args, 'mcp'],
      cwd,
      env: this.config.env as Record<string, string>,
    });
  }

  // ── Tool / Resource calls ─────────────────────────────────────

  /**
   * Call an MCP tool and return its formatted text response.
   * Connects lazily if not already connected.
   *
   * Return format is always `'[GitNexus]\n' + text` — callers depend on this.
   */
  async callTool(name: string, args: Record<string, unknown>, cwd: string): Promise<string> {
    this.clearIdleTimer();
    try {
      await this.ensureConnected(cwd);
      if (!this.client) throw new Error('[GitNexus] MCP client is not connected.');

      const result = await this.client.callTool({ name, arguments: args });

      if (result.isError) {
        const text = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('\n');
        throw new Error(`[GitNexus] ${text || 'MCP tool reported an error.'}`);
      }

      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join('\n');

      if (!text) throw new Error('[GitNexus] MCP returned an empty response.');
      return '[GitNexus]\n' + text.slice(0, MAX_OUTPUT_CHARS);
    } finally {
      this.rearmIdleTimer();
    }
  }

  /**
   * Read an MCP resource by URI.
   * Returns the text content, or an empty string if the resource has no text.
   */
  async readResource(uri: string, cwd: string): Promise<string> {
    this.clearIdleTimer();
    try {
      await this.ensureConnected(cwd);
      if (!this.client) throw new Error('[GitNexus] MCP client is not connected.');

      const result = await this.client.readResource({ uri });
      const text = (result.contents as Array<{ uri: string; text?: string }>)
        .filter((c) => 'text' in c && c.text)
        .map((c) => c.text!)
        .join('\n');

      return text || '';
    } finally {
      this.rearmIdleTimer();
    }
  }

  // ── Cached capabilities ───────────────────────────────────────

  /** Get the list of tools the server reported at connection time. */
  getServerTools(): ServerTool[] {
    return this.serverToolsCache;
  }

  /** Get the list of resources the server reported at connection time. */
  getServerResources(): ServerResource[] {
    return this.serverResourcesCache;
  }

  /** Get the resource templates the server reported at connection time. */
  getServerResourceTemplates(): ServerResourceTemplate[] {
    return this.serverResourceTemplatesCache;
  }

  // ── Idle timer ────────────────────────────────────────────────

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private rearmIdleTimer(): void {
    this.clearIdleTimer();
    if (idleTimeoutMs <= 0) return; // 0 = disabled
    this.idleTimer = setTimeout(() => this.stop(), idleTimeoutMs);
  }

  /** Apply the current idleTimeoutMs to the running client, or clear any pending timer if no client. */
  refreshIdleTimer(): void {
    if (this.client) this.rearmIdleTimer();
    else this.clearIdleTimer();
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Disconnect and clean up. Called on idle timeout, session_start, and
   * session_shutdown. Now async (HTTP needs terminateSession + close), but
   * callers that fire-and-forget without await are fine — the returned
   * promise just goes unhandled.
   */
  async stop(): Promise<void> {
    this.clearIdleTimer();

    // Reject any in-progress connect attempt
    const rejectConnect = this.connectReject;
    this.connectPromise = null;
    this.connectReject = null;
    if (rejectConnect) {
      rejectConnect(new Error('[GitNexus] MCP client stopped'));
    }

    this.serverToolsCache = [];
    this.serverResourcesCache = [];
    this.serverResourceTemplatesCache = [];

    const transport = this.transport;
    this.client = null;
    this.transport = null;

    if (transport) {
      // For HTTP: terminateSession sends DELETE to clean up server-side session
      if ('terminateSession' in transport && typeof (transport as { terminateSession?: unknown }).terminateSession === 'function') {
        await (transport as { terminateSession(): Promise<void> }).terminateSession().catch(() => {});
      }
      await transport.close().catch(() => {});
    }
  }
}

export const mcpClient = new GitNexusMcpClient();
