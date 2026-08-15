/**
 * Golden set for the queue worker's verify-then-commit post-condition (B1).
 *
 * EVERY CASE IS A REAL INCIDENT from Clay's wiki, reconstructed as the smallest
 * page set that reproduces it. Provenance is cited case by case below. Per the
 * standing rule (see the header of `wiki-resolve.test.ts`), nothing here is an
 * invented failure mode; the one reconstruction — the malformed frontmatter the
 * worker actually wrote on 2026-08-14 — is noted as such, because that file was
 * repaired by hand before the `plumb-wiki-backup` cron ever committed it, so the
 * broken bytes are not recoverable from git. Its SHAPE is quoted verbatim from
 * the incident record on `projects/plumb-wiki-pipeline-redesign.md` ("bold
 * pseudo-frontmatter (`**Type:** project`, `**Path:** ...`) instead of YAML,
 * plus a duplicated H1").
 *
 * The bar is 100%: this is a deterministic post-condition, and a
 * false positive here throws away a correct edit and dead-letters a real fact.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  snapshotWikiStructure,
  newStructureFindings,
  structureFindingKeyParts,
  verifyWikiStructure,
} from './wiki-verify.js';

// ---------------------------------------------------------------------------
// Scratch wiki helper
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWiki(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'plumb-verify-'));
  scratchDirs.push(root);
  writeFiles(root, files);
  return root;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/** A schema-clean page body. Field order matches the live wiki's pages. */
function page(opts: {
  type: string;
  title: string;
  body: string;
  aliases?: readonly string[];
  updated?: string;
}): string {
  const aliasLine = opts.aliases ? `aliases: [${opts.aliases.join(', ')}]\n` : '';
  return (
    `---\n` +
    `type: ${opts.type}\n` +
    `created: 2026-04-16\n` +
    `updated: ${opts.updated ?? '2026-08-14'}\n` +
    `source_refs: []\n` +
    `tags: [test]\n` +
    aliasLine +
    `confidence: high\n` +
    `---\n\n` +
    `# ${opts.title}\n\n` +
    opts.body +
    `\n`
  );
}

// ---------------------------------------------------------------------------
// Case 1 — the alias collision of 2026-08-14
//
// Real: while clearing the link backlog, `Claude Haiku` was added as an alias to
// `tools/claude.md`, which already coexisted with `concepts/claude-haiku.md`.
// The single live `[[Claude Haiku]]` link — `concepts/openai-o3.md:31`, "the LLM
// actually used for synthesis scoring in Plumb benchmark experiments" — went
// ambiguous. It was caught by hand-running the lint and the alias was removed.
//
// This is the load-bearing case for whole-corpus attribution: the page that
// GAINS the finding (`concepts/openai-o3.md`) is not the page that was edited
// (`tools/claude.md`). A verify step scoped to the touched files sees nothing.
// ---------------------------------------------------------------------------

const HAIKU_WIKI: Record<string, string> = {
  'tools/claude.md': page({
    type: 'tool',
    title: 'Claude',
    aliases: ['Claude', 'Sonnet', 'Claude Sonnet'],
    body: "Anthropic's Claude model family.",
  }),
  'concepts/claude-haiku.md': page({
    type: 'concept',
    title: 'Claude Haiku',
    body: "Anthropic's fast, lightweight LLM variant.",
  }),
  'concepts/openai-o3.md': page({
    type: 'concept',
    title: 'OpenAI o3',
    body: '- [[Claude Haiku]] — the LLM actually used for synthesis scoring in Plumb benchmark experiments (e.g., E32–E47)',
  }),
};

