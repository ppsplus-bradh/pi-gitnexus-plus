import { beforeEach, describe, expect, it, vi } from 'vitest';

const callToolMock = vi.fn(async () => '[GitNexus]\nok');
const readResourceMock = vi.fn(async () => 'resource content');
let transportTypeMock: 'stdio' | 'http' = 'stdio';

vi.mock('../src/mcp-client', () => ({
  mcpClient: {
    callTool: callToolMock,
    readResource: readResourceMock,
    get transportType() { return transportTypeMock; },
  },
}));

const findGitNexusIndexMock = vi.fn(() => true);
const findGitNexusRootMock = vi.fn(() => '/repo-root');
const safeResolvePathMock = vi.fn((file: string, cwd: string) => `${cwd}/${file}`);
const toRepoRelativePathMock = vi.fn((file: string, repoRoot: string) => `${repoRoot}::${file}`);
const expandUserPathMock = vi.fn((path: string) => (path === '~/other-repo' ? '/Users/test/other-repo' : path));
const validateRepoRelativePathMock = vi.fn((path: string) => (path.includes('..') ? null : path));

vi.mock('../src/gitnexus', () => ({
  expandUserPath: expandUserPathMock,
  findGitNexusIndex: findGitNexusIndexMock,
  findGitNexusRoot: findGitNexusRootMock,
  normalizePathArg: (path: string) => (path.startsWith('@') ? path.slice(1) : path),
  safeResolvePath: safeResolvePathMock,
  toRepoRelativePath: toRepoRelativePathMock,
  validateRepoRelativePath: validateRepoRelativePathMock,
}));

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function createPiMock(): { tools: RegisteredTool[]; registerTool: (tool: RegisteredTool) => void } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };
}

