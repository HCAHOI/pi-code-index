# Retrieval-quality baseline — agent-sched-bench held-out repo

Recorded 2026-06-23. Yardstick for every v2 phase: a phase passes only if its recall@k gain exceeds
the ±band below (noise-aware gate, per critic C1).

## Setup
- Repo: `~/Workspace/agent-sched-bench` (464 indexed files, 4387 chunks; py-dominant + ts/tsx + py backend)
- Index: `voyage-code-3`, 1024-dim, AST chunking + static contextual header (File/Language/Symbol/Code), INDEX_VERSION 2
- Retrieval: **dense only** (LanceDB vectorSearch). Hybrid/FTS column added in Phase 1.
- Eval: 52 chunk-granular labeled queries, externally phrased; hit = retrieved chunk's file ∈ expectedPaths AND line-range overlaps expectedLines.

## v1 dense baseline
| metric | value | 95% bootstrap band |
|---|---|---|
| recall@1 | 0.308 | 0.173–0.442 |
| recall@5 | 0.577 | 0.442–0.712 |
| recall@10 | 0.712 | 0.596–0.827 |
| MRR | 0.436 | — |

Note: n=52 gives a wide ±0.13 band. To reliably detect a small (<0.10) Phase-1 gain, expand the
labeled set toward ~120 queries to tighten the band.

## Failure analysis (drives Phase 1)
**11 hard MISSes** — most are identifier-heavy, i.e. the answer file contains the exact snake_case
symbol the query paraphrases. Dense misses them; a lexical/FTS arm with identifier tokenization (H2)
should recover them:
- "observe-only mode" → `observe_only` (sparse_attention/base.py) — MISS
- "position control eviction" → `position_control` (kv_policies/base.py) — MISS
- "block selection scores reduced across heads" → `block_topk.py` — MISS
- "validation ... mutually exclusive" → `validate_attention_method_exclusivity` (cli.py) — MISS
- "prompt templates resolved from config names" → `prompt_template` (config/schema.py) — MISS
- "default fallback when scores unavailable during prefill" → h2o.py score_missing — MISS
- "session resume across multiple LLM calls" → session/manager.py — MISS
- "tool calls extracted into structured action records" → trace_logger.py — MISS
- "multi-iteration benchmarks ... checkpointing" → test_terminal_bench_runner.py — MISS
- "gap compression to remove idle time" → payload.py — MISS
- "prefill attention sampling strategy config" → config.py — MISS

**Ranked-but-past-5** (recall@5 misses) — heavily concentrated in `h2o.py` (7 queries target it; the
file is split into many chunks that compete): #8, #15, #18 for h2o; also `_loop.py` #6/#7,
`vllm_entrypoint` #15, `attempt_pipeline` #9, `simulator` #9, `routes.py` #12, `streaming.py` #6.

## Phase 1 result: hybrid REJECTED (eval-gated)
Tested dense vs lexical(FTS) vs hybrid(RRF) on the 52-query held-out set:
| path | r@1 | r@5 | r@10 | MRR |
|---|---|---|---|---|
| dense (baseline) | 0.308 | **0.577** | **0.712** | 0.436 |
| lexical (FTS only) | 0.154 | 0.327 | 0.423 | 0.240 |
| hybrid (dense+FTS RRF) | 0.212 | **0.442** | **0.596** | 0.334 |

Hybrid is **worse** than dense: naive RRF lets the low-precision lexical arm pull noise chunks into
top-k, displacing dense's good hits.

Tokenizer diagnostic (`lexdiag.mjs`, no-key, local) — **tokenization is NOT the bottleneck**:
- simple / simple+stop / simple+stem all identical at r@5=0.327
- ngram3-4 worse at r@5=0.250

