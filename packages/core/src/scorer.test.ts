/**
 * scorer.test.ts — decay curve verification for scoreFact() and scoreRawLog().
 *
 * Note on the "~0.31 at 49 days medium" reference in the architecture doc:
 * With lambda=0.012 the correct value at 49 days is ~0.528 (confidence=0.95).
 * The ~0.31 figure likely derives from an earlier lambda value (~0.023).
 * These tests assert against the actual computed values for the specified lambdas.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DecayRate } from './types.js';
import { computeDecay, scoreFact, scoreRawLog } from './scorer.js';

/** Build a minimal Fact for testing. */
function makeFact(opts: {
  confidence: number;
  decayRate: DecayRate;
  ageInDays: number;
  now?: Date;
}): { fact: Parameters<typeof scoreFact>[0]; now: Date } {
  const now = opts.now ?? new Date('2026-01-01T00:00:00.000Z');
  const timestamp = new Date(
    now.getTime() - opts.ageInDays * 24 * 60 * 60 * 1_000,
  );
  return {
    fact: {
      id: 'test-id',
      subject: 'test subject',
      predicate: 'test predicate',
      object: 'test object',
      confidence: opts.confidence,
      decayRate: opts.decayRate,
      timestamp,
      sourceSessionId: 'session-1',
    },
    now,
  };
}

describe('computeDecay', () => {
  it('returns 1.0 at age 0 regardless of lambda', () => {
    assert.equal(computeDecay(0.003, 0), 1.0);
    assert.equal(computeDecay(0.012, 0), 1.0);
    assert.equal(computeDecay(0.05, 0), 1.0);
  });

  it('medium lambda at 49 days matches expected decay', () => {
    const decay = computeDecay(0.012, 49);
    // e^(-0.012 * 49) = e^(-0.588) ≈ 0.5557
    assert.ok(decay > 0.55 && decay < 0.57, `expected ~0.5557, got ${decay}`);
  });

  it('fast lambda decays faster than slow at same age', () => {
    assert.ok(computeDecay(0.05, 30) < computeDecay(0.003, 30));
  });
});

describe('scoreFact — decay curves', () => {
  it('age=0, slow decay, confidence=0.95 → ~0.95', () => {
    const { fact, now } = makeFact({
      confidence: 0.95,
      decayRate: DecayRate.slow,
      ageInDays: 0,
    });
    const result = scoreFact(fact, now);
    assert.ok(
      result.score > 0.949 && result.score <= 0.95,
      `expected ~0.95, got ${result.score}`,
    );
    assert.equal(result.isCold, false);
  });

  it('age=49 days, medium decay, confidence=0.95 → ~0.528', () => {
    const { fact, now } = makeFact({
      confidence: 0.95,
      decayRate: DecayRate.medium,
      ageInDays: 49,
    });
    const result = scoreFact(fact, now);
    // 0.95 × e^(-0.012 × 49) ≈ 0.5277
    assert.ok(
      result.score > 0.52 && result.score < 0.54,
      `expected ~0.528, got ${result.score}`,
    );
    assert.equal(result.isCold, false);
  });

  it('age=365 days, medium decay, confidence=0.95 → ~0.012 (near cold)', () => {
    const { fact, now } = makeFact({
      confidence: 0.95,
      decayRate: DecayRate.medium,
      ageInDays: 365,
    });
    const result = scoreFact(fact, now);
    // 0.95 × e^(-0.012 × 365) ≈ 0.01190
    assert.ok(
      result.score > 0.01 && result.score < 0.02,
      `expected ~0.012, got ${result.score}`,
    );
    assert.equal(result.isCold, false);
  });

  it('age=400 days, medium decay, confidence=0.95 → isCold (score < 0.01)', () => {
    const { fact, now } = makeFact({
      confidence: 0.95,
      decayRate: DecayRate.medium,
      ageInDays: 400,
    });
    const result = scoreFact(fact, now);
    // 0.95 × e^(-0.012 × 400) ≈ 0.00782
    assert.ok(result.score < 0.01, `expected score < 0.01, got ${result.score}`);
    assert.equal(result.isCold, true);
  });

  it('age=30 days, fast decay, confidence=0.95 → < 0.25', () => {
    const { fact, now } = makeFact({
      confidence: 0.95,
      decayRate: DecayRate.fast,
      ageInDays: 30,
    });
    const result = scoreFact(fact, now);
    // 0.95 × e^(-0.05 × 30) ≈ 0.2120
    assert.ok(result.score < 0.25, `expected < 0.25, got ${result.score}`);
    assert.equal(result.isCold, false);
  });

  it('confidence=0 → score=0, isCold=true', () => {
    const { fact, now } = makeFact({
      confidence: 0,
      decayRate: DecayRate.medium,
      ageInDays: 49,
    });
    const result = scoreFact(fact, now);
    assert.equal(result.score, 0);
    assert.equal(result.isCold, true);
  });

  it('score is bounded between 0 and 1', () => {
    const ages = [0, 1, 30, 100, 365, 730];
    const rates = [DecayRate.slow, DecayRate.medium, DecayRate.fast];
    for (const ageInDays of ages) {
      for (const decayRate of rates) {
        const { fact, now } = makeFact({ confidence: 0.95, decayRate, ageInDays });
        const { score } = scoreFact(fact, now);
        assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
      }
    }
  });

  it('uses current time when now is omitted (smoke test)', () => {
    const fact = {
      id: 'x',
      subject: 's',
      predicate: 'p',
      object: 'o',
      confidence: 0.8,
      decayRate: DecayRate.slow,
      timestamp: new Date(),
      sourceSessionId: 'sess',
    };
    // Should not throw; score should be close to 0.8 for age≈0
    const { score } = scoreFact(fact);
    assert.ok(score > 0.79 && score <= 0.8, `expected ~0.8, got ${score}`);
  });
});

describe('scoreRawLog — medium decay', () => {
  it('age=0 → score ≈ 1.0, not cold', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const chunk = { timestamp: now };
    const result = scoreRawLog(chunk, now);
    assert.equal(result.score, 1.0);
    assert.equal(result.isCold, false);
  });

  it('age=49 days → score ~0.557 (medium decay on base 1.0)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const timestamp = new Date(now.getTime() - 49 * 24 * 60 * 60 * 1_000);
    const result = scoreRawLog({ timestamp }, now);
    // e^(-0.012 × 49) ≈ 0.5557
    assert.ok(
      result.score > 0.54 && result.score < 0.57,
      `expected ~0.556, got ${result.score}`,
    );
    assert.equal(result.isCold, false);
  });

  it('age=365 days → score ~0.0125, not yet cold', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const timestamp = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1_000);
    const result = scoreRawLog({ timestamp }, now);
    assert.ok(
      result.score > 0.01 && result.score < 0.02,
      `expected ~0.0125, got ${result.score}`,
    );
    assert.equal(result.isCold, false);
  });

  it('age=400 days → isCold', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const timestamp = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1_000);
    const result = scoreRawLog({ timestamp }, now);
    assert.ok(result.score < 0.01, `expected < 0.01, got ${result.score}`);
    assert.equal(result.isCold, true);
  });
});
