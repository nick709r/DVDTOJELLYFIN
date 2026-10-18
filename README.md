# AutoDisc

AutoDisc is a headless, single-drive DVD and music CD ingestion appliance for
Linux and Jellyfin. It watches a configured optical drive, uses MakeMKV and
FFmpeg for DVDs and cdparanoia for audio CDs, then publishes finished movies to
Movies and lossless FLAC albums to Music.

> **Version 1.0:** the current DVD and music-CD feature set is complete. Test
> your optical drive, media permissions, MakeMKV, and eject behavior on the
> target Lubuntu server before relying on unattended operation.

## Coming in version 2.0

The next major version is planned to add:

- TV show ripping and Jellyfin TV library organization.
- Radarr integration for managing imported movies.
- Sonarr integration for managing imported TV episodes.

These are planned features only and are not included in AutoDisc 1.0.

## Design and behavior

- Architecture review, risks, proposed structure, and delivery gates:
  [`AUTODISC-ARCHITECTURE.md`](./AUTODISC-ARCHITECTURE.md).
- One job at a time; repeated disc events are coalesced.
- Audio CDs are extracted and named/tagged as lossless FLAC tracks. They can be
  published directly to Jellyfin Music, or (when enabled) sent to Lidarr for
  library import and organization after naming. MusicBrainz lookup is disabled
  by default; enable it to supply metadata for Lidarr matching.
- Movies are organized in a folder named after the selected title, with the
  movie file using the same name (for example, `Movies/Karate Kid/Karate Kid.mkv`).
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
   free work space and 256 MiB free Music/import space). The installer creates
   `/var/lib/autodisc`, `/var/cache/autodisc`, and `/var/cache/autodisc/lidarr-import`.
3. Open AutoDisc locally, go to **Settings**, and set the Movies and Music
   folders, temporary work folder, drive, and encoding preferences. Initial defaults are
   `/srv/jellyfin/Movies`, `/srv/jellyfin/Music`, `/var/cache/autodisc`, and `/dev/sr0`. To allow
   connections from other devices on the home network, first set an administrator
   password in Settings, then configure `/etc/default/autodisc`:

   ```ini
   HOST=0.0.0.0
   PORT=8787
   ```

   `0.0.0.0` makes the service listen on all IPv4 interfaces. After editing the
   file, run `sudo systemctl daemon-reload` and
   `sudo systemctl restart autodisc.service`. Find the server's LAN address
   with `hostname -I`, then open `http://<server-lan-ip>:8787` on another device.
   If a firewall is enabled, allow TCP port 8787 only from your home subnet.
   Do not forward this port from the internet.

   The service must have read/write access to the Movies and work directories
   and access to the configured optical drive. In direct-to-Jellyfin music mode,
   it also needs write access to Music. In Lidarr mode, AutoDisc writes to its
   incoming folder and Lidarr manages the Music library. The database retains
   configured values across service restarts. Configure ownership or ACLs
   explicitly; do not make media directories world-writable. For Jellyfin
   library directories, install `acl` if needed, create them if
   necessary, and grant access only to the service and Jellyfin accounts
   (replace `jellyfin` if your service uses another account):

   ```sh
   sudo mkdir -p /srv/jellyfin/Movies /srv/jellyfin/Music /var/cache/autodisc/lidarr-import
   sudo setfacl -m u:autodisc:rwx,u:jellyfin:rx /srv/jellyfin/Movies
   sudo setfacl -d -m u:autodisc:rwx,u:jellyfin:r-x /srv/jellyfin/Movies
   sudo setfacl -m u:autodisc:rwx,u:jellyfin:rx /srv/jellyfin/Music
   sudo setfacl -d -m u:autodisc:rwx,u:jellyfin:r-x /srv/jellyfin/Music
   ```

   To use Lidarr, grant its service account read/write access to the incoming
   folder too. Lidarr and AutoDisc must see the folder using the same absolute
   path (including when Lidarr runs in a container). In AutoDisc **Settings**,
   enable MusicBrainz lookup, enter the Lidarr URL and API key, set the incoming
   folder, then enable Lidarr import and use **Test Lidarr connection**. Add the
   artist and album in Lidarr first, and configure Lidarr's root folder and
   Jellyfin's Music library to the same Music directory. AutoDisc writes and names every FLAC file before
   asking Lidarr to match and move it into its managed library. If matching or
   import fails, AutoDisc preserves any remaining named files in the incoming
   folder for manual import rather than deleting the ripped music.

   For a local Lidarr service account named `lidarr`, one example is:

   ```sh
   sudo setfacl -m u:lidarr:rwx /var/cache/autodisc/lidarr-import
   sudo setfacl -d -m u:lidarr:rwx /var/cache/autodisc/lidarr-import
   sudo setfacl -m u:lidarr:--x /var/cache/autodisc
   sudo setfacl -m u:lidarr:rwx /srv/jellyfin/Music
   sudo setfacl -d -m u:lidarr:rwx /srv/jellyfin/Music
   ```

   These ACLs let the media services access their required folders without
   making them writable to other users. After changing environment settings,
   run `sudo systemctl restart autodisc`.
