import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Normalize a raw tag token: lowercase, trim, keep only [a-z0-9_-]. Returns undefined if nothing valid remains. */
export function normalizeTag(raw: string): string | undefined {
	const s = raw.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
	return s.length > 0 ? s : undefined;
}

interface TagFileResult {
	tags: Set<string>;
	description?: string;
}

/** Parse a single `.index_tag` file. `#` comment lines are skipped for tags; the first `#` comment
 *  line (stripped of the leading `#` and trimmed) is used as a human-readable description (truncated
 *  to ~120 characters to avoid layout issues). */
async function parseTagFile(absPath: string): Promise<TagFileResult> {
	let text: string;
	try {
		text = await readFile(absPath, "utf8");
	} catch {
		return { tags: new Set() };
	}
	const tags = new Set<string>();
	let description: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#")) {
			if (description === undefined) {
				const raw = trimmed.slice(1).trim();
				if (raw) description = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
			}
			continue;
		}
		for (const token of trimmed.split(/[\s,]+/)) {
			const tag = normalizeTag(token);
			if (tag) tags.add(tag);
		}
	}
	return { tags, description };
}

async function isDirectory(absPath: string): Promise<boolean> {
	try {
		return (await stat(absPath)).isDirectory();
	} catch {
		return false;
	}
}

interface TagFileEntry {
	tags: Set<string>;
	description?: string;
}

/** Walk directory tree rooted at `root`, collect all `.index_tag` files, return a map of dir→{tags,description}.
 *  Directory basenames in `excludeDirs` (e.g. node_modules, .git) are skipped entirely. */
async function collectTagFiles(root: string, excludeDirs: Set<string>): Promise<Map<string, TagFileEntry>> {
	const result = new Map<string, TagFileEntry>();

	async function walk(dir: string): Promise<void> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		if (names.includes(".index_tag")) {
			const { tags, description } = await parseTagFile(join(dir, ".index_tag"));
			result.set(dir, { tags, description });
		}
		await Promise.all(
			names.map(async (name) => {
				if (excludeDirs.has(name)) return;
				const child = join(dir, name);
				if (await isDirectory(child)) await walk(child);
			}),
		);
	}

	await walk(root);
	return result;
}

export interface TagResolver {
	/** Return the union of all tags declared in ancestor `.index_tag` files for the given project-relative path. */
	resolveTags(relPath: string): Set<string>;
	/** Whether any `.index_tag` files were found (i.e. the project uses tag declarations). */
	hasTags: boolean;
}

/**
 * Build a TagResolver for the given project root. Walks the directory tree once to read all `.index_tag`
 * files, then resolves per-file tags by walking the ancestor chain and taking the union.
 *
 * Designed to be constructed once per query — `.index_tag` files are few and the walk is lightweight.
 */
export async function buildTagResolver(projectRoot: string, excludeDirs: Set<string>): Promise<TagResolver> {
	const dirTagMap = await collectTagFiles(projectRoot, excludeDirs);

	function resolveTags(relPath: string): Set<string> {
		// Build absolute path from relPath (relPath uses forward slashes, cross-platform safe via join)
		const absPath = join(projectRoot, relPath);
		// Walk ancestor chain: start from the file's directory up to (and including) projectRoot
		const fileDir = dirname(absPath);
		const union = new Set<string>();
		let cur = fileDir;
		while (true) {
			const entry = dirTagMap.get(cur);
			if (entry) {
				for (const t of entry.tags) union.add(t);
			}
			if (cur === projectRoot) break;
			const parent = dirname(cur);
			if (parent === cur) break; // filesystem root guard
			cur = parent;
		}
		return union;
	}

	return { resolveTags, hasTags: dirTagMap.size > 0 };
}

export interface TagStats {
	/** Per-tag hit count across the given file paths. */
	perTag: Map<string, number>;
	/** Number of files with no tags at all. */
	untagged: number;
	/** Total file count. */
	total: number;
}

/**
 * Compute per-tag file counts and the untagged count by walking `filePaths` through `resolve`.
 * Purely path-based — never reads file contents.
 */
export function computeTagStats(filePaths: string[], resolve: (p: string) => Set<string>): TagStats {
	const perTag = new Map<string, number>();
	let untagged = 0;
	for (const p of filePaths) {
		const tags = resolve(p);
		if (tags.size === 0) {
			untagged++;
		} else {
			for (const t of tags) {
				perTag.set(t, (perTag.get(t) ?? 0) + 1);
			}
		}
	}
	return { perTag, untagged, total: filePaths.length };
}

export interface DeclaredTagInfo {
	/** Sorted project-relative directories that declare this tag. */
	dirs: string[];
	/** First `#` comment line from the .index_tag file(s) declaring this tag, if any. */
	description?: string;
}

/**
 * Walk the project tree, collect all `.index_tag` declarations, and return a sorted map of
 * tag → { dirs, description }. Used by `/index tags` and `list_code_tags`.
 */
export async function listDeclaredTags(projectRoot: string, excludeDirs: Set<string>): Promise<Map<string, DeclaredTagInfo>> {
	const dirTagMap = await collectTagFiles(projectRoot, excludeDirs);
	const tagToDirs = new Map<string, Set<string>>();
	const tagToDesc = new Map<string, string>();
	for (const [absDir, { tags, description }] of dirTagMap) {
		const relDir = absDir === projectRoot ? "." : absDir.slice(projectRoot.length + 1);
		for (const tag of tags) {
			if (!tagToDirs.has(tag)) tagToDirs.set(tag, new Set());
			tagToDirs.get(tag)!.add(relDir);
			// First description seen for this tag wins.
			if (description && !tagToDesc.has(tag)) tagToDesc.set(tag, description);
		}
	}
	const result = new Map<string, DeclaredTagInfo>();
	for (const [tag, dirs] of [...tagToDirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		result.set(tag, { dirs: [...dirs].sort(), description: tagToDesc.get(tag) });
	}
	return result;
}

/**
 * D3 filter semantics:
 * - `exclude_tags`: if the file's tags contain ANY exclude tag → filtered out. Untagged files are unaffected.
 * - `include_tags`: strict whitelist — only files with ANY include tag pass. Untagged files are excluded.
 * - Both empty → no filtering (pass-through).
 */
export function matchesTagFilter(
	fileTags: Set<string>,
	includeTags?: string[],
	excludeTags?: string[],
): boolean {
	if (excludeTags && excludeTags.length > 0) {
		if (excludeTags.some((t) => fileTags.has(t))) return false;
	}
	if (includeTags && includeTags.length > 0) {
		if (!includeTags.some((t) => fileTags.has(t))) return false;
	}
	return true;
}
