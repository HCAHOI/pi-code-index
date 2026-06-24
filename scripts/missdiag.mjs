// Local diagnostic (NO key): for each query, show how the target implementation got chunked in the
// index — is the expected line-range fragmented across many chunks, buried in one huge chunk, or
// cleanly covered? Reveals whether dense misses are a chunking problem. Run: node scripts/missdiag.mjs [repoRoot]
import * as lancedb from "@lancedb/lancedb";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolve(process.argv[2] || process.cwd());
const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
const lancedbDir = join(agentDir, "code-index", "indexes", hash, "lancedb");
const queries = JSON.parse(readFileSync(join(extDir, "eval", "queries.json"), "utf8"));

// dense-miss queries from the round-2 rerankeval run (D:✗ or D:#>10), by query-text prefix.
const MISS = [
	"how is KV cache eviction triggered", "what strategy decides which cached KV", "what is the mechanism to subscribe",
	"when is random token eviction", "how are per-layer eviction decisions", "what is the default fallback behavior",
	"what configuration controls the prefill", "how is the vLLM engine invoked", "what is the sparse attention mask interface",
	"how does sliding window attention enforce", "what observe-only mode allows", "how are prompt templates resolved",
	"how is the gantt payload transformed", "how does metadata-aware eviction protect", "how are tool calls extracted",
	"how does the framework handle session resume", "how are multi-iteration benchmarks", "how are sparse attention block selection",
	"how is gap compression applied", "what validation ensures KV eviction",
];
const isMiss = (qt) => MISS.some((m) => qt.startsWith(m));

const db = await lancedb.connect(lancedbDir);
const table = await db.openTable("chunks");
const esc = (s) => s.replaceAll("'", "''");

for (const q of queries) {
	const p = q.expectedPaths[0];
	const rows = (await table.query().where(`path = '${esc(p)}'`).toArray()).map((r) => ({ s: r.startLine, e: r.endLine, sym: r.symbol || "-", len: (r.content || "").length })).sort((a, b) => a.s - b.s);
	const [es, ee] = q.expectedLines || [1, 1e9];
	const cov = rows.filter((c) => c.s <= ee && c.e >= es);
	const maxLine = rows.length ? Math.max(...rows.map((r) => r.e)) : 0;
	const flag = isMiss(q.query) ? "MISS" : "ok  ";
	console.log(`[${flag}] ${q.query.slice(0, 52).padEnd(52)} ${p.split("/").slice(-1)[0]} ~${maxLine}L/${rows.length}ch target[${es}-${ee}] cov=${cov.length}`);
	if (isMiss(q.query)) for (const c of cov) console.log(`         covered: [${c.s}-${c.e}] ${c.len}ch sym=${c.sym}`);
}