describe('registerTools', () => {
  beforeEach(() => {
    callToolMock.mockClear();
    readResourceMock.mockClear();
    transportTypeMock = 'stdio';
    findGitNexusIndexMock.mockClear();
    findGitNexusRootMock.mockClear();
    expandUserPathMock.mockClear();
    safeResolvePathMock.mockClear();
    toRepoRelativePathMock.mockClear();
    validateRepoRelativePathMock.mockClear();
    findGitNexusIndexMock.mockReturnValue(true);
    findGitNexusRootMock.mockReturnValue('/repo-root');
    expandUserPathMock.mockImplementation((path: string) => (path === '~/other-repo' ? '/Users/test/other-repo' : path));
    safeResolvePathMock.mockImplementation((file: string, cwd: string) => `${cwd}/${file}`);
    toRepoRelativePathMock.mockImplementation((file: string, repoRoot: string) => `${repoRoot}::${file}`);
    validateRepoRelativePathMock.mockImplementation((path: string) => (path.includes('..') ? null : path));
  });

  it('registers the current GitNexus MCP tool set', async () => {
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();

    registerTools(pi as any);

    expect(pi.tools.map((tool) => tool.name)).toEqual([
      'gitnexus_list_repos',
      'gitnexus_query',
      'gitnexus_context',
      'gitnexus_impact',
      'gitnexus_detect_changes',
      'gitnexus_rename',
      'gitnexus_cypher',
      'gitnexus_route_map',
      'gitnexus_tool_map',
      'gitnexus_shape_check',
      'gitnexus_api_impact',
      'gitnexus_group_list',
      'gitnexus_group_sync',
      'gitnexus_read_resource',
    ]);
  });

  it('injects repo and normalizes context arguments', async () => {
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const contextTool = pi.tools.find((tool) => tool.name === 'gitnexus_context');
    expect(contextTool).toBeDefined();

    await contextTool!.execute('id', { name: 'AuthService', file: 'src/auth.ts' }, undefined, undefined, { cwd: '/repo-root/app' });

    expect(toRepoRelativePathMock).toHaveBeenCalledWith('src/auth.ts', '/repo-root');
    expect(callToolMock).toHaveBeenCalledWith(
      'context',
      {
        name: 'AuthService',
        file_path: '/repo-root::src/auth.ts',
        repo: '/repo-root',
      },
      '/repo-root/app',
    );
  });

  it('resolves repo-relative file paths against an explicit repo path override', async () => {
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const contextTool = pi.tools.find((tool) => tool.name === 'gitnexus_context');
    const renameTool = pi.tools.find((tool) => tool.name === 'gitnexus_rename');

    await contextTool!.execute(
      'id',
      { name: 'AuthService', file_path: 'src/auth.ts', repo: '~/other-repo' },
      undefined,
      undefined,
      { cwd: '/repo-root/app' },
    );
    await renameTool!.execute(
      'id',
      { symbol_name: 'AuthService', new_name: 'AccountService', file_path: 'src/auth.ts', repo: '~/other-repo' },
      undefined,
      undefined,
      { cwd: '/repo-root/app' },
    );

    expect(expandUserPathMock).toHaveBeenNthCalledWith(1, '~/other-repo');
    expect(expandUserPathMock).toHaveBeenNthCalledWith(2, '~/other-repo');
    expect(toRepoRelativePathMock).toHaveBeenNthCalledWith(1, 'src/auth.ts', '/Users/test/other-repo');
    expect(toRepoRelativePathMock).toHaveBeenNthCalledWith(2, 'src/auth.ts', '/Users/test/other-repo');
    expect(callToolMock).toHaveBeenNthCalledWith(
      1,
      'context',
      {
        name: 'AuthService',
        file_path: '/Users/test/other-repo::src/auth.ts',
        repo: '/Users/test/other-repo',
      },
      '/repo-root/app',
    );
    expect(callToolMock).toHaveBeenNthCalledWith(
      2,
      'rename',
      {
        symbol_name: 'AuthService',
        new_name: 'AccountService',
        file_path: '/Users/test/other-repo::src/auth.ts',
        repo: '/Users/test/other-repo',
      },
      '/repo-root/app',
    );
  });

  it('passes repo-relative file paths through unchanged for named repo overrides', async () => {
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const contextTool = pi.tools.find((tool) => tool.name === 'gitnexus_context');
    await contextTool!.execute(
      'id',
      { name: 'AuthService', file_path: '@src/auth.ts', repo: 'pi-ult' },
      undefined,
      undefined,
      { cwd: '/repo-root/app' },
    );

    expect(safeResolvePathMock).not.toHaveBeenCalled();
    expect(toRepoRelativePathMock).not.toHaveBeenCalled();
    expect(validateRepoRelativePathMock).toHaveBeenCalledWith('src/auth.ts');
    expect(callToolMock).toHaveBeenCalledWith(
      'context',
      {
        name: 'AuthService',
        file_path: 'src/auth.ts',
        repo: 'pi-ult',
      },
      '/repo-root/app',
    );
  });

  it('rejects invalid repo-relative paths before calling MCP', async () => {
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const renameTool = pi.tools.find((tool) => tool.name === 'gitnexus_rename');
    await expect(renameTool!.execute(
      'id',
      { symbol_name: 'AuthService', new_name: 'AccountService', file_path: '@/../../etc/passwd', repo: 'pi-ult' },
      undefined,
      undefined,
      { cwd: '/repo-root/app' },
    )).rejects.toThrow('Invalid file path.');
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('allows explicit repo overrides even when cwd has no local gitnexus index', async () => {
    findGitNexusIndexMock.mockReturnValue(false);
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const impactTool = pi.tools.find((tool) => tool.name === 'gitnexus_impact');
    const result = await impactTool!.execute(
      'id',
      { target: 'AuthService', repo: 'pi-ult' },
      undefined,
      undefined,
      { cwd: '/outside/repo' },
    );

    expect(callToolMock).toHaveBeenCalledWith(
      'impact',
      {
        target: 'AuthService',
        repo: 'pi-ult',
      },
      '/outside/repo',
    );
    expect(result.content[0].text).toBe('[GitNexus]\nok');
  });

  it('normalizes impact and detect_changes arguments to the current MCP schema', async () => {
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const impactTool = pi.tools.find((tool) => tool.name === 'gitnexus_impact');
    const detectChangesTool = pi.tools.find((tool) => tool.name === 'gitnexus_detect_changes');

    await impactTool!.execute(
      'id',
      { target: 'AuthService', direction: 'upstream', depth: 4, include_tests: true },
      undefined,
      undefined,
      { cwd: '/repo-root/app' },
    );
    await detectChangesTool!.execute(
      'id',
      { scope: 'compare', base_ref: 'main' },
      undefined,
      undefined,
      { cwd: '/repo-root/app' },
    );

    expect(callToolMock).toHaveBeenNthCalledWith(
      1,
      'impact',
      {
        target: 'AuthService',
        direction: 'upstream',
        maxDepth: 4,
        includeTests: true,
        repo: '/repo-root',
      },
      '/repo-root/app',
    );
    expect(callToolMock).toHaveBeenNthCalledWith(
      2,
      'detect_changes',
      {
        scope: 'compare',
        base_ref: 'main',
        repo: '/repo-root',
      },
      '/repo-root/app',
    );
  });

  it('shouldAllowQuery returns true in HTTP mode even without local index', async () => {
    findGitNexusIndexMock.mockReturnValue(false);
    transportTypeMock = 'http';
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const queryTool = pi.tools.find((tool) => tool.name === 'gitnexus_query');
    await queryTool!.execute('id', { query: 'test' }, undefined, undefined, { cwd: '/some/dir' });

    expect(callToolMock).toHaveBeenCalledWith('query', { query: 'test' }, '/some/dir');
  });

  it('buildRepoArgs skips local root resolution in HTTP mode', async () => {
    transportTypeMock = 'http';
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const queryTool = pi.tools.find((tool) => tool.name === 'gitnexus_query');
    await queryTool!.execute('id', { query: 'test' }, undefined, undefined, { cwd: '/some/dir' });

    expect(findGitNexusRootMock).not.toHaveBeenCalled();
    expect(callToolMock).toHaveBeenCalledWith('query', { query: 'test' }, '/some/dir');
  });

  it('gitnexus_read_resource calls readResource with correct URI', async () => {
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const resourceTool = pi.tools.find((tool) => tool.name === 'gitnexus_read_resource');
    expect(resourceTool).toBeDefined();

    const result = await resourceTool!.execute('id', { uri: 'gitnexus://repos' }, undefined, undefined, { cwd: '/some/dir' });

    expect(readResourceMock).toHaveBeenCalledWith('gitnexus://repos', '/some/dir');
    expect(result.content[0].text).toBe('resource content');
  });

  it('gitnexus_group_sync passes name parameter correctly', async () => {
    const { registerTools } = await import('../src/tools');
    const pi = createPiMock();
    registerTools(pi as any);

    const syncTool = pi.tools.find((tool) => tool.name === 'gitnexus_group_sync');
    expect(syncTool).toBeDefined();

    await syncTool!.execute('id', { name: 'my-group' }, undefined, undefined, { cwd: '/some/dir' });

    expect(callToolMock).toHaveBeenCalledWith('group_sync', { name: 'my-group' }, '/some/dir');
  });
});
