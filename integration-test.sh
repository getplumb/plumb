#!/usr/bin/env bash
#
# Integration test runner for Plumb local MVP.
#
# Sets required environment variables and runs the TypeScript integration test.
# Prints PASS/FAIL summary on completion.
#
# Usage: bash plumb/integration-test.sh

set -euo pipefail

# Change to workspace root
cd "$(dirname "$0")"

# Ensure ANTHROPIC_API_KEY is available (required for fact extraction)
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "⚠️  ANTHROPIC_API_KEY not set — fact extraction test will be skipped"
fi

# Run the integration test
echo "Running Plumb local MVP integration tests..."
echo ""

npx tsx integration-test.ts

# Exit code is propagated from the TypeScript script
