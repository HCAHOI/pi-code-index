// Phase-3 rerank experiment: does semantic rerank of dense top-N beat dense alone on intent queries?
// dense top-N candidates -> Voyage rerank-2.5 -> top-k. Compares dense vs reranked, chunk-granular.
// Needs VOYAGE_API_KEY (rerank shares the embedding key). Run: node scripts/rerankeval.mjs [repoRoot]
import * as lancedb from "@lancedb/lancedb";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolve(process.argv[2] || process.cwd());
const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
const dataDir = join(agentDir, "code-index");
const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
const lancedbDir = join(dataDir, "indexes", hash, "lancedb");
const queries = JSON.parse(readFileSync(join(extDir, "eval", "queries.json"), "utf8"));
const gc = existsSync(join(dataDir, "config.json")) ? JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) : {};
const embModel = gc.model || "voyage-code-3";
const embUrl = gc.baseUrl || "https://api.voyageai.com/v1/embeddings";
const apiKey = process.env.VOYAGE_API_KEY;
const RERANK_MODEL = "rerank-2.5";
const RERANK_URL = "https://api.voyageai.com/v1/rerank";
const CAND = 30; // candidate-N reranked (decoupled from final-k; bounds rerank cost)
const KS = [1, 5, 10];
const DOC_CHARS = 2000; // truncate each candidate's code so a request stays within token limits

if (!apiKey) { console.error("Missing VOYAGE_API_KEY"); process.exit(2); }

async function embed(input) {
	const res = await fetch(embUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: embModel, input, input_type: "query" }) });
	if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
	return (await res.json()).data[0].embedding;
}
async function rerank(query, documents) {
	const res = await fetch(RERANK_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query, documents, model: RERANK_MODEL, top_k: documents.length }) });
	if (!res.ok) throw new Error(`rerank ${res.status}: ${await res.text()}`);
	return (await res.json()).data; // [{index, relevance_score}] sorted desc
}

function chunkHit(c, q) {
	if (!q.expectedPaths.includes(c.path)) return false;
	const el = q.expectedLines;
	if (!Array.isArray(el) || el.length !== 2) return true;
	return c.startLine <= el[1] && c.endLine >= el[0];
}
function metrics(ranked, q) {
	const fh = ranked.findIndex((c) => chunkHit(c, q));
	const hits = {};
	for (const k of KS) hits[k] = fh >= 0 && fh < k ? 1 : 0;
	return { hits, rr: fh >= 0 ? 1 / (fh + 1) : 0, fh };
}
function mulberry32(s) { return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function band(vals, B = 2000) { const r = mulberry32(0x5eed), m = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < vals.length; i++) s += vals[Math.floor(r() * vals.length)]; m.push(s / vals.length); } m.sort((a, b) => a - b); return [m[Math.floor(B * 0.025)], m[Math.floor(B * 0.975)]]; }
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const db = await lancedb.connect(lancedbDir);
const table = await db.openTable("chunks");
const cols = { dense: [], reranked: [] };
let rkErr;
for (const q of queries) {
	const vector = await embed(q.query);
	const rows = (await table.vectorSearch(vector).limit(CAND).toArray()).map((r) => ({ path: r.path, startLine: r.startLine, endLine: r.endLine, content: r.content }));
	const dense = metrics(rows, q);
	cols.dense.push(dense);
	let rk = null;
	try {
		const order = await rerank(q.query, rows.map((r) => String(r.content || "").slice(0, DOC_CHARS)));
		rk = metrics(order.map((d) => rows[d.index]), q);
		cols.reranked.push(rk);
	} catch (e) { if (!rkErr) console.log(`! rerank failed: ${(rkErr = e.message)}`); }
	const mk = (s) => (s ? (s.hits[5] ? "✓" : s.fh >= 0 ? `#${s.fh + 1}` : "✗") : "-");
	console.log(`D:${mk(dense).padEnd(3)} R:${mk(rk).padEnd(3)}  ${String(q.query).slice(0, 60)}`);
}
function report(name, arr) {
	if (!arr.length) return console.log(`\n[${name}] (no results)`);
	console.log(`\n[${name}] n=${arr.length}`);
	for (const k of KS) { const v = arr.map((p) => p.hits[k]); const [lo, hi] = band(v); console.log(`  recall@${String(k).padStart(2)} = ${mean(v).toFixed(3)}  [95% ${lo.toFixed(3)}-${hi.toFixed(3)}]`); }
	console.log(`  MRR     = ${mean(arr.map((p) => p.rr)).toFixed(3)}`);
}
console.log(`\n=== rerank ${RERANK_MODEL} over dense top-${CAND} | ${queries.length} queries | chunk-granular ===`);
report("dense (top-30)", cols.dense);
report("reranked (Voyage)", cols.reranked);
console.log(`\nGate: rerank passes if its recall@k mean clears the dense band's upper edge (gain > noise).`);
