#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root: sudo ./scripts/install.sh" >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! command -v apt-get >/dev/null 2>&1 || [ ! -r /etc/os-release ]; then
  echo "Automatic dependency installation supports Ubuntu/Lubuntu and Debian." >&2
  exit 1
fi

. /etc/os-release
case "${ID:-}" in
  ubuntu|debian|linuxmint) ;;
  *)
    echo "Automatic dependency installation is unsupported on ${PRETTY_NAME:-this Linux distribution}." >&2
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gpg

install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
chmod 0644 /etc/apt/keyrings/nodesource.gpg
arch=$(dpkg --print-architecture)
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' "$arch" \
  > /etc/apt/sources.list.d/nodesource.list

apt-get update
apt-get install -y \
  acl \
  build-essential \
  ca-certificates \
  cd-discid \
  cdparanoia \
  curl \
  eject \
  ffmpeg \
  gpg \
  nodejs \
  python3 \
  util-linux \
  udev

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm installation failed. Check apt output and retry." >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22 or newer is required; found $(node --version). Check the NodeSource apt repository." >&2
  exit 1
fi

for tool in ffmpeg ffprobe udevadm eject setfacl cdparanoia cd-discid; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required Linux tool '$tool' is not installed or not on PATH." >&2
    exit 1
  fi
done

if ! command -v makemkvcon >/dev/null 2>&1; then
  echo "WARNING: MakeMKV is not installed. DVD ripping will not work until it is installed." >&2
fi

getent group cdrom >/dev/null 2>&1 || {
  echo "The cdrom group is required for optical-drive access." >&2
  exit 1
}
getent group video >/dev/null 2>&1 || {
  echo "The video group is required for optional NVIDIA device access." >&2
  exit 1
}

if ! getent group autodisc >/dev/null 2>&1; then
  groupadd --system autodisc
fi
if ! id autodisc >/dev/null 2>&1; then
  useradd --system --no-create-home --gid autodisc --groups cdrom,video --shell /usr/sbin/nologin autodisc
else
  usermod --append --groups cdrom,video autodisc
fi

configured_path() {
  key=$1
  fallback=$2
  case "$key" in
    MOVIES_DIR) value=${MOVIES_DIR:-} ;;
    TV_DIR) value=${TV_DIR:-} ;;
    MUSIC_DIR) value=${MUSIC_DIR:-} ;;
    *) echo "Unsupported library setting: $key" >&2; exit 1 ;;
  esac
  if [ -z "$value" ] && [ -r /etc/default/autodisc ]; then
    value=$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' /etc/default/autodisc)
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
  fi
  case "$value" in
    /*) printf '%s\n' "$value" ;;
    "") printf '%s\n' "$fallback" ;;
    *) echo "$key must be an absolute path" >&2; exit 1 ;;
  esac
}

for library_path in \
  "$(configured_path MOVIES_DIR /srv/jellyfin/Movies)" \
  "$(configured_path TV_DIR /srv/jellyfin/TV)" \
  "$(configured_path MUSIC_DIR /srv/jellyfin/Music)"; do
  if [ "$library_path" = "/" ]; then
    echo "A library path must not be the filesystem root." >&2
    exit 1
  fi
  if [ ! -d "$library_path" ]; then
    library_parent=$(dirname "$library_path")
    while [ ! -d "$library_parent" ]; do
      next_parent=$(dirname "$library_parent")
      if [ "$next_parent" = "$library_parent" ]; then
        echo "Could not find an existing parent for library path: $library_path" >&2
        exit 1
      fi
      library_parent=$next_parent
    done
    library_gid=$(stat -c '%g' "$library_parent")
    if [ "$library_gid" = "0" ]; then
      if getent group jellyfin >/dev/null 2>&1; then
        library_gid=$(getent group jellyfin | cut -d: -f3)
      else
        library_gid=$(getent group autodisc | cut -d: -f3)
      fi
    fi
    mkdir -p "$library_path"
    chown "autodisc:$library_gid" "$library_path"
  else
    library_gid=$(stat -c '%g' "$library_path")
    if [ "$library_gid" = "0" ]; then
      if getent group jellyfin >/dev/null 2>&1; then
        library_gid=$(getent group jellyfin | cut -d: -f3)
      else
        library_gid=$(getent group autodisc | cut -d: -f3)
      fi
      chgrp "$library_gid" "$library_path"
    fi
  fi
  usermod --append --groups "$library_gid" autodisc
  chmod 2775 "$library_path"
done

if systemctl is-active --quiet autodisc.service; then
  systemctl stop autodisc.service
fi

install -d -o root -g root -m 0755 /opt/autodisc
install -d -o autodisc -g autodisc -m 0750 /var/lib/autodisc /var/cache/autodisc /var/cache/autodisc/lidarr-import
install -d -o autodisc -g autodisc -m 0700 /var/lib/autodisc/.MakeMKV
install -d -o root -g autodisc -m 1770 /var/lib/autodisc/updater
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/tsconfig.json" /opt/autodisc/
cp "$ROOT/README.md" "$ROOT/AUTODISC-ARCHITECTURE.md" /opt/autodisc/
rm -rf /opt/autodisc/src /opt/autodisc/web /opt/autodisc/scripts
cp -R "$ROOT/src" "$ROOT/web" "$ROOT/scripts" /opt/autodisc/
chown -R root:root /opt/autodisc

cd /opt/autodisc
npm ci --include=dev --ignore-scripts --no-audit --no-fund
native_prebuild="node_modules/better-sqlite3/prebuilds/linux-$(node -p 'process.arch').node"
if [ ! -f "$native_prebuild" ]; then
  npm rebuild better-sqlite3 --no-audit --no-fund
fi
npm run build
npm prune --omit=dev --ignore-scripts --no-audit --no-fund

install -o root -g root -m 0644 "$ROOT/service/autodisc.service" /etc/systemd/system/autodisc.service
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$ROOT/scripts/autodisc-update.sh" /usr/local/libexec/autodisc-update
install -o root -g root -m 0644 "$ROOT/service/autodisc-update.service" /etc/systemd/system/autodisc-update.service
install -o root -g root -m 0644 "$ROOT/service/autodisc-update.path" /etc/systemd/system/autodisc-update.path
if [ ! -e /etc/default/autodisc ]; then
  install -o root -g root -m 0640 /dev/null /etc/default/autodisc
fi
systemctl daemon-reload
systemctl enable --now autodisc-update.path
systemctl enable --now autodisc.service
echo "AutoDisc installed and started. Configure /etc/default/autodisc and restart with: systemctl restart autodisc"
