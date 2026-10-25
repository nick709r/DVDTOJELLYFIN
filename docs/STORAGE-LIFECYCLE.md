# Storage Lifecycle

AutoDisc's Storage Manager inventories application-owned workspaces, estimates recoverable space, and offers explicit cleanup previews. It does not manage or delete published library media.

## Storage architecture

`StorageLifecycleService` walks configured AutoDisc work and staging roots without following symbolic links. Files are classified into non-overlapping categories:

| Category | Inventory |
| --- | --- |
| Review Queue Data | Owned review workspace media and metadata |
| Unmatched TV Content | Staged content for TV matching tasks that still need identification or mapping |
| Temporary Conversion Files | Inactive job work files and generated `.autodisc-<jobId>-<uuid>.<format>` output files |
| Artwork Cache | Artwork in owned review workspaces |
| Metadata Cache | TV metadata cache rows in SQLite; this is a logical payload estimate |
| Orphaned Data | Untracked UUID workspaces under the configured work, review, or TV staging roots |
| Staged Rips | Rip subdirectories in inactive job workspaces |
| Failed Processing Jobs | Temporary workspaces for failed jobs without preserved review work |
| Temporary Logs | Logs in inactive job and review workspaces |

Active jobs, processing TV tasks, and processing review workspaces are counted separately as **Active Processing**. Published media is excluded from the inventory and shown as protected. Hard-linked files are counted once; recoverable estimates account for whether all links to a file are included in the selected cleanup.

The Storage Manager page provides a summary, category breakdown, cleanup actions, an orphan list with path/size/age/original job where known, and largest consumers. The dashboard shows the same storage summary and warns when Review Queue workspace storage reaches the configured threshold. Review Queue entries show staged, artwork, metadata, and total workspace sizes.

## Cleanup rules

Every cleanup action has a preview with item count, file count, estimated reclaimable space, and an impact summary. The user must explicitly confirm before the API performs cleanup.

The lifecycle service revalidates ownership immediately before removing files:

- Job workspaces must remain under the configured work directory and their job must still exist and be inactive.
- Review workspaces must match the recorded review ID and configured workspace path; review cleanup is delegated to `ReviewQueueCleanupService`.
- Generated output temp files must include the owning job ID, be beside that job's recorded output path, and belong to an inactive job.
- Orphaned workspaces must still be untracked and are removed by the ownership-checked orphan cleanup service.
- Symlinks, changed file identities, paths outside an owned root, and paths that overlap protected library roots are rejected.

`Clean Failed Jobs` removes owned temporary files while retaining job history and audit records; rip directories remain in the protected Staged Rips category. `Clean Everything Safe` excludes unrelated unmatched TV content and staged rips. Review Queue cleanup may remove only staged files explicitly owned by a selected review item, using the review deletion ownership checks. Review Queue deletion uses the existing cleanup service so shared fingerprints, published media, and unrelated jobs remain protected.

Deleting metadata cache rows does not delete or vacuum the SQLite database. SQLite may reuse the freed pages internally, but the database file does not shrink as a result; the UI reports this as reusable cache data rather than disk space physically recovered.

## Protected resources

No Storage Manager cleanup action may remove:

- Published movies, TV episodes, music, or output-library directories.
- Jellyfin, Sonarr, Radarr, or Lidarr library content.
- Active processing files, active child-process outputs, or a retrying review workspace.
- Application settings, SQLite databases, job history, or audit records.
- Shared fingerprint resources or files whose ownership cannot be verified.
- Unmatched TV content or staged rips through bulk cleanup.

Scheduled maintenance never removes review items, unmatched TV content, staged rips, job history, or published media.

## Recoverable resources

Manual actions can remove owned review data, artwork, metadata cache rows, inactive conversion work, failed-job workspaces, temporary logs, and validated orphaned workspaces. Failed-job cleanup preserves the database history row. Review Queue cleanup may remove associated records and job-owned temporary work according to the established review deletion ownership rules.

Storage sizes are estimates based on file sizes and inode/link information. A hard-linked file is only counted once, and its space is considered reclaimable only when all links are in the selected owned set. Metadata cache sizes estimate serialized payload size, not an immediate reduction in the SQLite file's size.

## Automatic maintenance

Maintenance runs at startup and once every 24 hours while AutoDisc is running:

- **Temporary logs:** removes only inactive generated log files older than the configured age.
- **Failed conversion temp files:** removes only exact AutoDisc-generated output temp files that are older than the configured age and whose owning job is failed.

Both settings default to disabled (`Never`). Blank age values disable the corresponding scheduled cleanup. No other category is eligible for automatic cleanup.

The Review Queue warning can be disabled or configured for 50, 100, 250, or 500 GB. It is informational and never triggers automatic deletion.

## API

All endpoints require the normal authenticated application session:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/storage/summary` | Total, recoverable, active-processing, categories, and Review Queue warning data |
| `GET` | `/api/v1/storage/categories` | Category item/size/reclaimable breakdown |
| `GET` | `/api/v1/storage/largest?limit=10` | Largest individual consumers |
| `GET` | `/api/v1/storage/orphans` | Orphan path, size, age, and known original job |
| `GET` | `/api/v1/storage/review-sizes` | Per-review staged/artwork/metadata/total bytes |
| `GET` | `/api/v1/storage/impact/:category` | Cleanup preview; also accepts `everything-safe` |
| `POST` | `/api/v1/storage/cleanup/:category` | Confirmed category cleanup |

Cleanup POST requests require `{ "confirmed": true }`. The `everything-safe` category is handled by the same endpoint. Unmatched TV content and staged rips are deliberately rejected by bulk cleanup.

## Database and migration considerations

No schema migration is required. Warning and retention settings are stored in the existing SQLite settings key/value table and are overlaid with defaults for existing installations. The metadata cache is an existing table; cleanup deletes only its cache rows and retains the database and lookup audit data.

Generated conversion output temp names now include the job ID. Existing temp files created before this change do not have an ownership token and are not eligible for Storage Manager deletion.

## Troubleshooting

- **A category reports errors:** Review the application log's `storage-lifecycle` entries. Ownership failures are intentional safety stops; refresh the inventory after resolving moved paths or active jobs.
- **A cleanup estimate exceeds the actual recovered amount:** Files may have external hard links, a concurrently changed workspace, or belong to SQLite pages that remain allocated to the database file.
- **An orphan is not listed:** Only recognized UUID workspaces directly inside configured AutoDisc work/review/staging roots are considered. Arbitrary directories and paths outside those roots are not automatically claimed.
- **A temp output is not listed:** It must use the current job-owned filename format and match an inactive job's recorded output directory and extension.
- **Scheduled cleanup did not run:** Check that the corresponding retention age is set, the application has reached startup or its daily maintenance interval, and the files are older than that age.
- **Published media appears in a cleanup preview:** Do not confirm. The ownership and protected-root checks should exclude it; report the path and associated job so the path classification can be corrected.
