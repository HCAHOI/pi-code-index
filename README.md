# pi-code-index

Semantic code search extension for pi. Chunks source files, embeds them via a configurable
embedding provider, and exposes a `semantic_code_search` tool that lets the agent find code by
intent rather than by exact keywords.

## Quick start

```
/index on        # enable and build the index (prompts for cost confirmation)
/index status    # show file/chunk counts and config
```

## Subcommands

| Command | Description |
|---|---|
| `/index status` | Show index state, file/chunk counts, provider, and config |
| `/index on` | Enable indexing for the current project; builds the index if none exists |
| `/index off` | Disable indexing and stop the file watcher |
| `/index update` | Incremental sync — removes excluded/deleted chunks (free), embeds new/changed files (with cost confirmation) |
| `/index reindex` | Full rebuild from scratch (always confirms cost before proceeding) |
| `/index clear` | Wipe the index without disabling |
| `/index config` | Open the interactive settings wizard |
| `/index help` | Show subcommand and ignore-layer reference |

## Ignore layers

Files are included in the index only if they pass **all** of the following layers, evaluated in
order from most to least authoritative:

1. **git** (git repo only) — git's own ignore machinery covers four sub-layers automatically:
   - `.gitignore` at the repo root
   - Nested `.gitignore` files in subdirectories
   - Global excludes (`core.excludesFile`, typically `~/.config/git/ignore`)
   - Repo-local excludes (`.git/info/exclude`)
2. **`.indexignore`** — project-local extra excludes, applied on top of git. Add paths here to
   narrow what gets indexed without touching git ignore rules.
3. **`.contextignore`** — shared context exclusions (read by other pi context tools as well).
4. **`excludeDirs` config** — built-in directory exclusions (`node_modules`, `dist`, `.git`, etc.).
5. **Extension and secret filters** — only files with configured `includeExtensions` are indexed;
   files matching secret basename patterns (`.env*`, `*.pem`, `id_rsa`, etc.) or containing
   known secret-content patterns are always skipped.

Non-git projects fall back to fast-glob + the `ignore` package reading the root `.gitignore`
only (nested `.gitignore` and global excludes are not available in this mode).

### `.indexignore` format

Same syntax as `.gitignore`:

```
# ignore a noisy data directory
fixtures/large-dataset/

# ignore generated files
src/generated/
*.pb.go
```

### `.contextignore` format

Same syntax as `.gitignore`. Shared with other context tools — prefer `.indexignore` for
index-specific exclusions.

## Cost model

| Operation | Cost | Trigger |
|---|---|---|
| Delete chunks (file excluded or deleted) | Free | Automatic (watcher) or `/index update` |
| Embed changed/new files (few) | Small | Watcher auto-incremental (already authorized) |
| Embed bulk new files | Larger | `/index update` — confirms before proceeding |
| Full reindex | Largest | `/index reindex` only — always confirms |
| Schema/scope change | — | Prompts to reindex; never automatic |

The watcher auto-embeds individual file changes as you edit. When a debounce window accumulates
more than `watcherBulkThreshold` (default 50) file changes — e.g. after a branch switch, an
`npm install`, or unpacking a dataset — auto-embed is **suspended** and the footer shows a yellow
warning: `idx: ⚠ N changed · /index update`. Run `/index update` to review and apply the changes
with cost confirmation.

## Configuration

Run `/index config` to open the interactive settings wizard. Key options:

| Setting | Default | Description |
|---|---|---|
| `provider` | `voyage` | Embedding provider (`voyage`, `openrouter`, `local`, `custom`) |
| `watcherBulkThreshold` | `50` | File-change count above which auto-embed is suspended |
| `watcherDebounceMs` | `1000` | Debounce window for batching watcher events (ms) |
| `largeRepoConfirmChunks` | `5000` | Chunk count above which reindex always confirms |
| `chunkLines` | `80` | Lines per chunk window |
| `chunkOverlap` | `20` | Overlap between consecutive chunk windows (lines) |
| `maxFileBytes` | `786432` | Files larger than this are skipped |
| `maxChunkChars` | `12000` | Max characters per chunk |
| `includeExtensions` | (many) | File extensions to index |
| `excludeDirs` | (many) | Directory names always excluded |

API keys are read from environment variables only (e.g. `VOYAGE_API_KEY`). Literal key values are
never stored.