4. Ensure the Movies and work directories exist and are writable by the service
   account (and the direct Music destination or Lidarr incoming directory as
   configured), and confirm that the Jellyfin service account can read produced
   files. Check status and logs with `systemctl status autodisc` and
   `journalctl -u autodisc -f`. Open `http://localhost:8787` locally. The
   default bind is localhost; to reach the UI from another trusted device, set
   `HOST` to the server's LAN address, configure an admin password, and restrict
   access with the host firewall. Use `HOST=0.0.0.0` to listen on LAN interfaces;
   the service unit reads this value from `/etc/default/autodisc`.
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

## Service management

AutoDisc runs as the `autodisc.service` systemd service. The installer enables
it at boot and starts it immediately. Use these commands on the Lubuntu server:

```sh
sudo systemctl start autodisc.service
sudo systemctl stop autodisc.service
sudo systemctl restart autodisc.service
sudo systemctl status autodisc.service
sudo journalctl -u autodisc.service -f
```

`start` starts a stopped service, `stop` shuts it down, and `restart` stops and
starts it again (for example, after changing `/etc/default/autodisc`). Follow
the logs with `journalctl` when diagnosing startup or disc-processing issues.

To update AutoDisc from the latest `main` branch, first wait for the dashboard
to show **Idle**. Stopping the service during a disc job interrupts that job.
The installer preserves settings and history in `/var/lib/autodisc`, replaces
the deployed application in `/opt/autodisc`, rebuilds it, then enables and
starts the service again. Back up the database while the service is stopped if
you want an extra recovery copy:

```sh
sudo systemctl stop autodisc.service
sudo cp /var/lib/autodisc/autodisc.sqlite /var/lib/autodisc/autodisc.sqlite.bak
```

Then run the same one-line install/update command from the deployment section:

```sh
sudo apt-get update && sudo apt-get install -y curl ca-certificates && curl --fail --silent --show-error --location https://github.com/nick709r/DVDTOJELLYFIN/archive/refs/heads/main.tar.gz --output /tmp/autodisc-main.tar.gz && tar -xzf /tmp/autodisc-main.tar.gz -C /tmp && rm /tmp/autodisc-main.tar.gz && cd /tmp/DVDTOJELLYFIN-main && sudo sh ./scripts/install.sh
```

The installer starts the service when it finishes. Confirm the update with
`sudo systemctl status autodisc.service` and open `http://localhost:8787`.

## Settings and operations

The dashboard shows service status and conversion progress. Settings include
Movies/Music output and work paths, optional Lidarr import, format/quality,
encoder policy, eject behavior, password, and optional TMDB/MusicBrainz metadata lookup. Resource
samples are generated only while the dashboard metrics stream is connected.
Conversion history and statistics are stored in
SQLite at `/var/lib/autodisc/autodisc.sqlite`.

The initial implementation does not yet include job cancellation/retry,
pre-publish title editing, configurable failed-artifact retention, or a
configurable disk reserve. Test disc insertion/removal, interrupted jobs,
disk-full handling, permissions, cleanup, and eject on the target Lubuntu host
before unattended operation.
