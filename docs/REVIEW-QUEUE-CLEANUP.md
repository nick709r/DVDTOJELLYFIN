# Review Queue Cleanup

Review Queue deletion is permanent and is intentionally separate from dismissing a notification.

## Deletion flow

```text
User selects Delete
  -> API validates review/job ownership and rejects active work
  -> Impact endpoint inventories only verified job, TV staging, and review-workspace paths
  -> User confirms Delete Everything
  -> Owned files are removed; shared output/cache paths are excluded
  -> A SQLite transaction removes that job's review records, task data, history, and exclusive fingerprint records
  -> The result reports deleted files, recovered bytes, deleted records, and any errors
```

Filesystem deletion precedes database deletion because a failed path cleanup must leave the review record available for retry. If a filesystem error occurs after some files have been deleted, the remaining database records are retained and the result reports the partial cleanup.

## Ownership and protected resources

- A review item's `related_job_id` must resolve to the same job record; active jobs and processing review tasks cannot be deleted.
- Job temporary data, TV staging, and review workspaces are only eligible when their paths match the expected root and UUID owner recorded by the application.
- Symlinks, unsafe paths, paths outside the expected owner directory, and paths overlapping configured publishing roots block cleanup.
- Published outputs, global TV provider caches, application settings, and fingerprint records referenced by another job/review/task are retained.
- Append-only disk classification audit entries are retained, matching the database's audit-history policy.
- Per-fingerprint recovery, matching, feedback, and override records are deleted only when no other job, review, or TV task references that fingerprint.
- Clearing a review notification only hides/dismisses the notification; it does not delete the preserved media or processing history.

## Orphaned data

Startup scans the work directory, review workspaces, and TV staging root for untracked UUID directories. Untracked temporary data is retained and surfaced in the Review Queue. Cleanup requires an explicit confirmation and repeats ownership and output-path checks immediately before removing each item.

Orphan scanning intentionally does not search arbitrary library directories or delete paths recorded as published outputs. Global provider caches are not attributed to individual review items and are never included in deletion impact.

## Recovery statistics

The impact report counts owned regular files and estimates recoverable bytes before confirmation. The completion result counts files actually unlinked and bytes belonging to unique, non-hard-linked files. Hard-linked files are removed only from the owned directory and are not counted as reclaimed storage when another link may retain their data.
