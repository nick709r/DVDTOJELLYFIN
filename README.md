# AutoDisc

AutoDisc is a headless, single-drive DVD and music CD ingestion appliance for
Linux and Jellyfin. It watches a configured optical drive, uses MakeMKV and
FFmpeg for DVDs and cdparanoia for audio CDs, then publishes finished movies to
Movies and lossless FLAC albums to Music.

> **Early development:** the initial application is implemented, but has not
> been validated on a Lubuntu optical drive. Do not rely on this release for
> unattended production use until the hardware acceptance tests in
> `AUTODISC-ARCHITECTURE.md` pass.

## Design and behavior

- Architecture review, risks, proposed structure, and delivery gates:
  [`AUTODISC-ARCHITECTURE.md`](./AUTODISC-ARCHITECTURE.md).
- One job at a time; repeated disc events are coalesced.
- Audio CDs are extracted track-by-track into lossless FLAC album folders under
  the configured Jellyfin Music directory. MusicBrainz lookup is optional and
  disabled by default; unmatched discs receive generic artist/album/track tags.
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

On a fresh Lubuntu/Ubuntu or Debian install, download the current `main` source
and run the installer with this one-line command:

```sh
sudo apt-get update && sudo apt-get install -y curl ca-certificates && curl --fail --silent --show-error --location https://github.com/nick709r/DVDTOJELLYFIN/archive/refs/heads/main.tar.gz --output /tmp/autodisc-main.tar.gz && tar -xzf /tmp/autodisc-main.tar.gz -C /tmp && rm /tmp/autodisc-main.tar.gz && cd /tmp/DVDTOJELLYFIN-main && sudo sh ./scripts/install.sh
```

The installer configures the signed NodeSource apt repository and installs
Node.js 22+, npm, FFmpeg/ffprobe, cdparanoia, cd-discid, build tools, udev, eject,
and ACL utilities, then builds AutoDisc and enables its systemd service. It is
safe to rerun for updates.

MakeMKV is not bundled or installed by this script: it is separately licensed
and distributed by its vendor. Install the official Linux MakeMKV package and
ensure `makemkvcon` is on `PATH` to enable DVD ripping. Music CD ripping works
without it.

1. Install MakeMKV from its official Linux distribution to enable DVD ripping.
   Music CD ripping works without MakeMKV.
2. Choose Jellyfin Movies and Music directories and a dedicated temporary work directory with
   adequate free space (AutoDisc requires at least 8 GiB free before ripping,
   plus space in the destination for finished media; music jobs require 2 GiB
   free work space and 256 MiB free Music space). The installer creates
   `/var/lib/autodisc` and `/var/cache/autodisc` for state and work.
3. Open AutoDisc locally, go to **Settings**, and set the Movies and Music
   folders, temporary work folder, drive, and encoding preferences. Initial defaults are
   `/srv/jellyfin/Movies`, `/srv/jellyfin/Music`, `/var/cache/autodisc`, and `/dev/sr0`. For network
   access, configure `/etc/default/autodisc`:

   ```ini
   HOST=127.0.0.1
   PORT=8787
   ```

   The service must have read/write access to the Movies, Music, and work directories
   and access to the configured optical drive. Use Settings for media paths
   (the database retains configured values across service restarts). Configure ownership or ACLs
   explicitly; do not make media directories world-writable. For Jellyfin
   library directories, install `acl` if needed, create them if
   necessary, and grant access only to the service and Jellyfin accounts
   (replace `jellyfin` if your service uses another account):

   ```sh
   sudo mkdir -p /srv/jellyfin/Movies /srv/jellyfin/Music
   sudo setfacl -m u:autodisc:rwx,u:jellyfin:rx /srv/jellyfin/Movies
   sudo setfacl -d -m u:autodisc:rwx,u:jellyfin:r-x /srv/jellyfin/Movies
   sudo setfacl -m u:autodisc:rwx,u:jellyfin:rx /srv/jellyfin/Music
   sudo setfacl -d -m u:autodisc:rwx,u:jellyfin:r-x /srv/jellyfin/Music
   ```

   These ACLs let AutoDisc create files and Jellyfin read them without making
   the library writable to other users. After changing environment settings,
   run `sudo systemctl restart autodisc`.
4. Ensure the Movies, Music, and work directories exist and are writable by the service
   account, and confirm that the Jellyfin service account can read produced
   files. Check status and logs with `systemctl status autodisc` and
   `journalctl -u autodisc -f`. Open `http://localhost:8787` locally. The
   default bind is localhost; to reach the UI from another trusted device, set
   `HOST` to the server's LAN address, configure an admin password, and restrict
   access with the host firewall.
5. Test with a known video DVD and an audio CD; verify the selected encoder,
   album tags, output paths, cleanup, and eject before leaving the appliance
   unattended.

MakeMKV remains a separately licensed dependency and is not redistributed by
this project. DVD ripping is unavailable until it is installed; music CD
ripping does not require it. Do not put a private/beta key into the repository.
Startup should report a missing CLI as a readiness issue instead of attempting a DVD rip.
The service's MakeMKV configuration directory is `/var/lib/autodisc/.MakeMKV`;
place any required operator-supplied license/configuration there with ownership
`autodisc:autodisc` and restrictive permissions. Never add keys to Git.

## Settings and operations

The dashboard shows service status and conversion progress. Settings include
Movies/Music output and work paths, format/quality, encoder policy, eject
behavior, password, and optional TMDB/MusicBrainz metadata lookup. Resource
samples are generated only while the dashboard metrics stream is connected.
Conversion history and statistics are stored in
SQLite at `/var/lib/autodisc/autodisc.sqlite`.

The initial implementation does not yet include job cancellation/retry,
pre-publish title editing, configurable failed-artifact retention, or a
configurable disk reserve. Test disc insertion/removal, interrupted jobs,
disk-full handling, permissions, cleanup, and eject on the target Lubuntu host
before unattended operation.
