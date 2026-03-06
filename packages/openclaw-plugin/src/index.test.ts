import { describe, it, expect } from 'vitest';
import pluginDefault, { plugin, createPostExchangeHook } from './index.js';

describe('plugin exports', () => {
  it('exports plugin object', () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin).toBe('object');
    expect(plugin.id).toBe('plumb');
    expect(plugin.name).toBe('Plumb Memory');
    expect(plugin.kind).toBe('memory');
  });

  it('exports default plugin', () => {
    expect(pluginDefault).toBeDefined();
    expect(pluginDefault).toBe(plugin);
  });

  it('exports createPostExchangeHook function', () => {
    expect(createPostExchangeHook).toBeDefined();
    expect(typeof createPostExchangeHook).toBe('function');
  });

  it('plugin has activate method', () => {
    expect(plugin.activate).toBeDefined();
    expect(typeof plugin.activate).toBe('function');
  });
});
