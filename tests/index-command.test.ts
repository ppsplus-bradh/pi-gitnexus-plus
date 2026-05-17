import { beforeEach, describe, expect, it, vi } from 'vitest';

const callToolMock = vi.fn();
const stopMock = vi.fn();
const setConfigMock = vi.fn();
const readResourceMock = vi.fn();
const sendUserMessageMock = vi.fn();
const notifyMock = vi.fn();
const registerCommandMock = vi.fn();
const registerToolMock = vi.fn();
const registerFlagMock = vi.fn();
let transportTypeMock: 'stdio' | 'http' = 'stdio';

const healthMock = vi.fn();
const infoMock = vi.fn();
const listReposMock = vi.fn();
const analyzeMock = vi.fn();
const analyzeStatusMock = vi.fn();
const analyzeAndWaitMock = vi.fn();

let sessionHandlers: Record<string, Array<(event: any, ctx: any) => Promise<any> | void>> = {};
let onMock: ReturnType<typeof vi.fn>;
let getFlagMock: ReturnType<typeof vi.fn>;

vi.mock('../src/mcp-client', () => ({
  mcpClient: {
    callTool: callToolMock,
    stop: stopMock,
    setConfig: setConfigMock,
    readResource: readResourceMock,
    get transportType() { return transportTypeMock; },
  },
  setMcpIdleTimeout: vi.fn(),
}));

vi.mock('../src/tools', () => ({
  registerTools: vi.fn(),
}));

vi.mock('../src/ui/main-menu', () => ({
  openMainMenu: vi.fn(),
}));

vi.mock('../src/server-api', () => {
  return {
    GitNexusServerApi: class MockGitNexusServerApi {
      health = healthMock;
      info = infoMock;
      listRepos = listReposMock;
      analyze = analyzeMock;
      analyzeStatus = analyzeStatusMock;
      analyzeAndWait = analyzeAndWaitMock;
      static fromMcpUrl(_url: string, _token?: string) {
        return new MockGitNexusServerApi();
      }
    },
  };
});

const loadSavedConfigMock = vi.fn(() => ({}));

vi.mock('../src/gitnexus', async () => {
  const actual = await vi.importActual<typeof import('../src/gitnexus')>('../src/gitnexus');
  return {
    ...actual,
    findGitNexusRoot: vi.fn(() => '/repo-root'),
    findGitNexusIndex: vi.fn(() => true),
    loadSavedConfig: loadSavedConfigMock,
    runAugment: vi.fn(async () => null),
    resolveGitNexusCmd: vi.fn(() => ['gitnexus']),
    updateSpawnEnv: vi.fn(),
    setGitnexusCmd: vi.fn(),
    setAugmentTimeout: vi.fn(),
    clearIndexCache: vi.fn(),
    setHttpModeCallTool: vi.fn(),
    setHttpAnalyze: vi.fn(),
    spawnEnv: process.env,
    gitnexusCmd: ['gitnexus'],
  };
});

function createPi() {
  sessionHandlers = {};
  onMock = vi.fn((event: string, handler: any) => {
    if (!sessionHandlers[event]) sessionHandlers[event] = [];
    sessionHandlers[event].push(handler);
  });
  getFlagMock = vi.fn(() => '');
  return {
    registerTool: registerToolMock,
    registerCommand: registerCommandMock,
    registerFlag: registerFlagMock,
    on: onMock,
    getFlag: getFlagMock,
    sendUserMessage: sendUserMessageMock,
  };
}

async function fireSessionStart(ctx: any) {
  const handlers = sessionHandlers['session_start'] || [];
  for (const h of handlers) {
    await h({}, ctx);
  }
  // Allow microtasks (the handler calls void onSession which is async)
  await new Promise(r => setTimeout(r, 50));
}

describe('/gitnexus command error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    callToolMock.mockReset();
    stopMock.mockReset();
    setConfigMock.mockReset();
    sendUserMessageMock.mockReset();
    notifyMock.mockReset();
    registerCommandMock.mockReset();
    healthMock.mockReset();
    infoMock.mockReset();
    listReposMock.mockReset();
    analyzeAndWaitMock.mockReset();
    loadSavedConfigMock.mockReset();
    loadSavedConfigMock.mockReturnValue({});
    transportTypeMock = 'stdio';
  });

  it('catches MCP errors in slash commands and notifies the user', async () => {
    callToolMock.mockRejectedValue(new Error('[GitNexus] repo selection failed'));

    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const command = registerCommandMock.mock.calls[0][1];
    await command.handler('query auth', { cwd: '/outside/repo', ui: { notify: notifyMock } });

    expect(notifyMock).toHaveBeenCalledWith('[GitNexus] repo selection failed', 'error');
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });
});

