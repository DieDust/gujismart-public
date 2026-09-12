# Shiji Workflow Comparison

Reviewed 2026-09-10. This is a source inspection, not a benchmark of their API
or a claim that GujiSmart implements the complete workflow. No upstream code or
prompts were copied. The upstream README identifies CC BY-NC-SA 4.0; verify
applicable permission before incorporating their material into a distributed app.

## Verified Upstream Behavior

- [Pipeline overview](https://github.com/baojie/shiji-kb/blob/main/skills/SKILL_00_%E7%AE%A1%E7%BA%BF%E6%80%BB%E8%A7%88.md): preserve the source, number paragraphs, build entities, events and relations, then validate and present applications. Rules and model inference have separate roles.
- [Event extraction](https://github.com/baojie/shiji-kb/blob/main/kg/events/scripts/extract_events.py): read one already annotated chapter per request, use a sequential loop, save its index and progress immediately, skip completed chapters, support failed-only retry and forced reruns. The 16000-token setting is the output ceiling, not an input chunk size. This script does not implement a universal long-chapter token splitter.
- [Relations](https://github.com/baojie/shiji-kb/blob/main/kg/events/scripts/extract_event_relations.py): compute some links locally, send chapter-grouped event lists for model inference, validate endpoint IDs and deduplicate links. This stage reuses structured results instead of resending the complete book. Its compact prompts and heuristics are not proof that inferred causal links are historically correct.
- [Review pipeline](https://github.com/baojie/shiji-kb/blob/main/kg/events/scripts/run_review_pipeline.py): separate automatic checks from optional model review, save per-chapter results and accumulated findings, and support resumption. This is a multi-stage editorial workflow, not one embedding request producing a verified graph.

## GujiSmart Status at the Initial Review

Current research extraction uses retrieval-selected representative evidence, with
a maximum of 80 evidence records per run. It is not complete document-by-document
knowledge construction. Neither accepting 1000 selected documents nor the report
batch regression establishes semantic extraction quality over 1000 full documents.

This maintenance change addresses report execution only: one shared research-model
request lane, a 300-second request timeout, at most one delayed retry for explicitly
transient HTTP/timeout errors, complete saved-record input in bounded report batches,
source IDs repeated on oversized record fragments, and visible report-stage messages.
Ordinary chat timeout defaults remain unchanged. Model summaries are lossy and must
not replace the source records. Automatic retry can incur additional model charges.

Extraction errors now stop the task without inserting an invented source-only event.
Previously saved records are retained; old inaccurate records are not auto-deleted.
Report batch intermediates are not yet durable checkpoints, so retrying a multi-batch
report may repeat completed summary calls. No thousand-document quality benchmark or
automatic full-book resumption is claimed.

## Follow-Up Implementation

The opt-in full-scope workflow now implements persisted document/page/text-unit
processing, bounded requests, checkpoints, failed-stage retry, exact source quotes,
and source-local entity/alias grouping with reversible identity review. These
capabilities are separate from legacy representative-evidence extraction. See
[the current workflow](corpus-research-workflow.md) for shipped behavior, scope
limits and reproducible tests. The complete upstream pipeline and a real
thousand-document semantic-quality evaluation are not claimed.

## Broader Workflow Design

Use document/chapter/paragraph work items with stable source locators, content hashes,
schema and prompt versions, persisted attempts and results, failed-only retry and
explicit rebuild. Keep entity mentions separate from canonical entities; resolve
names with provenance and reviewable decisions. Build relations from validated
events, preserve contradictory claims, and measure coverage independently of graph
node counts. Reports should be optional downstream products of that knowledge base,
not the definition of successful construction.

Research use should start with a question: trace a person's appearances and movements,
compare accounts of an event across sources, inspect relationship evidence, or review
chronological conflicts. Every answer must lead back to the original passage and
distinguish a source statement, statistical co-occurrence, and model inference.
