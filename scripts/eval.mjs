// Phase-0 retrieval-quality baseline for the semantic code index.
// Chunk-granular recall@{1,5,10} + MRR with a bootstrap noise band, so a later phase's gain can be
// judged against noise rather than any positive delta. Dense-only here; the FTS/hybrid column is
// added in Phase 1 once an FTS index exists. Run: node scripts/eval.mjs [repoRoot] (default cwd).
import * as lancedb from "@lancedb/lancedb";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extDir = dirname(scriptDir);
const root = resolve(process.argv[2] || process.cwd()); // the indexed repo
const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
const dataDir = join(agentDir, "code-index");
const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
const manifestPath = join(dataDir, "indexes", hash, "manifest.json");
const lancedbDir = join(dataDir, "indexes", hash, "lancedb");
// Labeled queries live next to the harness (they target a specific repo), not inside that repo.
const queries = JSON.parse(readFileSync(join(extDir, "eval", "queries.json"), "utf8"));

const globalConfig = existsSync(join(dataDir, "config.json")) ? JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) : {};
const provider = globalConfig.provider || "voyage";
const presets = {
	voyage: { baseUrl: "https://api.voyageai.com/v1/embeddings", model: "voyage-code-3", apiKeyEnv: "VOYAGE_API_KEY" },
	openrouter: { baseUrl: "https://openrouter.ai/api/v1/embeddings", model: "openai/text-embedding-3-large", apiKeyEnv: "OPENROUTER_API_KEY" },
	local: { baseUrl: "http://127.0.0.1:11434/v1/embeddings", model: "nomic-embed-text" },
};
const preset = presets[provider] || presets.voyage;
const baseUrl = globalConfig.baseUrl || preset.baseUrl;
const model = globalConfig.model || preset.model;
const apiKeyEnv = globalConfig.apiKeyEnv || preset.apiKeyEnv;
const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

if (!existsSync(manifestPath)) {
	console.error(`No index for ${root}. Open pi there and run /index reindex first.`);
	process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.model !== model || manifest.baseUrl !== baseUrl) {
	console.error(`Index model/provider mismatch: manifest=${manifest.model} current=${model}. Run /index reindex.`);
	process.exit(2);
}
if (provider !== "local" && !apiKey) {
	console.error(`Missing ${apiKeyEnv}`);
	process.exit(2);
}

// Query-side embedding uses input_type=query for Voyage (asymmetric encoding; matches production).
async function embed(input) {
	const headers = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const body = { model, input };
	if (provider === "voyage") body.input_type = "query";
	const res = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`embedding failed ${res.status}: ${await res.text()}`);
	return (await res.json()).data[0].embedding;
}

// Chunk-granular hit: retrieved chunk's file is an expected path AND (when expectedLines given) its
// [startLine,endLine] overlaps the expected range. Falls back to path-only when no lines are labeled.
function chunkHit(chunk, q) {
	if (!q.expectedPaths.includes(chunk.path)) return false;
	if (!Array.isArray(q.expectedLines) || q.expectedLines.length !== 2) return true;
	const [es, ee] = q.expectedLines;
	return chunk.startLine <= ee && chunk.endLine >= es; // interval overlap
}

// Deterministic PRNG so the bootstrap band is reproducible run-to-run (Math.random would not be).
function mulberry32(seed) {
	return function () {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function bootstrapBand(values, B = 2000) {
	const rand = mulberry32(0x5eed);
	const means = [];
	for (let b = 0; b < B; b++) {
		let s = 0;
		for (let i = 0; i < values.length; i++) s += values[Math.floor(rand() * values.length)];
		means.push(s / values.length);
	}
	means.sort((a, b) => a - b);
	return [means[Math.floor(B * 0.025)], means[Math.floor(B * 0.975)]];
}

const KS = [1, 5, 10];
const FETCH = 20;
const db = await lancedb.connect(lancedbDir);
const table = await db.openTable("chunks");

// Phase 1: build an FTS index on `content` — content-derived, ZERO embedding calls (reuses stored
// vectors). Idempotent: skip if it already exists. simple tokenizer + lowercase + asciiFolding.
let ftsReady = false;
try {
	const existing = await table.listIndices().catch(() => []);
	if (!existing.some((i) => (i.columns || []).includes("content"))) {
		await table.createIndex("content", { config: lancedb.Index.fts({ baseTokenizer: "simple", lowercase: true, asciiFolding: true }) });
	}
	await table.optimize();
	ftsReady = true;
	console.log("FTS index on `content` ready (simple, lowercase, asciiFolding).");
} catch (e) {
	console.log(`! FTS unavailable, dense-only: ${e.message}`);
}
const rrf = ftsReady ? await lancedb.rerankers.RRFReranker.create().catch(() => null) : null;

function score(rows, q) {
	const ranked = rows.map((r) => ({ path: r.path, startLine: r.startLine, endLine: r.endLine }));
	const firstHit = ranked.findIndex((c) => chunkHit(c, q));
	const hits = {};
	for (const k of KS) hits[k] = firstHit >= 0 && firstHit < k ? 1 : 0;
	return { rr: firstHit >= 0 ? 1 / (firstHit + 1) : 0, hits, firstHit };
}

const cols = { dense: [], lexical: [], hybrid: [] };
let lexErr, hybErr;
for (const q of queries) {
	const vector = await embed(q.query);
	const dense = score(await table.vectorSearch(vector).limit(FETCH).toArray(), q);
	cols.dense.push(dense);
	let lex = null, hyb = null;
	if (ftsReady) {
		try {
			lex = score(await table.query().fullTextSearch(q.query, { columns: ["content"] }).limit(FETCH).toArray(), q);
			cols.lexical.push(lex);
		} catch (e) { if (!lexErr) console.log(`! lexical failed: ${(lexErr = e.message)}`); }
		if (rrf) {
			try {
				hyb = score(await table.query().nearestTo(vector).fullTextSearch(q.query, { columns: ["content"] }).rerank(rrf).limit(FETCH).toArray(), q);
				cols.hybrid.push(hyb);
			} catch (e) { if (!hybErr) console.log(`! hybrid failed: ${(hybErr = e.message)}`); }
		}
	}
	const mark = (s) => (s ? (s.hits[5] ? "✓" : s.firstHit >= 0 ? `#${s.firstHit + 1}` : "✗") : "-");
	console.log(`D:${mark(dense).padEnd(3)} L:${mark(lex).padEnd(3)} H:${mark(hyb).padEnd(3)}  ${String(q.query).slice(0, 58)}`);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function report(name, arr) {
	if (!arr.length) return console.log(`\n[${name}] (no results)`);
	console.log(`\n[${name}] n=${arr.length}`);
	for (const k of KS) {
		const vals = arr.map((p) => p.hits[k]);
		const [lo, hi] = bootstrapBand(vals);
		console.log(`  recall@${k.toString().padStart(2)} = ${mean(vals).toFixed(3)}  [95% ${lo.toFixed(3)}-${hi.toFixed(3)}]`);
	}
	console.log(`  MRR     = ${mean(arr.map((p) => p.rr)).toFixed(3)}`);
}
console.log(`\n=== ${provider} ${model} | ${queries.length} queries | index ${manifest.fileCount}f/${manifest.chunkCount}c | chunk-granular ===`);
report("dense (v1 baseline)", cols.dense);
report("lexical (FTS only)", cols.lexical);
report("hybrid (dense+FTS RRF)", cols.hybrid);
console.log(`\nGate: hybrid passes Phase 1 only if its recall@k mean clears the dense band's upper edge (gain > noise).`);
