/**
 * REST client for non-MCP endpoints on the GitNexus HTTP server.
 *
 * Used in HTTP transport mode to manage server info, repos, and analysis jobs.
 * Uses built-in fetch() (Node 20+). No additional dependencies.
 */

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
  status: 'analyzing' | 'cloning';
}

export interface AnalyzeJobStatus {
  id: string;
  status: 'analyzing' | 'cloning' | 'complete' | 'failed';
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

export class GitNexusServerApi {
  private readonly baseUrl: string;
  private readonly authToken?: string;

  constructor(baseUrl: string, authToken?: string) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authToken = authToken;
  }

  /**
   * Construct a GitNexusServerApi from an MCP endpoint URL.
   * Derives the base URL by stripping the MCP path suffix (e.g. `/api/mcp`).
   *
   * Example: `http://localhost:4747/api/mcp` → base `http://localhost:4747`
   */
  static fromMcpUrl(mcpUrl: string, authToken?: string): GitNexusServerApi {
    const url = new URL(mcpUrl);
    // Remove known MCP path suffixes
    const path = url.pathname.replace(/\/api\/mcp\/?$/, '').replace(/\/mcp\/?$/, '');
    url.pathname = path || '/';
    // Reconstruct base URL without trailing slash
    const base = url.origin + (url.pathname === '/' ? '' : url.pathname);
    return new GitNexusServerApi(base, authToken);
  }

  // ── Private helpers ───────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      h.Authorization = `Bearer ${this.authToken}`;
    }
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`GitNexus API GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GitNexus API POST ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  // ── Public API ────────────────────────────────────────────────

  /** Check if the server is reachable. Returns true on 2xx, false on any error. */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        method: 'GET',
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Get server version and runtime info. */
  async info(): Promise<ServerInfo> {
    return this.get<ServerInfo>('/api/info');
  }

  /** List all indexed repositories on the server. */
  async listRepos(): Promise<RepoInfo[]> {
    return this.get<RepoInfo[]>('/api/repos');
  }

  /**
   * Start an analyze job on the server.
   * Provide one of: `path` (server-local path), `url` (git clone URL), or `name` (repo name).
   */
  async analyze(target: { path?: string; url?: string; name?: string }): Promise<AnalyzeJob> {
    return this.post<AnalyzeJob>('/api/analyze', target);
  }

  /** Get the status of an in-progress or completed analyze job. */
  async analyzeStatus(jobId: string): Promise<AnalyzeJobStatus> {
    return this.get<AnalyzeJobStatus>(`/api/analyze/${encodeURIComponent(jobId)}`);
  }

  /**
   * Start an analyze job and poll until it completes or fails.
   *
   * @param target - Analysis target (path, url, or name)
   * @param onProgress - Optional callback invoked on each poll with the current job status
   * @param pollIntervalMs - Polling interval in milliseconds (default: 2000)
   * @returns The final job status (status === 'complete' or 'failed')
   */
  async analyzeAndWait(
    target: { path?: string; url?: string; name?: string },
    onProgress?: (status: AnalyzeJobStatus) => void,
    pollIntervalMs = 2000,
  ): Promise<AnalyzeJobStatus> {
    const job = await this.analyze(target);

    // Poll until terminal state
    while (true) {
      const status = await this.analyzeStatus(job.jobId);

      if (onProgress) {
        onProgress(status);
      }

      if (status.status === 'complete' || status.status === 'failed') {
        return status;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
