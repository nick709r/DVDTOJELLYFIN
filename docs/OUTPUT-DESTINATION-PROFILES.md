# Output Destination Profiles

AutoDisc stores named output profiles and one active profile. Each supported
media workflow has one selected destination; AutoDisc publishes to that
destination rather than making duplicate copies:

- TV DVDs can route to Jellyfin, a Sonarr-compatible series folder, or a
  generic folder.
- Movie DVDs can route to Jellyfin, a Radarr-compatible movie folder, or a
  generic folder.
- Audio CDs can route to Jellyfin, the configured Lidarr integration, or a
  generic folder.

Sonarr and Radarr selections create compatible directory/file layouts; this
release does not integrate with their APIs. Lidarr selection uses its existing
API integration and import staging directory. AutoDisc does not yet publish
audiobooks, concerts, documentaries, anime, or music videos.

For Jellyfin, set a library root to inherit `TV Shows`, `Movies`, and `Music`
subdirectories. A nonempty per-category path overrides the inherited location.
Generic folders and ARR-compatible roots are configured only when their route
is selected. Profiles can be created, renamed, selected, and deleted in
Settings. New paths are checked and created when a profile is saved.

Migration 21 creates a `Jellyfin Server` profile using existing `tvRootDir`,
`moviesDir`, and `musicDir` values. If Lidarr was already enabled, the migrated
Music route remains Lidarr. Existing settings fields remain as compatibility
values for older code and API clients; changing those paths through the legacy
settings API also updates the active Jellyfin route. Migration 22 persists
`regular_auto` as the default automation mode.

## Automation modes

- **Full Auto** processes automatically, ejects after success, and ejects after
  a failed/review-required job has been recorded in Review so detection can
  continue. Eject failures are also recorded in Review.
- **Regular Auto** processes automatically and leaves a failed disc in the
  drive for investigation. The existing successful-job eject setting remains
  available.
- **Review-Based** detects media but does not rip or process it until an
  administrator chooses **Approve & Process** in Review Centre. Approval
  re-inspects the drive and verifies that the inserted media still matches the
  detected disc before starting the workflow. Keep the disc inserted until
  approval; a different or removed disc cannot be processed through the
  pending approval.

Destination profiles are returned by `GET /api/v1/settings` and saved with
`PUT /api/v1/settings` as `outputDestinations`. The object contains
`activeProfileId` and up to 20 named profiles, each with category routes,
Jellyfin root/overrides, Sonarr/Radarr/Lidarr roots, and generic folder paths.
The API validates profile identifiers, route-target compatibility, absolute
paths, and writability of the active destinations. Use
`POST /api/v1/reviews/:id/approve-process` to approve a queued disc.

The application runs inside the host/container environment; paths must be
visible from AutoDisc. The authenticated **Browse** picker lists visible
subdirectories on that host/container, while direct path entry remains
available.
