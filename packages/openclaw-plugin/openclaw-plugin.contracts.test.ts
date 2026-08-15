import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG } from '@getplumb/core';

function readManifest(): any {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(resolve(here, 'openclaw.plugin.json'), 'utf8'));
}

describe('OpenClaw plugin manifest contracts', () => {
  it('declares every Plumb agent tool registered by the plugin', () => {
    const manifest = readManifest() as {
      contracts?: { tools?: string[] };
    };

    expect(manifest.contracts?.tools).toEqual([
      'plumb_remember',
      'plumb_search',
      'plumb_wiki_read',
      'plumb_wiki_search',
      'plumb_wiki_list',
      'plumb_wiki_links',
      'plumb_wiki_queue_edit',
    ]);
  });

  it('keeps contextual retrieval manifest defaults in sync with core defaults', () => {
    const manifest = readManifest();
    const defaults = manifest.configSchema.properties.contextualRetrieval.properties;

    expect(defaults.mode.default).toEqual(DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG.mode);
    expect(defaults.model.default).toEqual(DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG.model);
    expect(defaults.parentTokenBudgets.default).toEqual(DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG.parentTokenBudgets);
    expect(defaults.maxParentTokens.default).toEqual(DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG.maxParentTokens);
  });
});
