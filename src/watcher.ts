import chokidar, { type FSWatcher } from "chokidar";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectInfo, ResolvedConfig } from "./types.ts";
import { buildIgnoreMatcher, isSecretPath, languageForPath } from "./filtering.ts";
import { deleteFileChunks, loadManifest, manifestCompatible, saveManifest } from "./store.ts";
import { updateChangedFile } from "./indexer.ts";

const execFileAsync = promisify(execFile);

async function isGitRepo(root: string): Promise<boolean> {
	try {
		await execFileAsync("git", ["-C", root, "rev-parse", "--git-dir"], { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

export interface WatcherCallbacks {
	onIndexing?: (path: string) => void;
	onReady?: () => void;
	onBulkPending?: (count: number) => void;
	onError?: (error: unknown) => void;
}

export class CodeIndexWatcher {
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private pending = new Set<string>();
	// When the debounce window accumulates more than watcherBulkThreshold changes, auto-embed is
	// suspended. The watcher sets this flag and fires onBulkPending; /index update clears it.
	private bulkPending = false;
	// Cumulative count of files seen while in bulk-pending state (displayed in footer).
	private bulkCount = 0;
	// Serialize flushes: a debounce that fires while a flush is still awaiting embeddings must not
	// start a second concurrent flush (they would race on the manifest and orphan rows).
	private flushing: Promise<void> = Promise.resolve();

	constructor(
		private project: ProjectInfo,
		private config: ResolvedConfig,
		private ctx: ExtensionContext,
		private callbacks: WatcherCallbacks = {},
	) {}

	// Called by /index update after a successful update to clear the bulk-pending state.
	clearPending(): void {
		this.bulkPending = false;
		this.bulkCount = 0;
	}

	async start(): Promise<void> {
		if (this.watcher) return;
		const gitRepo = await isGitRepo(this.project.root);
		const ig = await buildIgnoreMatcher(this.project, this.config, gitRepo);
		this.watcher = chokidar.watch(this.project.root, {
			ignoreInitial: true,
			persistent: true,
			followSymlinks: false,
			ignored: (path) => {
				const rel = relative(this.project.root, path).replaceAll("\\", "/");
				if (!rel || rel.startsWith("..")) return false;
				if (ig.ignores(rel)) return true;
				if (isSecretPath(rel)) return true;
				if (!languageForPath(rel)) return true;
				return false;
			},
		});
		this.watcher.on("add", (p) => this.enqueue(p));
		this.watcher.on("change", (p) => this.enqueue(p));
		this.watcher.on("unlink", (p) => this.enqueue(p, true));
	}

	private enqueue(absPath: string, deleted = false): void {
		const rel = relative(this.project.root, absPath).replaceAll("\\", "/");
		if (!rel || rel.startsWith("..")) return;
		this.pending.add(deleted ? `!${rel}` : rel);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.flushing = this.flushing.then(() => this.flush());
		}, this.config.watcherDebounceMs);
	}

	private async flush(): Promise<void> {
		const items = [...this.pending];
		this.pending.clear();

		// If the debounce window accumulated more changes than the bulk threshold, suspend auto-embed
		// and notify the caller to show a warning. The user must run /index update manually.
		const threshold = this.config.watcherBulkThreshold;
		if (items.length > threshold) {
			this.bulkPending = true;
			this.bulkCount += items.length;
			this.callbacks.onBulkPending?.(this.bulkCount);
			return;
		}

		// If already in bulk-pending state, keep accumulating without auto-embedding until cleared.
		if (this.bulkPending) {
			this.bulkCount += items.length;
			this.callbacks.onBulkPending?.(this.bulkCount);
			return;
		}

		for (const item of items) {
			try {
				const deleted = item.startsWith("!");
				const rel = deleted ? item.slice(1) : item;
				this.callbacks.onIndexing?.(rel);
				const manifest = await loadManifest(this.project);
				const compatible = manifestCompatible(manifest, this.config);
				if (!manifest || !compatible.ok) {
					this.callbacks.onReady?.();
					continue;
				}
				if (deleted) {
					await deleteFileChunks(this.project, rel, manifest);
					await saveManifest(this.project, manifest);
				} else {
					await updateChangedFile(this.project, this.config, rel, this.ctx);
				}
				this.callbacks.onReady?.();
			} catch (error) {
				this.callbacks.onError?.(error);
			}
		}
	}

	async stop(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
		if (this.watcher) await this.watcher.close();
		this.watcher = undefined;
		await this.flushing.catch(() => undefined); // let any in-flight flush finish writing
	}
}
