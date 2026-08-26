/**
 * fts5-query.ts — safe compiler for user text passed to SQLite FTS5 MATCH.
 *
 * SQLite parameter binding protects SQL syntax, but FTS5 MATCH has its own query
 * language. Raw user text such as email addresses, hyphenated words, column
 * filters, parentheses, quotes, or bare AND/OR tokens can still throw FTS5 syntax
 * errors. This module converts natural-language user text into a small, safe
 * subset of MATCH syntax:
 *   - every term/phrase is double-quoted with escaped quotes;
 *   - AND/OR are preserved only as explicit binary operators between operands;
 *   - ordinary whitespace means AND, matching SQLite FTS5's default behavior;
 *   - punctuation-only input returns null so callers can skip MATCH entirely.
 */

export interface SafeFts5Query {
  /** Safe string suitable for `... MATCH ?` binding, or null when no tokens exist. */
  match: string | null;
  /** Normalized operand phrases/terms used to build `match`. */
  operands: string[];
}

type Part = { kind: 'operand'; value: string } | { kind: 'operator'; value: 'AND' | 'OR' };

const WORD_RE = /[\p{L}\p{N}]+/gu;
const TOKEN_OR_OPERATOR_RE = /"(?:""|[^"])*"|[\p{L}\p{N}]+(?:[._%+\-@'][\p{L}\p{N}]+)*/gu;

function words(value: string): string[] {
  return value.match(WORD_RE) ?? [];
}

function quoteFts5Phrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function operandFromRaw(raw: string): string | null {
  const ws = words(raw);
  if (ws.length === 0) return null;
  // FTS5's unicode tokenizer splits punctuation inside emails/domains/hyphenated
  // words. Quoting the normalized token sequence makes `foo-bar` and
  // `clay@example.com` match the adjacent token sequence without exposing raw
  // punctuation to the MATCH grammar.
  return ws.join(' ');
}

/** Compile arbitrary user text into safe FTS5 MATCH syntax. */
export function compileSafeFts5Query(input: string): SafeFts5Query {
  const parts: Part[] = [];
  const tokens = input.match(TOKEN_OR_OPERATOR_RE) ?? [];

  for (const rawToken of tokens) {
    if (rawToken.startsWith('"') && rawToken.endsWith('"')) {
      const inner = rawToken.slice(1, -1).replace(/""/g, '"');
      const operand = operandFromRaw(inner);
      if (operand) parts.push({ kind: 'operand', value: operand });
      continue;
    }

    const upper = rawToken.toUpperCase();
    if (upper === 'AND' || upper === 'OR') {
      parts.push({ kind: 'operator', value: upper });
      continue;
    }

    const operand = operandFromRaw(rawToken);
    if (operand) parts.push({ kind: 'operand', value: operand });
  }

  const output: string[] = [];
  const operands: string[] = [];
  let pendingOperator: 'AND' | 'OR' | null = null;
  let sawOperand = false;

  for (const part of parts) {
    if (part.kind === 'operator') {
      // Operators are meaningful only after an operand. Leading/consecutive
      // operators are ignored rather than being emitted as invalid MATCH syntax.
      if (sawOperand) pendingOperator = part.value;
      continue;
    }

    if (sawOperand) output.push(pendingOperator ?? 'AND');
    output.push(quoteFts5Phrase(part.value));
    operands.push(part.value);
    sawOperand = true;
    pendingOperator = null;
  }

  return { match: output.length > 0 ? output.join(' ') : null, operands };
}
