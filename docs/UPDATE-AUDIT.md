# AutoDisc Update Pipeline Audit

## Summary

The Linux in-app updater does more than request a service restart. It downloads a tagged source archive, builds it in a temporary directory, stages the built application, replaces `/opt/autodisc`, updates the systemd helper files, and then starts the service. The updater runs as root for the replacement; download and build commands run as the `autodisc` service user.

The immediate installation blocker was a shell quoting error in the updater helper: a single-quoted `node -p` expression was nested inside the single-quoted script passed to `sh -c`. That terminated the command string early, so the helper failed shell parsing before it could download or replace files. The nested expression is now unquoted and the helper passes `sh -n`.

There was also a separate verification gap: the helper marked the update successful when systemd reported the service active, without comparing the version reported by the newly running process with the requested target. The UI also treated that helper status as a verified success. The updater now records structured phase diagnostics, verifies copied files before restart, and compares the running process version with the requested version after restart.

## End-to-end flow

1. **Check for updates** — `GET /api/v1/updates/check` calls the GitHub tags API, ignores non-semver tags and prereleases, and selects the highest stable version using numeric semver comparison. The current version is read from the process's installed package manifest. The selected install asset is the GitHub source archive for that tag; this is not a separately published binary release asset.
2. **Release notes** — The API loads GitHub release notes or falls back to the matching release-history section in `README.md`.
3. **Queue the update** — `POST /api/v1/updates/apply` repeats release discovery, refuses if a disc job is active or the target is no longer newer, then atomically writes the target tag to `/var/lib/autodisc/updater/request`.
4. **Trigger the helper** — `autodisc-update.path` watches for the request and starts the oneshot `autodisc-update.service`.
5. **Download and validate** — The root helper validates the target against the latest stable GitHub tag. It creates a temporary build workspace under `/opt`, grants that workspace to `autodisc`, downloads the target tag's `.tar.gz` archive over HTTPS as `autodisc`, and validates that it is a non-empty readable tar archive.
6. **Build** — As `autodisc`, the helper extracts the archive, verifies the source `package.json` version matches the requested tag, runs `npm ci`, builds TypeScript, and prunes development dependencies.
7. **Install and replace files** — As root, the helper creates `/opt/autodisc.next.*`, copies the package manifests, source, web assets, build output, and production dependencies, and changes ownership to `root:root`. It then stops AutoDisc, moves the old `/opt/autodisc` to `/opt/autodisc.rollback`, and moves the completed staging directory into `/opt/autodisc`. Before restarting, it verifies the installed manifest version and compares the installed manifest and `dist/index.js` with the staged build.
8. **Restart** — Only after the replacement and file comparisons complete does the helper reload systemd units, restart the updater path watcher, and start `autodisc.service`. It waits for the service to become active.
9. **Version verification** — Once the new service responds to `/api/v1/updates/status`, the running process version is compared with the persisted requested target. A mismatch is returned and logged as a failed update verification rather than a successful update.
10. **Rollback** — Any helper failure before successful completion invokes the exit trap. It records failure, restores the previous application and snapshots when available, and attempts to restart the previous service.

## Diagnostics and logging

The helper emits one-line JSON records to the `autodisc-update.service` journal. Records include `currentVersion`, `targetVersion`, `releaseFound`, `assetSelected`, `downloadStarted`, `downloadCompleted`, `installStarted`, `installCompleted`, `restartRequested`, `restartCompleted`, and the final verification event. Failure records include an error and phase states.

The UI's **Settings → AutoDisc updates** panel displays:

- Current running version
- Requested target version
- Download state
- Install state
- Last update error

The status API persists phase data at `/var/lib/autodisc/updater/diagnostics.json`. The helper's journal remains the source for detailed command output:

```sh
sudo journalctl -u autodisc-update.service
sudo journalctl -u autodisc.service
```

## Linux permissions

- `autodisc-update.service` runs as `root:root`, with systemd write access to `/opt`, `/etc/systemd/system`, `/usr/local/libexec`, and `/var/lib/autodisc`.
- The build workspace is temporarily owned by `autodisc`; network download and npm build work do not run as root.
- Installed application files and systemd unit files are owned by root.
- The application runs as `autodisc`. The updater request and status directory is provisioned as `root:autodisc` mode `1770`; the application can create its request and read updater reports without write access to the application tree.

If in-app updates fail with a permissions error, verify the installer-created unit and directory permissions rather than running the AutoDisc service as root.

## Failure conditions

The helper reports failure and attempts rollback if the request is invalid, GitHub cannot be reached, the target is no longer the latest stable tag, download or archive validation fails, the archive manifest version differs from the requested tag, dependency installation/build/pruning fails, staging or file comparison fails, systemd cannot reload/start the service, or the service does not become active. Shell parse errors prevent the helper from starting at all; run `sh -n /usr/local/libexec/autodisc-update` when diagnosing that class of failure.

After restart, if the process reports a version different from the requested version, the status endpoint records `verificationState: failed`, reports the mismatch in the UI, and logs `verificationFailed`. A systemd-active result alone is not treated by the UI as proof that the correct version is running.

## Integrity limitation

The updater uses GitHub HTTPS transport, validates the archive structure and package version, builds the source, and verifies key files after replacement. It does not currently verify a separately published cryptographic checksum or signature for the source archive. A signed release artifact and pinned checksum/signature verification would provide stronger supply-chain integrity.
