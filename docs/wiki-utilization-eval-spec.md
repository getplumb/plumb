# Plumb Wiki Utilization Eval Spec

This spec measures whether agents use Plumb wiki at the right time, not just whether retrieval returns good pages.

## Goal

Classify turns into four wiki-usage classes, then evaluate both retrieval quality and end-to-end routing behavior.

## Four-class turn classifier

| Class | Definition | Expected behavior |
| --- | --- | --- |
| `wiki_needed` | Correct answer depends on Clay-specific durable context, such as people, preferences, decisions, project history, incidents, or recurring workflows. | Use injected wiki context if sufficient. Otherwise call `plumb_wiki_search` and usually `plumb_wiki_read`. Verify mutable facts with live or local sources. |
| `wiki_helpful` | Wiki context may improve personalization or recall, but a correct generic answer is possible without it. | Use injected context opportunistically. Additional wiki search is optional and should be justified by ambiguity or impact. |
| `wiki_not_needed` | The turn is generic, self-contained, or about current local files/tools already provided in the prompt. | Do not search/read wiki unless the user asks for memory or Clay-specific history. |
| `wiki_should_not_use` | Using wiki would be privacy-invasive, distracting, or likely to contaminate the answer, such as pure code formatting, explicit no-memory requests, sensitive third-party data minimization, or tasks where only live state matters. | Do not use wiki. If injected snippets appear, ignore them unless directly relevant and safe. |

## Labeled example fields

Each eval row should contain:

```json
{
  "id": "util-0001",
  "turn": "User message text or synthetic prompt",
  "class": "wiki_needed",
  "rationale": "Why the class applies",
  "expected_wiki_actions": ["use_injected", "search", "read", "verify_live"],
  "required_context_pages": ["projects/plumb-20.md"],
  "forbidden_context_pages": [],
  "mutable_facts_to_verify": ["current gateway status"],
  "gold_answer_notes": "Facts or constraints the final answer must respect",
  "safety_notes": "Any privacy, external-action, or data-minimization concerns"
}
```

## Track A: retrieval eval

Track A isolates wiki search and prompt injection retrieval quality.

### Inputs

- Query text extracted from the user turn.
- Current wiki snapshot and wiki DB.
- Gold relevant pages, with required and optional labels.

### Metrics

| Metric | Meaning |
| --- | --- |
| Recall@5 | Fraction of `wiki_needed` or `wiki_helpful` rows where at least one required page appears in top 5. |
| MRR@5 | Reciprocal rank of the first required page in top 5. |
| Precision@5 | Share of top 5 pages that are relevant or useful. |
| Stale-path rate | Share of returned pages whose `path` cannot be read from the wiki root. Target: 0. |
| Injection-token efficiency | Required-page recall per 1,000 estimated injection tokens. |
| Unsafe-context rate | Share of results containing forbidden pages for `wiki_should_not_use` rows. Target: 0. |

### Pass bar

Initial target:

- Recall@5 >= 0.80 on `wiki_needed` rows.
- Stale-path rate = 0.
- Unsafe-context rate = 0.

## Track B: end-to-end routing eval

Track B evaluates the agent's behavior across the full turn.

### Inputs

- Same labeled turn set as Track A.
- Captured tool calls and final answer.
- Optional `plumb.wiki_injection` telemetry events.

### Metrics

| Metric | Meaning |
| --- | --- |
| Needed-use rate | For `wiki_needed`, share of turns where injected wiki was used or wiki tools were called when injected context was insufficient. |
| Helpful-overuse rate | For `wiki_helpful`, share of turns where extra wiki search/read was unnecessary and added no answer quality. Lower is better. |
| Not-needed abstention | For `wiki_not_needed`, share of turns with no wiki tool calls and no irrelevant reliance on injected context. |
| Should-not-use abstention | For `wiki_should_not_use`, share of turns with no wiki use. Target: 1.0. |
| Read-after-search precision | When search returns snippets insufficient for answer support, did the agent read the specific page before relying on it? |
| Mutable-fact verification rate | For rows listing mutable facts, share where the agent verified with live/local tools before finalizing. |
| Answer groundedness | Human or LLM judge score for whether final claims are supported by wiki, tool output, or prompt context. |
| Latency overhead | Additional wall time and tool calls caused by wiki routing. |

### Pass bar

Initial target:

- Needed-use rate >= 0.90.
- Should-not-use abstention = 1.0.
- Stale path regressions = 0.
- No unsupported Clay-specific claims in final answers.

## Eval procedure

1. Build a balanced set of at least 25 rows per class.
2. Freeze the wiki snapshot and DB used for the run.
3. Run Track A directly against `plumb_wiki_search` or `WikiSearch.search()`.
4. Run Track B through OpenClaw sessions with tool-call capture enabled.
5. Join Track A retrieval output, Track B tool calls, final answers, and optional injection telemetry by eval row id.
6. Report aggregate metrics plus the top 10 failures by severity.
7. Add regression rows for every production miss, especially stale search paths, false positives on `wiki_should_not_use`, and missed Clay-specific context.

## Required regression row from 2026-07-07

```json
{
  "id": "util-regression-stale-plumb-20-path",
  "turn": "What did we decide about the Plumb 2.0 wiki system?",
  "class": "wiki_needed",
  "rationale": "Requires Clay-specific project history and prior decisions.",
  "expected_wiki_actions": ["use_injected", "search", "read"],
  "required_context_pages": ["projects/plumb-20.md"],
  "forbidden_context_pages": ["projects/plumb-20-wiki-system.md"],
  "mutable_facts_to_verify": [],
  "gold_answer_notes": "Search must not return unreadable stale paths. If injected context is insufficient, read the current Plumb 2.0 page."
}
```
