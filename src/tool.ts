import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { embedTexts } from "./embeddings.ts";
import { resolveConfig } from "./config.ts";
import { getProjectInfo } from "./project.ts";
import { loadManifest, manifestCompatible, searchIndex } from "./store.ts";

function snippet(content: string): string {
	const lines = content.trim().split(/\r?\n/).slice(0, 8);
	return lines.map((l) => `   ${l.length > 180 ? `${l.slice(0, 177)}...` : l}`).join("\n");
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function matchesFilters(path: string, params: { path?: string; include?: string[]; exclude?: string[] }): boolean {
	if (params.path && !path.startsWith(params.path)) return false;
	if (params.include?.length && !params.include.some((p) => path.includes(p))) return false;
	if (params.exclude?.length && params.exclude.some((p) => path.includes(p))) return false;
	return true;
}

export function registerSemanticSearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "semantic_code_search",
		label: "Semantic Code Search",
		description: "Search the enabled codebase index by meaning/intent when exact keywords or symbol names are unknown.",
		promptSnippet: "Search the codebase semantically by intent when exact keywords are unknown",
		promptGuidelines: [
			"Use semantic_code_search only for intent-based code discovery when you do not know the exact filename, keyword, or symbol name.",
			"Use ffgrep for exact text or identifier search, fffind for file/path discovery, and lsp_navigation for definitions/references instead of semantic_code_search.",
			"The index only covers files that pass all ignore layers: git (root + nested .gitignore, core.excludesFile, .git/info/exclude), then .indexignore, then .contextignore. Add paths to .indexignore to narrow indexing scope without touching git rules.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language description of the code you are looking for" }),
			top_k: Type.Optional(Type.Number({ description: "Max results to return (default 8). Raise to scan broadly, lower for precision; clamped to the configured maxTopK." })),
			path: Type.Optional(Type.String({ description: "Optional path prefix to restrict results" })),
			include: Type.Optional(Type.Array(Type.String(), { description: "Optional substring filters that paths must include" })),
			exclude: Type.Optional(Type.Array(Type.String(), { description: "Optional substring filters that paths must not include" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const project = await getProjectInfo(ctx.cwd);
			const { project: state, resolved } = await resolveConfig(project);
			if (!project.safe) return textResult(`Code index unavailable: ${project.reason}`);
			if (!state.enabled) return textResult("Code index is disabled for this project. Run `/index on` to enable it.");
			const manifest = await loadManifest(project);
			const compatible = manifestCompatible(manifest, resolved);
			if (!manifest) return textResult("Code index is not built yet. Run `/index reindex` to build it.");
			if (!compatible.ok) return textResult(`Code index is stale: ${compatible.reason}. Run /index reindex before searching.`);
			if (!resolved.apiKeyPresent && resolved.provider !== "local") return textResult(`Missing API key env ${resolved.apiKeyEnv}. Configure it or run /index config.`);
			// final-k returned to the agent: the agent chooses freely, clamped only by configured maxTopK.
			const topK = Math.max(1, Math.min(resolved.maxTopK, Math.floor(params.top_k ?? 8)));
			const embedded = await embedTexts(resolved, [params.query], signal, "query");
			if (embedded.dimension !== manifest.embeddingDim) return textResult(`Query embedding dimension ${embedded.dimension} does not match index dimension ${manifest.embeddingDim}. Run /index reindex.`);
			// Candidate pool for post-filtering, capped so a large top_k can't blow up the scan. v2: this
			// is where rerank's candidate-N gets decoupled from final-k to bound rerank cost.
			const raw = await searchIndex(project, embedded.vectors[0], Math.min(Math.max(topK * 5, topK), 256));
			// scoreThreshold (0 = off) trims low-relevance noise before the final-k cut; score is a
			// similarity in (0,1] so higher passes. Lifts precision / agent signal, not recall.
			const results = raw
				.filter((r) => matchesFilters(r.path, params))
				.filter((r) => r.score >= resolved.scoreThreshold)
				.slice(0, topK);
			if (results.length === 0) return textResult("No semantic code search results found.", { results: [] });
			const text = results
				.map((r, i) => `${i + 1}. ${r.path}:${r.startLine}-${r.endLine} score=${r.score.toFixed(3)}${r.symbol ? ` symbol=${r.symbol}` : ""}\n${snippet(r.content)}`)
				.join("\n\n");
			return textResult(text, { results });
		},
	});
}
