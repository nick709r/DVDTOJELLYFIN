# AutoDisc

AutoDisc is a headless, single-drive DVD ingestion appliance for Linux and
Jellyfin. It watches a configured optical drive, uses MakeMKV to identify and
rip the longest feature title, converts it with FFmpeg, and atomically publishes
the validated result to a Movies directory.

> **Early development:** the initial application is implemented, but has not
> been validated on a Lubuntu optical drive. Do not rely on this release for
> unattended production use until the hardware acceptance tests in
> `AUTODISC-ARCHITECTURE.md` pass.

## Design and behavior

- Architecture review, risks, proposed structure, and delivery gates:
  [`AUTODISC-ARCHITECTURE.md`](./AUTODISC-ARCHITECTURE.md).
- One job at a time; repeated disc events are coalesced.
- FFmpeg probes NVENC and tests initialization before selecting it. `auto`
  falls back to software encoding when hardware encoding is absent or unusable.
  A GTX 710 commonly has no NVENC block; GPU use is not guaranteed.
- Title lookup uses disc labels by default. External metadata lookup is disabled
  until explicitly configured in Settings.
- The first-run web interface has no password, as requested. Bind it to
  localhost or a trusted LAN and configure a password before exposing it more
  broadly.
- AutoDisc does not bypass copy protection. Use MakeMKV and the appliance only
  for discs and purposes permitted by applicable law.

## Linux / Lubuntu system service deployment

1. Install Node.js 22+, npm, FFmpeg/ffprobe, udev, and eject from trusted
   Lubuntu/Ubuntu packages. Install MakeMKV using its official distribution and
   ensure `makemkvcon` is on the system `PATH`.
2. Choose the Jellyfin Movies directory and a dedicated temporary work directory with
   adequate free space (AutoDisc requires at least 8 GiB free before ripping,
   plus space in Movies for the finished file). The installer creates
   `/var/lib/autodisc` and `/var/cache/autodisc` for state and work.
3. Install the service from a source checkout with `sudo sh ./scripts/install.sh`.
   It builds the TypeScript app in `/opt/autodisc`, creates the `autodisc`
   service account, and enables the `systemd` unit.
4. Open AutoDisc locally, go to **Settings**, and set the Movies folder,
   temporary work folder, drive, and encoding preferences. Initial defaults are
   `/srv/jellyfin/Movies`, `/var/cache/autodisc`, and `/dev/sr0`. For network
   access, configure `/etc/default/autodisc`:

   ```ini
   HOST=127.0.0.1
   PORT=8787
   ```

   The service must have read/write access to the Movies and work directories
   and access to the configured optical drive. Use Settings for media paths
   (the database retains configured values across service restarts). Configure ownership or ACLs
   explicitly; do not make media directories world-writable. For an existing
   Jellyfin Movies directory, install `acl` if needed and grant access only to
   the service and Jellyfin accounts (replace `jellyfin` if your service uses
   another account):

   ```sh
   sudo setfacl -m u:autodisc:rwx,u:jellyfin:rx /srv/jellyfin/Movies
   sudo setfacl -d -m u:autodisc:rwx,u:jellyfin:r-x /srv/jellyfin/Movies
   ```

   These ACLs let AutoDisc create files and Jellyfin read them without making
   the library writable to other users. After changing environment settings,
   run `sudo systemctl restart autodisc`.
5. Ensure the Movies and work directories exist and are writable by the service
   account, and confirm that the Jellyfin service account can read produced
   files. Check status and logs with `systemctl status autodisc` and
   `journalctl -u autodisc -f`. Open `http://localhost:8787` locally. The
   default bind is localhost; to reach the UI from another trusted device, set
   `HOST` to the server's LAN address, configure an admin password, and restrict
   access with the host firewall.
6. Test with a known video DVD and verify the selected encoder and output before
   leaving the appliance unattended.

MakeMKV remains a separately licensed dependency and is not redistributed by
this project. Do not put a private/beta key into the repository. Startup should
report a missing CLI as a readiness issue instead of attempting a rip.
The service's MakeMKV configuration directory is `/var/lib/autodisc/.MakeMKV`;
place any required operator-supplied license/configuration there with ownership
`autodisc:autodisc` and restrictive permissions. Never add keys to Git.

## Settings and operations

The dashboard shows service status and conversion progress. Settings include
output and work paths, format/quality, encoder policy, eject behavior, password,
and metadata lookup. Resource samples are generated only while the dashboard
metrics stream is connected. Conversion history and statistics are stored in
SQLite at `/var/lib/autodisc/autodisc.sqlite`.

The initial implementation does not yet include job cancellation/retry,
pre-publish title editing, configurable failed-artifact retention, or a
configurable disk reserve. Test disc insertion/removal, interrupted jobs,
disk-full handling, permissions, cleanup, and eject on the target Lubuntu host
before unattended operation.