describe('alias collision on a page nobody edited (2026-08-14, tools/claude.md)', () => {
  it('is clean before the edit', async () => {
    const root = makeWiki(HAIKU_WIKI);
    const before = await snapshotWikiStructure(root);
    expect(before.totals).toEqual({
      unresolved: 0, ambiguous: 0, anchorMissing: 0, frontmatter: 0, placement: 0,
    });
  });

  it('is caught, and is attributed to a page the edit never touched', async () => {
    const root = makeWiki(HAIKU_WIKI);
    const before = await snapshotWikiStructure(root);

    writeFiles(root, {
      'tools/claude.md': page({
        type: 'tool',
        title: 'Claude',
        aliases: ['Claude', 'Sonnet', 'Claude Sonnet', 'Claude Haiku'],
        body: "Anthropic's Claude model family.",
      }),
    });

    const after = await snapshotWikiStructure(root);
    const verdict = verifyWikiStructure(before, after);

    expect(verdict.ok).toBe(false);
    expect(verdict.newFindings).toHaveLength(1);
    expect(verdict.newFindings[0]?.page).toBe('concepts/openai-o3.md');
    expect(verdict.newFindings[0]?.kind).toBe('link');
    expect(verdict.newFindings[0]?.detail).toContain('[ambiguous]');
    // The edited file itself is clean. Scoping to it would have passed the edit.
    expect(verdict.newFindings.some((f) => f.page === 'tools/claude.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — projects/company-wiki-brief.md, 2026-08-14T20:55:31Z
//
// Real: queue item c811000c ("New project (2026-08-14): company-wiki-brief — a
// field-guide deliverable Clay is sending a friend...") produced a page with
// bold pseudo-frontmatter instead of a YAML block and a duplicated H1. The
// prompt told the model to read 1-2 similar pages and match SCHEMA.md; it did
// not. Broken bytes reconstructed from the incident record — the file was
// repaired before the backup cron committed it.
// ---------------------------------------------------------------------------

const BRIEF_WIKI_BEFORE: Record<string, string> = {
  'projects/plumb-20.md': page({
    type: 'project',
    title: 'Plumb 2.0',
    body: 'The retrieval rewrite.',
  }),
};

const BROKEN_BRIEF = `# Company Wiki Brief

**Type:** project
**Path:** projects/company-wiki-brief.md
**Created:** 2026-08-14

# Company Wiki Brief

A field-guide deliverable Clay is sending a friend who is setting up a company
knowledge base.
`;

describe('bold pseudo-frontmatter (projects/company-wiki-brief.md, 2026-08-14)', () => {
  it('registers one finding per missing required field, and reverting clears them', async () => {
    const root = makeWiki(BRIEF_WIKI_BEFORE);
    const before = await snapshotWikiStructure(root);
    expect(before.totals.frontmatter).toBe(0);

    writeFiles(root, { 'projects/company-wiki-brief.md': BROKEN_BRIEF });
    const after = await snapshotWikiStructure(root);
    const verdict = verifyWikiStructure(before, after);

    expect(verdict.ok).toBe(false);
    // All six required fields are absent: the page has no YAML block at all.
    expect(verdict.newFindings).toHaveLength(6);
    expect(verdict.newFindings.every((f) => f.page === 'projects/company-wiki-brief.md')).toBe(true);
    expect(new Set(verdict.newFindings.map((f) => structureFindingKeyParts(f.key)[2]))).toEqual(
      new Set(['type', 'created', 'updated', 'source_refs', 'tags', 'confidence']),
    );

    // The worker's revert restores the pre-edit bytes; the next reading is clean.
    rmSync(join(root, 'projects/company-wiki-brief.md'));
    const reverted = await snapshotWikiStructure(root);
    expect(verifyWikiStructure(before, reverted).ok).toBe(true);
  });

  it('passes when the same page is written correctly', async () => {
    const root = makeWiki(BRIEF_WIKI_BEFORE);
    const before = await snapshotWikiStructure(root);

    writeFiles(root, {
      'projects/company-wiki-brief.md': page({
        type: 'project',
        title: 'Company Wiki Brief',
        body: 'A field-guide deliverable Clay is sending a friend setting up a company knowledge base. Related: [[Plumb 2.0]].',
      }),
    });

    const verdict = verifyWikiStructure(before, await snapshotWikiStructure(root));
    expect(verdict.newFindings).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — a pre-existing finding elsewhere must not fail a good edit
//
// Real: on the live wiki the unresolved-link threshold carries headroom
// precisely because forward references are a legitimate way to work here
// ("[[Plumb Wiki Integrity]]" was written on purpose before the job existed).
// A pre-existing dangling link on an unrelated page appears in BOTH readings and
// cancels.
// ---------------------------------------------------------------------------

describe('pre-existing findings on unrelated pages', () => {
  it('cancel by subtraction and do not fail a good edit', async () => {
    const root = makeWiki({
      'projects/plumb-wiki-pipeline-redesign.md': page({
        type: 'project',
        title: 'Plumb Wiki Pipeline Redesign',
        body: 'Job 1 is [[Plumb Wiki Integrity]], which does not exist yet.',
      }),
      'people/clay-waters.md': page({ type: 'person', title: 'Clay Waters', body: 'Product lead.' }),
    });

    const before = await snapshotWikiStructure(root);
    expect(before.totals.unresolved).toBe(1);

    writeFiles(root, {
      'people/clay-waters.md': page({
        type: 'person',
        title: 'Clay Waters',
        body: 'Product lead. Currently interviewing at Itron for Head of Product.',
      }),
    });

    const verdict = verifyWikiStructure(before, await snapshotWikiStructure(root));
    expect(verdict.ok).toBe(true);
    expect(verdict.after.totals.unresolved).toBe(1); // still there, still not our fault
  });

  it('still catches a SECOND instance of an already-broken link', async () => {
    const root = makeWiki({
      'projects/plumb-wiki-pipeline-redesign.md': page({
        type: 'project',
        title: 'Plumb Wiki Pipeline Redesign',
        body: 'Job 1 is [[Plumb Wiki Integrity]], which does not exist yet.',
      }),
    });
    const before = await snapshotWikiStructure(root);

    writeFiles(root, {
      'projects/plumb-wiki-pipeline-redesign.md': page({
        type: 'project',
        title: 'Plumb Wiki Pipeline Redesign',
        body:
          'Job 1 is [[Plumb Wiki Integrity]], which does not exist yet.\n\n' +
          'Shipped 2026-08-14: see [[Plumb Wiki Integrity]] for the artifact.',
      }),
    });

    const verdict = verifyWikiStructure(before, await snapshotWikiStructure(root));
    expect(verdict.ok).toBe(false);
    expect(verdict.newFindings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — line shifts must not manufacture findings
//
// This is the reason finding identity carries no line number. The worker's
// commonest edit by far is appending a dated section to a long project page;
// `projects/plumb-wiki-pipeline-redesign.md` grew four such sections on
// 2026-08-14 alone. Any of them would shift every line below it.
// ---------------------------------------------------------------------------

describe('line shifts from an append', () => {
  it('produce no findings even when the page already carries one', async () => {
    const root = makeWiki({
      'projects/plumb-wiki-pipeline-redesign.md': page({
        type: 'project',
        title: 'Plumb Wiki Pipeline Redesign',
        body: 'Trailing forward reference: [[Plumb Wiki Integrity]].',
      }),
    });
    const before = await snapshotWikiStructure(root);
    expect(before.findings).toHaveLength(1);
    const beforeLine = before.findings[0]?.detail;

    writeFiles(root, {
      'projects/plumb-wiki-pipeline-redesign.md': page({
        type: 'project',
        title: 'Plumb Wiki Pipeline Redesign',
        body:
          '## Tranche A (Stabilize) Complete\n\nlinks unresolved 0, ambiguous 0.\n\n' +
          'Trailing forward reference: [[Plumb Wiki Integrity]].',
      }),
    });

    const after = await snapshotWikiStructure(root);
    // The line number really did move; the finding is still the same finding.
    expect(after.findings[0]?.detail).not.toBe(beforeLine);
    expect(verifyWikiStructure(before, after).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — a new page is an orphan, and that is not a defect
//
// Real: the Tranche A verification recorded 9 orphans, "several created this
// week ... new pages arrive orphaned because index.md earns no inbound credit".
// Reverting page creation over this would break the pipeline's whole purpose.
// ---------------------------------------------------------------------------

describe('newly created pages', () => {
  it('are orphans but never findings', async () => {
    const root = makeWiki({
      'people/clay-waters.md': page({ type: 'person', title: 'Clay Waters', body: 'Product lead.' }),
    });
    const before = await snapshotWikiStructure(root);

    writeFiles(root, {
      'companies/itron.md': page({
        type: 'company',
        title: 'Itron',
        body: 'Employer behind the active Head of Product process. Acquired Locusview.',
      }),
    });

    const verdict = verifyWikiStructure(before, await snapshotWikiStructure(root));
    expect(verdict.ok).toBe(true);
    expect(verdict.newFindings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — a stale anchor introduced by renaming a heading
//
// Real: four stale heading anchors on
// `projects/plumb-email-to-wiki-review-architecture.md` on 2026-08-14, caused by
// headings gaining ", Claude Code session" after the links were written. Exactly
// the shape of an automated edit that retitles a section.
// ---------------------------------------------------------------------------

describe('renaming a heading that another page anchors into', () => {
  it('is caught as a stale anchor on the linking page', async () => {
    const root = makeWiki({
      'projects/plumb-email-to-wiki-review-architecture.md': page({
        type: 'project',
        title: 'Plumb Email-to-Wiki Review Architecture',
        body: '## Measured Coverage\n\n60% coverage, 36-80% CI.',
      }),
      'projects/plumb-wiki-pipeline-redesign.md': page({
        type: 'project',
        title: 'Plumb Wiki Pipeline Redesign',
        body: 'See [[Plumb Email-to-Wiki Review Architecture#Measured Coverage]].',
      }),
    });
    const before = await snapshotWikiStructure(root);
    expect(before.findings).toEqual([]);

    writeFiles(root, {
      'projects/plumb-email-to-wiki-review-architecture.md': page({
        type: 'project',
        title: 'Plumb Email-to-Wiki Review Architecture',
        body: '## Measured Coverage, Claude Code session\n\n60% coverage, 36-80% CI.',
      }),
    });

    const verdict = verifyWikiStructure(before, await snapshotWikiStructure(root));
    expect(verdict.ok).toBe(false);
    expect(verdict.newFindings).toHaveLength(1);
    expect(verdict.newFindings[0]?.page).toBe('projects/plumb-wiki-pipeline-redesign.md');
    expect(verdict.newFindings[0]?.detail).toContain('[anchor-missing]');
  });
});

// ---------------------------------------------------------------------------
// Case 7 — an edit that FIXES something must pass, and be visible as a fix
// ---------------------------------------------------------------------------

describe('an edit that repairs an existing finding', () => {
  it('passes and reports the resolved finding', async () => {
    const root = makeWiki({
      'people/lauren-gilmore.md': page({
        type: 'person',
        title: 'Lauren Gilmore',
        body: 'Director of Global Talent Acquisition at [[Itron]].',
      }),
    });
    const before = await snapshotWikiStructure(root);
    expect(before.totals.unresolved).toBe(1);

    writeFiles(root, {
      'companies/itron.md': page({ type: 'company', title: 'Itron', body: 'Acquired Locusview.' }),
    });

    const verdict = verifyWikiStructure(before, await snapshotWikiStructure(root));
    expect(verdict.ok).toBe(true);
    expect(verdict.resolvedFindings).toHaveLength(1);
    expect(verdict.resolvedFindings[0]?.page).toBe('people/lauren-gilmore.md');
  });
});

// ---------------------------------------------------------------------------
// Diff mechanics
// ---------------------------------------------------------------------------

describe('newStructureFindings', () => {
  it('is empty for two readings of an unchanged wiki', async () => {
    const root = makeWiki(HAIKU_WIKI);
    const a = await snapshotWikiStructure(root);
    const b = await snapshotWikiStructure(root);
    expect(newStructureFindings(a, b)).toEqual([]);
    expect(newStructureFindings(b, a)).toEqual([]);
  });

  it('treats a null baseline as "nothing to compare", not as a pass', async () => {
    const root = makeWiki({ 'projects/broken.md': BROKEN_BRIEF });
    const after = await snapshotWikiStructure(root);
    const verdict = verifyWikiStructure(null, after);
    expect(verdict.ok).toBe(true);
    expect(verdict.newFindings).toEqual([]);
    // ...but the reading itself is not clean, which is the caller's business.
    expect(after.totals.frontmatter).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe('a page filed outside the schema directories (queue item 8b422737, 2026-08-14)', () => {
  // The real fact ended: "File: memory/docs/2026-08-04-zapier-sdk-jd.md" — a
  // path in the separate OpenClaw memory store, named as a REFERENCE to where
  // the source document lives. The worker read it as a destination and created
  // that path inside the wiki.
  it('is a finding even when the page is otherwise schema-clean', () => {
    const before = makeWiki({
      'companies/zapier.md': page({ type: 'company', title: 'Zapier' }),
    });
    const after = makeWiki({
      'companies/zapier.md': page({ type: 'company', title: 'Zapier' }),
      // Valid frontmatter and a real H1 — the case B1 could NOT already catch,
      // since the live incident was reverted only because it lacked frontmatter.
      'memory/docs/2026-08-04-zapier-sdk-jd.md': page({
        type: 'project',
        title: 'Zapier SDK Job Description',
      }),
    });

    return (async () => {
      const b = await snapshotWikiStructure(before);
      const a = await snapshotWikiStructure(after);
      const introduced = newStructureFindings(b, a);

      expect(b.totals.placement).toBe(0);
      expect(a.totals.placement).toBe(1);
      const placement = introduced.filter((f) => f.kind === 'placement');
      expect(placement).toHaveLength(1);
      expect(placement[0]!.page).toBe('memory/docs/2026-08-04-zapier-sdk-jd.md');
      expect(placement[0]!.detail).toContain('memory/');
    })();
  });

  it('does not fire on any directory the live wiki actually uses', async () => {
    const root = makeWiki({
      'people/clay-waters.md': page({ type: 'person', title: 'Clay Waters' }),
      'companies/zapier.md': page({ type: 'company', title: 'Zapier' }),
      'tools/plumb.md': page({ type: 'tool', title: 'Plumb' }),
      'projects/plumb-20.md': page({ type: 'project', title: 'Plumb 2.0' }),
      'interviews/samsara-loop.md': page({ type: 'interview', title: 'Samsara Loop' }),
      'concepts/rag.md': page({ type: 'concept', title: 'RAG' }),
      'stories/digital-twin-rebuild.md': page({ type: 'story', title: 'Digital Twin Rebuild' }),
      'life/health-fitness-wellness.md': page({ type: 'life', title: 'Health' }),
      'education/mit-sloan-agentic-ai-course.md': page({ type: 'concept', title: 'MIT Sloan' }),
      'preferences/interview-call-notes-and-recording.md': page({ type: 'concept', title: 'Call Notes' }),
      'sources/some-source.md': page({ type: 'concept', title: 'A Source' }),
      'archive/companies-flyio-2026-08-14.md': page({ type: 'company', title: 'Fly.io' }),
      // Root-level files are legitimate and exempt.
      'index.md': '# Index\n',
      'glossary.md': '# Glossary\n',
    });

    const snap = await snapshotWikiStructure(root);
    expect(snap.totals.placement).toBe(0);
  });

  it('a page already misplaced before the edit cancels and cannot fail a good edit', async () => {
    const files = { 'memory/docs/stray.md': page({ type: 'project', title: 'Stray' }) };
    const before = makeWiki(files);
    const after = makeWiki({
      ...files,
      'companies/zapier.md': page({ type: 'company', title: 'Zapier' }),
    });

    const b = await snapshotWikiStructure(before);
    const a = await snapshotWikiStructure(after);
    expect(b.totals.placement).toBe(1);
    expect(a.totals.placement).toBe(1);
    expect(newStructureFindings(b, a).filter((f) => f.kind === 'placement')).toEqual([]);
  });
});
