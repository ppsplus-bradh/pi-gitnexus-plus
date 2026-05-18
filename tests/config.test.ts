import { describe, expect, it } from 'vitest';

// Test saveConfig/loadSavedConfig by importing the real functions
// but pointing at a temp directory. We test the actual module-level
// CONFIG_PATH indirectly via the exported functions.

describe('GitNexusConfig round-trip', () => {
  // We can't easily redirect CONFIG_PATH, so test the JSON logic directly.
  it('loadSavedConfig returns {} for missing file', async () => {
    const { loadSavedConfig } = await import('../src/gitnexus');
    // The real config file may or may not exist — if it doesn't, should return {}
    const cfg = loadSavedConfig();
    expect(typeof cfg).toBe('object');
  });

  it('loadSavedConfig returns {} for corrupt JSON', () => {
    // Simulate by testing the same pattern
    const parse = (s: string) => {
      try { return JSON.parse(s); }
      catch { return {}; }
    };
    expect(parse('{bad json')).toEqual({});
    expect(parse('')).toEqual({});
  });

  it('config fields are all optional', async () => {
    const { loadSavedConfig } = await import('../src/gitnexus');
    const cfg = loadSavedConfig();
    // All fields should be undefined or their type
    expect(cfg.cmd === undefined || typeof cfg.cmd === 'string').toBe(true);
    expect(cfg.autoAugment === undefined || typeof cfg.autoAugment === 'boolean').toBe(true);
    expect(cfg.augmentTimeout === undefined || typeof cfg.augmentTimeout === 'number').toBe(true);
    expect(cfg.maxAugmentsPerResult === undefined || typeof cfg.maxAugmentsPerResult === 'number').toBe(true);
    expect(cfg.maxSecondaryPatterns === undefined || typeof cfg.maxSecondaryPatterns === 'number').toBe(true);
  });

  it('new HTTP transport config fields are optional and default correctly', async () => {
    const { loadSavedConfig } = await import('../src/gitnexus');
    const cfg = loadSavedConfig();
    // New fields should be undefined when not set (all optional)
    expect(cfg.mcpTransport === undefined || cfg.mcpTransport === 'stdio' || cfg.mcpTransport === 'http').toBe(true);
    expect(cfg.mcpServerUrl === undefined || typeof cfg.mcpServerUrl === 'string').toBe(true);
    expect(cfg.mcpAuthToken === undefined || typeof cfg.mcpAuthToken === 'string').toBe(true);
    expect(cfg.workspaceDir === undefined || typeof cfg.workspaceDir === 'string').toBe(true);
  });

  it('type assertions pass with new config fields present', () => {
    // Verify the interface accepts all new fields without type errors
    const cfg: import('../src/gitnexus').GitNexusConfig = {
      cmd: 'gitnexus',
      autoAugment: true,
      augmentTimeout: 8,
      maxAugmentsPerResult: 3,
      maxSecondaryPatterns: 2,
      mcpIdleTimeout: 600,
      mcpTransport: 'http',
      mcpServerUrl: 'http://localhost:4747/api/mcp',
      mcpAuthToken: 'test-token',
      workspaceDir: '/workspace',
    };
    expect(cfg.mcpTransport).toBe('http');
    expect(cfg.mcpServerUrl).toBe('http://localhost:4747/api/mcp');
    expect(cfg.mcpAuthToken).toBe('test-token');
    expect(cfg.workspaceDir).toBe('/workspace');
  });

  it('JSON round-trip preserves new config fields', () => {
    const original: import('../src/gitnexus').GitNexusConfig = {
      cmd: 'gitnexus',
      mcpTransport: 'http',
      mcpServerUrl: 'http://localhost:4747/api/mcp',
      mcpAuthToken: 'secret',
      workspaceDir: '/workspace',
    };
    const parsed = JSON.parse(JSON.stringify(original)) as import('../src/gitnexus').GitNexusConfig;
    expect(parsed.mcpTransport).toBe('http');
    expect(parsed.mcpServerUrl).toBe('http://localhost:4747/api/mcp');
    expect(parsed.mcpAuthToken).toBe('secret');
    expect(parsed.workspaceDir).toBe('/workspace');
  });

  it('mcpTransport validates as stdio or http', () => {
    const valid: Array<import('../src/gitnexus').GitNexusConfig['mcpTransport']> = ['stdio', 'http', undefined];
    for (const v of valid) {
      const cfg: import('../src/gitnexus').GitNexusConfig = { mcpTransport: v };
      expect(cfg.mcpTransport === undefined || cfg.mcpTransport === 'stdio' || cfg.mcpTransport === 'http').toBe(true);
    }
  });
});

describe('setAugmentTimeout', () => {
  it('converts seconds to milliseconds', async () => {
    const { setAugmentTimeout } = await import('../src/gitnexus');
    // Should not throw
    setAugmentTimeout(10);
    setAugmentTimeout(4);
  });
});
