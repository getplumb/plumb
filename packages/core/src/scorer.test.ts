/**
 * scorer.test.ts — decay curve verification for computeDecay() and scoreMemoryFact().
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeDecay, scoreMemoryFact, MEMORY_FACT_BOOST } from './scorer.js';

describe('computeDecay', () => {
  it('returns 1.0 at age 0', () => {
    assert.equal(computeDecay(0.012, 0), 1.0);
  });

  it('decays correctly at 30 days (medium lambda=0.012)', () => {
    const result = computeDecay(0.012, 30);
    assert.ok(result > 0.6 && result < 0.7, `expected ~0.698, got ${result}`);
  });

  it('decays correctly at 90 days (medium lambda=0.012)', () => {
    const result = computeDecay(0.012, 90);
    assert.ok(result > 0.33 && result < 0.35, `expected ~0.339, got ${result}`);
  });

  it('fast lambda decays faster than medium', () => {
    const medium = computeDecay(0.012, 30);
    const fast = computeDecay(0.05, 30);
    assert.ok(fast < medium, 'fast decay should be lower than medium at same age');
  });

  it('slow lambda decays slower than medium', () => {
    const medium = computeDecay(0.012, 90);
    const slow = computeDecay(0.003, 90);
    assert.ok(slow > medium, 'slow decay should be higher than medium at same age');
  });
});

describe('scoreMemoryFact', () => {
  it('applies MEMORY_FACT_BOOST multiplier', () => {
    const hybridScore = 0.5;
    const result = scoreMemoryFact(hybridScore);
    assert.equal(result, hybridScore * MEMORY_FACT_BOOST);
  });

  it('boosts a low score correctly', () => {
    assert.equal(scoreMemoryFact(0.1), 0.1 * MEMORY_FACT_BOOST);
  });

  it('boosts a high score correctly', () => {
    assert.equal(scoreMemoryFact(0.9), 0.9 * MEMORY_FACT_BOOST);
  });
});
