import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── SDK mocks ───────────────────────────────────────────────────

const connectMock = vi.fn();
const callToolMock = vi.fn();
const listToolsMock = vi.fn();
const listResourcesMock = vi.fn();
const listResourceTemplatesMock = vi.fn();
const readResourceMock = vi.fn();
const clientCloseMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: class MockClient {
      connect = connectMock;
      callTool = callToolMock;
      listTools = listToolsMock;
      listResources = listResourcesMock;
      listResourceTemplates = listResourceTemplatesMock;
      readResource = readResourceMock;
      close = clientCloseMock;
    },
  };
});

const transportCloseMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: class MockStdioTransport {
      close = transportCloseMock;
    },
  };
});

const httpTransportCloseMock = vi.fn();
const httpTerminateSessionMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: class MockHTTPTransport {
      close = httpTransportCloseMock;
      terminateSession = httpTerminateSessionMock;
    },
  };
});

vi.mock('../src/gitnexus', () => ({
  MAX_OUTPUT_CHARS: 8 * 1024,
  spawnEnv: process.env,
  gitnexusCmd: ['gitnexus'],
}));

describe('mcp-client (SDK-based)', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default: connect succeeds, list* return empty arrays
    connectMock.mockResolvedValue(undefined);
    listToolsMock.mockResolvedValue({ tools: [] });
    listResourcesMock.mockResolvedValue({ resources: [] });
    listResourceTemplatesMock.mockResolvedValue({ resourceTemplates: [] });
    transportCloseMock.mockResolvedValue(undefined);
    httpTransportCloseMock.mockResolvedValue(undefined);
    httpTerminateSessionMock.mockResolvedValue(undefined);

    vi.resetModules();
  });

  it('throws [GitNexus] error when tool response has isError: true', async () => {
    callToolMock.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'repo selection failed' }],
    });

    const { mcpClient } = await import('../src/mcp-client');

    await expect(
      mcpClient.callTool('query', { query: 'auth' }, '/repo'),
    ).rejects.toThrow('[GitNexus] repo selection failed');
  });

  it('calls transport.close() after idle timeout expires', async () => {
    vi.useFakeTimers();
    try {
      callToolMock.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });

      const { mcpClient, setMcpIdleTimeout } = await import('../src/mcp-client');
      setMcpIdleTimeout(60);

      await expect(
        mcpClient.callTool('query', { query: 'auth' }, '/repo'),
      ).resolves.toContain('ok');

      expect(transportCloseMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(59_000);
      expect(transportCloseMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(transportCloseMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects pending calls when stop() is called mid-connect', async () => {
    // Make connect hang forever so we can stop() mid-handshake
    connectMock.mockReturnValue(new Promise(() => {}));

    const { mcpClient } = await import('../src/mcp-client');

    const pending = mcpClient.callTool('query', { query: 'auth' }, '/repo');

    // stop() nulls out connectPromise and closes transport
    await mcpClient.stop();

    // The callTool should fail because client is null after stop()
    await expect(pending).rejects.toThrow();
  });

  it('readResource() returns text content from resource', async () => {
    readResourceMock.mockResolvedValue({
      contents: [
        { uri: 'gitnexus://repos', text: 'repo1\nrepo2' },
      ],
    });

    const { mcpClient } = await import('../src/mcp-client');

    const result = await mcpClient.readResource('gitnexus://repos', '/repo');
    expect(result).toBe('repo1\nrepo2');
    expect(readResourceMock).toHaveBeenCalledWith({ uri: 'gitnexus://repos' });
  });

  it('callTool() truncates output to MAX_OUTPUT_CHARS', async () => {
    // MAX_OUTPUT_CHARS is mocked as 8 * 1024 = 8192
    const longText = 'x'.repeat(10_000);
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: longText }],
    });

    const { mcpClient } = await import('../src/mcp-client');

    const result = await mcpClient.callTool('query', { query: 'test' }, '/repo');

    // '[GitNexus]\n' prefix + truncated text
    expect(result).toBe('[GitNexus]\n' + 'x'.repeat(8192));
    expect(result.length).toBe('[GitNexus]\n'.length + 8192);
  });
});
