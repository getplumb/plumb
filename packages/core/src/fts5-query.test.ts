import { describe, expect, test } from 'vitest';
import { compileSafeFts5Query } from './fts5-query.js';

describe('compileSafeFts5Query', () => {
  test.each([
    ['user@example.com', '"user example com"'],
    ['foo-bar', '"foo bar"'],
    ['"quoted text"', '"quoted text"'],
    ['(parentheses)', '"parentheses"'],
    ['type:person clay', '"type" AND "person" AND "clay"'],
    ['foo OR bar', '"foo" OR "bar"'],
    ['foo AND bar', '"foo" AND "bar"'],
    ['OR foo AND', '"foo"'],
    ['"unterminated foo', '"unterminated" AND "foo"'],
  ])('compiles %j without raw FTS5 syntax', (input, expected) => {
    expect(compileSafeFts5Query(input).match).toBe(expected);
  });

  test.each(['', '   ', '@@@', '()::*^-'])('returns null for punctuation-only input %j', (input) => {
    expect(compileSafeFts5Query(input).match).toBeNull();
  });

  test('property: compiled output is only quoted operands plus AND/OR operators', () => {
    const samples = [
      'user@example.com', 'foo-bar', '"quoted text"', 'parentheses (x)',
      'colon:thing', 'OR', 'AND', 'foo OR bar', 'foo AND bar', 'a:b OR c-d AND "e f"',
      'one* two^ three NEAR four', '"quote "" inside"', 'emoji 😊 plus café@example.co.uk',
    ];
    for (const sample of samples) {
      const compiled = compileSafeFts5Query(sample).match;
      if (compiled === null) continue;
      expect(compiled).toMatch(/^("(?:""|[^"])*"|AND|OR)( ("(?:""|[^"])*"|AND|OR))*$/);
      expect(compiled).not.toContain('@');
      expect(compiled).not.toContain(':');
      expect(compiled).not.toContain('(');
      expect(compiled).not.toContain(')');
    }
  });
});