describe('/gitnexus HTTP-mode commands', () => {
  beforeEach(() => {
    vi.resetModules();
    callToolMock.mockReset();
    stopMock.mockReset();
    setConfigMock.mockReset();
    sendUserMessageMock.mockReset();
    notifyMock.mockReset();
    registerCommandMock.mockReset();
    healthMock.mockReset();
    infoMock.mockReset();
    listReposMock.mockReset();
    analyzeAndWaitMock.mockReset();
    loadSavedConfigMock.mockReset();
    loadSavedConfigMock.mockReturnValue({});
    transportTypeMock = 'http';
  });

  it('/gitnexus status in HTTP mode calls serverApi.info() and serverApi.listRepos()', async () => {
    infoMock.mockResolvedValue({ version: '2.1.0', launchContext: 'docker', nodeVersion: '20.0.0' });
    listReposMock.mockResolvedValue([
      { name: 'my-repo', path: '/workspace/my-repo', stats: { nodes: 100, edges: 200, files: 10, communities: 5, processes: 3, embeddings: 50 } },
    ]);
    healthMock.mockResolvedValue(true);

    // Load config as HTTP mode
    loadSavedConfigMock.mockReturnValue({ mcpTransport: 'http', mcpServerUrl: 'http://localhost:4747/api/mcp' });

    const { default: register } = await import('../src/index');
    const pi = createPi();
    register(pi as any);

    // Fire session_start so that serverApi gets initialized
    await fireSessionStart({ cwd: '/repo-root', ui: { notify: vi.fn() } });

    // Now call the status command
    const command = registerCommandMock.mock.calls[0][1];
    await command.handler('status', { cwd: '/repo-root', ui: { notify: notifyMock } });

    expect(infoMock).toHaveBeenCalled();
    expect(listReposMock).toHaveBeenCalled();
    // Verify the notify output contains server version and repo name
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('v2.1.0'),
      'info',
    );
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('my-repo'),
      'info',
    );
  });

  it('/gitnexus analyze in HTTP mode calls serverApi.analyzeAndWait()', async () => {
    healthMock.mockResolvedValue(true);
    analyzeAndWaitMock.mockResolvedValue({ status: 'complete', progress: { phase: 'done', percent: 100, message: 'ok' } });
    stopMock.mockResolvedValue(undefined);

    loadSavedConfigMock.mockReturnValue({ mcpTransport: 'http', mcpServerUrl: 'http://localhost:4747/api/mcp' });

    const { default: register } = await import('../src/index');
    const pi = createPi();
    register(pi as any);

    // Initialize session so serverApi is set
    await fireSessionStart({ cwd: '/repo-root', ui: { notify: vi.fn() } });

    const command = registerCommandMock.mock.calls[0][1];
    await command.handler('analyze', { cwd: '/repo-root', ui: { notify: notifyMock } });

    expect(analyzeAndWaitMock).toHaveBeenCalled();
    // Verify it was called with the correct target path (defaults to /workspace/<basename>)
    const callArgs = analyzeAndWaitMock.mock.calls[0][0];
    expect(callArgs).toEqual({ path: '/workspace/repo-root' });
    // Verify completion notification
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('analysis complete'),
      'info',
    );
  });

  it('gitnexus-server flag overrides config to HTTP mode', async () => {
    healthMock.mockResolvedValue(true);
    loadSavedConfigMock.mockReturnValue({});

    const { default: register } = await import('../src/index');
    const pi = createPi();
    // Set up getFlag to return a server URL for 'gitnexus-server'
    getFlagMock = vi.fn((name: string) => {
      if (name === 'gitnexus-server') return 'http://myserver:4747/api/mcp';
      return '';
    });
    (pi as any).getFlag = getFlagMock;
    register(pi as any);

    const sessionNotify = vi.fn();
    await fireSessionStart({ cwd: '/repo-root', ui: { notify: sessionNotify } });

    // Verify setConfig was called with HTTP transport
    expect(setConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'http',
        url: 'http://myserver:4747/api/mcp',
      }),
    );
    // Verify health check was performed
    expect(healthMock).toHaveBeenCalled();
    // Verify connected notification
    expect(sessionNotify).toHaveBeenCalledWith(
      expect.stringContaining('connected to server'),
      'info',
    );
  });
});