**H2 falsified.** Changing tokenization does not lift lexical. FTS is structurally weak on
natural-language *intent* queries (the tool's input shape); its home turf is keyword/identifier
queries, which we already route to `ffgrep`. naive RRF then drags dense down.

**Decision: SKIP Phase 1 hybrid.** Pivot to Phase 3 rerank (semantic re-rank of dense top-N) — fits
intent queries, adds no lexical noise. Phase 2 (structured context) remains open. The `content` FTS
index built during this test is harmless (production search still uses dense vectorSearch only).

## Corrected-label baseline + rerank REJECTED (2026-06-23, round 2)
After fixing the definition-vs-implementation label bias (27 confident / 25 uncertain; key fix #35
position_control -> the real `PositionControlCache._decide_evict` algorithm, spot-checked correct):
| path | r@1 | r@5 | r@10 | MRR |
|---|---|---|---|---|
| dense (corrected labels) | 0.231 | 0.462 | 0.577 | 0.356 |
| reranked (Voyage rerank-2.5) | 0.231 | 0.385 | 0.519 | 0.315 |

- New labels are HARDER (point at implementation, not name-matching declarations): dense 0.577->0.462
  vs old labels. This is the honest difficulty of retrieving *implementation* code (~46% recall@5).
- **Rerank still net-negative on clean labels** (0.462->0.385). Label bias was NOT the cause; a general
  reranker genuinely underperforms the code-specialized dense embedding. Confirmed across both label sets.

## Strategic conclusion
Both v2 frontier bets are REJECTED by the gate:
- Phase 1 hybrid (dense+FTS RRF): worse than dense (general FTS noise).
- Phase 3 rerank (Voyage rerank-2.5): worse than dense (general reranker < code-specialized embedding).
Common root cause: a GENERAL-PURPOSE secondary signal cannot beat voyage-code-3 on code+intent queries;
post-hoc fusion/re-ranking only injects noise. The remaining lever is the DENSE INPUT itself
(Phase 2 structured context, better chunking, or a stronger code embedding) — not post-processing.

## Dense-miss diagnosis: CHUNK DILUTION, not embedding weakness (missdiag.mjs, local no-key)
Dense misses cluster on LARGE single chunks — a whole big function embedded as one 2000-5000 char
chunk dilutes its sub-semantics:
- h2o.py `_decide_evict` = 4959 chars, ONE chunk. Two queries (drop-strategy, score-missing fallback)
  both point into it and both miss — the embedding is dominated by the whole function.
- BaseEvictionCache.update = 2204 chars; H2OCache.__init__ = 3381 chars (the subscribe call is buried);
  KVEvictionRecorder.append = 3559 chars.
Contrast — clean dense HITS have small focused chunks: metrics.py target cov=3 small chunks;
position_control target[1076-1098] = 1 tight chunk -> HIT.
Secondary cause: a few uncertain labels are still query/impl mismatches (vllm_entrypoint, schema.py).

## Implication: finer chunking, NOT structured context
The lever is FINER chunking (sub-split large functions so each chunk's embedding is focused), the
OPPOSITE of Phase 2's structured-context prefix — adding a shared prefix to an already-diluted big
chunk makes it longer and noisier (this is exactly critic H3's clumping risk, now evidenced).
Current `maxChunkChars=12000` lets 5000-char functions embed whole; lowering it (~1500-2000) should
sharpen sub-semantics. Costs one reindex to test.

## Finer chunking REJECTED (round 3)
Reindexed with maxChunkChars 12000->1800 (subSplitNode splits large functions at statement
boundaries; chunks 4368->4801, +10% — only the few giant functions split):
| path | r@1 | r@5 | r@10 | MRR |
|---|---|---|---|---|
| dense (finer chunks) | 0.192 | 0.462 | 0.577 | 0.331 |
| dense (big chunks)   | 0.231 | 0.462 | 0.577 | 0.356 |
recall@5/@10 EXACTLY unchanged; recall@1/MRR slightly worse. Splitting the big miss-cluster functions
recovered NONE of them. Root cause is NOT chunk dilution but a semantic GAP between NL-intent queries
and code implementation that voyage-code-3 cannot bridge regardless of chunk size.

## FINAL v2 conclusion (retrieval-quality: explored & closed)
All explored levers REJECTED by the eval gate:
- hybrid (FTS+RRF): worse (general FTS noise on intent queries)
- rerank (Voyage rerank-2.5): worse (general reranker < code-specialized embedding)
- finer chunking: no change, recall@1 slightly worse (root cause is semantic gap, not chunk size)
voyage-code-3 dense ~0.46 recall@5 is the practical ceiling here. Further gains need a stronger code
embedding, true LLM contextual retrieval (expensive, deprioritized), or query rewriting/HyDE — large
investments, uncertain ROI on a 0.46 baseline. KEEP the v1 engineering wins (provider presets, cost
footer, maxTopK, review bug-fixes). Roll back maxChunkChars to restore recall@1.
