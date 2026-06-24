import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Normalize a raw tag token: lowercase, trim, keep only [a-z0-9_-]. Returns undefined if nothing valid remains. */
export function normalizeTag(raw: string): string | undefined {
	const s = raw.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
	return s.length > 0 ? s : undefined;
}

/** Parse a single `.index_tag` file into a Set of normalized tags. Lines starting with `#` are comments. */
async function parseTagFile(absPath: string): Promise<Set<string>> {
	let text: string;
	try {
		text = await readFile(absPath, "utf8");
	} catch {
		return new Set();
	}
	const tags = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		for (const token of trimmed.split(/[\s,]+/)) {
			const tag = normalizeTag(token);
			if (tag) tags.add(tag);
		}
	}
	return tags;
}

async function isDirectory(absPath: string): Promise<boolean> {
	try {
		return (await stat(absPath)).isDirectory();
	} catch {
		return false;
	}
}

/** Walk directory tree rooted at `root`, collect all `.index_tag` files, return a map of dir→Set<tag>. */
async function collectTagFiles(root: string): Promise<Map<string, Set<string>>> {
	const result = new Map<string, Set<string>>();

	async function walk(dir: string): Promise<void> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		if (names.includes(".index_tag")) {
			const tags = await parseTagFile(join(dir, ".index_tag"));
			result.set(dir, tags);
		}
		await Promise.all(
			names.map(async (name) => {
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
}

/**
 * Build a TagResolver for the given project root. Walks the directory tree once to read all `.index_tag`
 * files, then resolves per-file tags by walking the ancestor chain and taking the union.
 *
 * Designed to be constructed once per query — `.index_tag` files are few and the walk is lightweight.
 */
export async function buildTagResolver(projectRoot: string): Promise<TagResolver> {
	const dirTagMap = await collectTagFiles(projectRoot);

	function resolveTags(relPath: string): Set<string> {
		// Build absolute path from relPath (relPath uses forward slashes, cross-platform safe via join)
		const absPath = join(projectRoot, relPath);
		// Walk ancestor chain: start from the file's directory up to (and including) projectRoot
		const fileDir = dirname(absPath);
		const union = new Set<string>();
		let cur = fileDir;
		while (true) {
			const tags = dirTagMap.get(cur);
			if (tags) {
				for (const t of tags) union.add(t);
			}
			if (cur === projectRoot) break;
			const parent = dirname(cur);
			if (parent === cur) break; // filesystem root guard
			cur = parent;
		}
		return union;
	}

	return { resolveTags };
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
