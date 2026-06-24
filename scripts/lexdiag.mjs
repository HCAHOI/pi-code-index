// Local lexical-only diagnostic (NO embedding, NO API key): does FTS weakness come from tokenization
// (snake/camel identifiers not split) or from sentence-query noise? Compares tokenizer configs on the
// existing index. Run: node scripts/lexdiag.mjs [repoRoot]
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

function chunkHit(c, q) {
	if (!q.expectedPaths.includes(c.path)) return false;
	const el = q.expectedLines;
	if (!Array.isArray(el) || el.length !== 2) return true;
	return c.startLine <= el[1] && c.endLine >= el[0];
}
const KS = [1, 5, 10];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const db = await lancedb.connect(lancedbDir);
const table = await db.openTable("chunks");

const configs = [
	["simple", { baseTokenizer: "simple", lowercase: true, asciiFolding: true }],
	["simple+stop", { baseTokenizer: "simple", lowercase: true, asciiFolding: true, removeStopWords: true }],
	["simple+stem", { baseTokenizer: "simple", lowercase: true, asciiFolding: true, stem: true, removeStopWords: true }],
	["ngram3-4", { baseTokenizer: "ngram", ngramMinLength: 3, ngramMaxLength: 4, lowercase: true }],
];

// Identifier-heavy queries we specifically want lexical to recover (from the baseline failure analysis).
const idTargets = new Set([
	"what observe-only mode allows testing sparse selection without changing generation",
	"how does position control eviction select which cache positions to keep",
	"how are sparse attention block selection scores reduced across heads for ranking",
	"what validation ensures KV eviction and sparse attention methods are mutually exclusive",
	"how are prompt templates resolved from config names to markdown files",
]);

console.log(`queries: ${queries.length} | index dir: ${lancedbDir}\n`);
for (const [name, opt] of configs) {
	try {
		await table.createIndex("content", { config: lancedb.Index.fts(opt), replace: true });
		await table.optimize();
	} catch (e) {
		console.log(`[${name}] build failed: ${e.message}`);
		continue;
	}
	const per = [];
	let idHits = 0;
	let qfail = false;
	for (const q of queries) {
		let rows = [];
		try {
			rows = await table.query().fullTextSearch(q.query, { columns: ["content"] }).limit(20).toArray();
		} catch (e) {
			if (!qfail) { qfail = true; console.log(`[${name}] query failed: ${e.message}`); }
		}
		const fh = rows.map((r) => ({ path: r.path, startLine: r.startLine, endLine: r.endLine })).findIndex((c) => chunkHit(c, q));
		const hits = {};
		for (const k of KS) hits[k] = fh >= 0 && fh < k ? 1 : 0;
		per.push({ hits, rr: fh >= 0 ? 1 / (fh + 1) : 0 });
		if (idTargets.has(q.query) && fh >= 0 && fh < 10) idHits++;
	}
	const r = (k) => mean(per.map((p) => p.hits[k])).toFixed(3);
	console.log(`[${name.padEnd(12)}] r@1=${r(1)} r@5=${r(5)} r@10=${r(10)} MRR=${mean(per.map((p) => p.rr)).toFixed(3)}  | id-heavy recovered: ${idHits}/${idTargets.size}`);
}
console.log(`\nReference: dense baseline r@5=0.577 ; the hybrid run's 'simple' lexical was r@5=0.327.`);
console.log(`If ngram lifts lexical a lot -> tokenization was the bottleneck (worth a content_tokens column).`);
console.log(`If nothing lifts it much -> FTS is structurally weak on sentence queries; favor rerank over hybrid.`);
