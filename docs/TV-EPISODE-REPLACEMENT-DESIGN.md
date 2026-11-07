# TV episode replacement

Replace Existing connects the conflict action and conversion workflow to the replacement executor, quarantine,
rollback and startup reconciliation.
Startup reconciles incomplete transactions before cleanup and retains associated staged media; ambiguous transactions
require manual review and retain their claims. A journal row or checksum field alone is not evidence that a file is safe.

## Invariants and prerequisites

- Never remove an original until a verified, durable quarantine copy exists. Never overwrite another file.
- Keep staged source media until the entire disc has been reconciled and every output and provenance record is durable.
- Capture and persist the original provenance, incoming assignment, all affected episode numbers, decision, paths,
  checksums, and operation identity. A path alone is not a file identity.
- Resolve each affected multi-episode file as a whole; reject conflicting or incomplete decisions rather than
  discarding other episode mappings. Revalidate decisions at the publication boundary.
- Prevent concurrent replacements, publication, Forget Disc, staging cleanup, and storage maintenance from changing
  transaction-owned data. Recheck paths, file identity, and symlinks before acting.
- The guarantees depend on the filesystem, storage hardware, and operating system honoring durability barriers.
  If required file or directory synchronization and atomic no-overwrite publication are unavailable or fail, stop
  and retain all copies. Do not claim protection against hardware that acknowledges writes it has not persisted.
- Quarantine is under `<workDir>/.autodisc/quarantine/`, outside all configured library roots. Validate both lexical
  and resolved paths, including symlinks and every output profile. Cross-filesystem operations require verified copies;
  a rename cannot be assumed to work across volumes.

## Proposed transaction and quarantine workflow

1. Revalidate the exact source, episode mapping, and existing regular file. Reject ambiguous source identity, a
   changed file, unexpected hard links or unsafe paths. Acquire an exclusive transaction/claim covering the affected
   paths and episodes. A stale claim must be recoverable.
2. Record `created` and immutable snapshots in a durable SQLite transaction before any filesystem mutation. Give the
   transaction unique, exclusive paths for the quarantine copy and candidate output. Snapshot old provenance instead
   of relying on rows that an update or Forget Disc might later remove.
3. Generate and validate the incoming candidate without removing the staged source. Place it on the target filesystem
   under a unique name. Verify media and SHA-256, sync its contents and directory entry, then durably record its
   identity and checksum. The current converter's temporary output and cleanup behavior do not establish this
   guarantee and must not be used as evidence without an appropriately designed wrapper.
4. Copy the original to an exclusively created quarantine path, even across filesystems. Hash the source and copy,
   verify equality and file identity, sync the copy and its directory entry, and persist the original checksum and
   location. If any verification or durability operation fails, leave the original and staged source untouched and
   surface the failure. Do not use a copy-then-unlink helper that has not verified and synced the copy.
5. Durably record `quarantined` only after the quarantine copy is verified and synced. Revalidate the original
   immediately before removing its library name. Use filesystem primitives with documented no-overwrite and durability
   semantics; sync affected directories. Keep the candidate and quarantine copy throughout.
6. Publish the verified candidate at a no-overwrite target, sync the file and directory, verify its identity and hash,
   then durably record `published`. Do not infer completion from the presence of a path or a job's last output.
7. Atomically update provenance and audit and mark `completed` in the same SQLite transaction after all outputs for
   the disc have been verified. Preserve the quarantine copy and its provenance. Completion of a multi-track job must
   not be inferred from a single output.

## States and recovery

The states are `created`, `candidate_ready`, `quarantined`, `published`, `completed`, `failed`, and `rolled_back`.
State changes follow verified durable evidence, not merely attempted operations. A crash can occur between any
filesystem action and a journal update, so recovery inspects and verifies all recorded paths and hashes rather than
trusting the state alone. Startup must reconcile transactions before generic interrupted-job recovery, task auto-resume,
or cleanup can mark jobs complete or remove work.

| State | Recovery behavior |
| --- | --- |
| `created` | Retain candidate, staged media, and any unverified quarantine file. Confirm the original is intact; retry or leave the task for review. |
| `candidate_ready` | Verify the candidate and original independently; resume or leave for review. |
| `quarantined` | Verify quarantine and candidate hashes. If safe, resume exclusive publication, or restore a verified original to an unoccupied library path. |
| `published` | Verify both published candidate and quarantine copy and reconcile provenance/audit atomically; otherwise retain all files and require review. |
| `failed` | Inspect the actual files and evidence; resume or restore only when identity and integrity can be proved. Report any ambiguous or missing copy. |
| `rolled_back` | Original was verified at its library location and persisted; retained quarantine and candidate files remain available. |
| `completed` | Published media and provenance were committed and verified; quarantine remains retained. |

Rollback must not delete an unexpected file or overwrite an occupied original path. If the original is absent and a
verified quarantine copy exists, restore via an exclusive copy, verify and sync it, then record `rolled_back`. If the
path is occupied or checksums differ, preserve every copy and require manual review. Recovery is idempotent and can
itself be interrupted at any step. Failure and recovery events need durable audit entries and visible errors.

## Implementation and verification checklist

- Integrate decision snapshots, claims, filesystem operations, provenance, job completion, and task cleanup without
  changing ordinary ripping, conversion, matching, or unrelated publication.
- Avoid treating the journal as a complete implementation: the new claims and atomic completion are not connected to
  filesystem execution, candidate identity and size evidence, or automated recovery.
- Add fault injection before and after each journal commit, file creation, copy, validation, sync, unlink, and
  publication. Restart recovery repeatedly at each boundary; assert original or verified quarantine remains, staged
  input remains until completion, and provenance is not lost.
- Test different filesystems, full disks, permissions, failed sync, changed files, symlinks, occupied destinations,
  duplicate requests, multiple episodes per file, multiple tracks, concurrent changes, and interrupted rollback.
- Use a real SQLite build and supported filesystems, plus process-kill and power-loss tests on representative systems.
  A mocked filesystem or a successful unit test cannot establish reboot durability.
