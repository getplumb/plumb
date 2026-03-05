import { resolveAnthropicKey } from '@plumb/core';

async function main() {
  try {
    const apiKey = await resolveAnthropicKey();
    console.log(`✓ API key resolved: ${apiKey.substring(0, 15)}...`);
    process.exit(0);
  } catch (error) {
    console.error('✗ Failed to resolve Anthropic API key:', error);
    process.exit(1);
  }
}

main();
