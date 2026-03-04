import { describe, it, expect } from 'vitest';
import { PlumbPlugin, DEFAULT_CONFIG, PlumbMcpClient } from './index.js';

describe('PlumbPlugin', () => {
  it('exports PlumbPlugin class', () => {
    expect(PlumbPlugin).toBeDefined();
    expect(typeof PlumbPlugin).toBe('function');
  });

  it('applies default config when no overrides given', () => {
    const plugin = new PlumbPlugin();
    expect(plugin.config).toEqual(DEFAULT_CONFIG);
    expect(plugin.config.mcpServerPath).toBe('plumb-mcp');
    expect(plugin.config.userId).toBe('default');
    expect(plugin.config.enabled).toBe(true);
  });

  it('merges partial config with defaults', () => {
    const plugin = new PlumbPlugin({ userId: 'alice', enabled: false });
    expect(plugin.config.mcpServerPath).toBe('plumb-mcp');
    expect(plugin.config.userId).toBe('alice');
    expect(plugin.config.enabled).toBe(false);
  });

  it('client is null before start()', () => {
    const plugin = new PlumbPlugin();
    expect(plugin.client).toBeNull();
  });

  it('start() is a no-op when disabled', async () => {
    const plugin = new PlumbPlugin({ enabled: false });
    await plugin.start();
    expect(plugin.client).toBeNull();
  });

  it('stop() is safe to call when not started', async () => {
    const plugin = new PlumbPlugin();
    await plugin.stop(); // should not throw
    expect(plugin.client).toBeNull();
  });
});

describe('PlumbMcpClient', () => {
  it('exports PlumbMcpClient class', () => {
    expect(PlumbMcpClient).toBeDefined();
    expect(typeof PlumbMcpClient).toBe('function');
  });

  it('can be constructed with a server path', () => {
    const client = new PlumbMcpClient('/usr/bin/plumb-mcp');
    expect(client.connected).toBe(false);
  });
});
