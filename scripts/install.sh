#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root: sudo ./scripts/install.sh" >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22 or newer and npm are required. Install them before continuing." >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22 or newer is required; found $(node --version)." >&2
  exit 1
fi

for tool in ffmpeg ffprobe udevadm eject; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required Linux tool '$tool' is not installed or not on PATH." >&2
    exit 1
  fi
done

if ! command -v makemkvcon >/dev/null 2>&1; then
  echo "MakeMKV CLI (makemkvcon) is required; install it using its official distribution." >&2
  exit 1
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
  useradd --system --no-create-home --gid autodisc --groups cdrom --shell /usr/sbin/nologin autodisc
else
  usermod --append --groups cdrom autodisc
fi

if systemctl is-active --quiet autodisc.service; then
  systemctl stop autodisc.service
fi

install -d -o root -g root -m 0755 /opt/autodisc
install -d -o autodisc -g autodisc -m 0750 /var/lib/autodisc /var/cache/autodisc
install -d -o autodisc -g autodisc -m 0700 /var/lib/autodisc/.MakeMKV
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/tsconfig.json" /opt/autodisc/
cp "$ROOT/README.md" "$ROOT/AUTODISC-ARCHITECTURE.md" /opt/autodisc/
rm -rf /opt/autodisc/src /opt/autodisc/web
cp -R "$ROOT/src" "$ROOT/web" /opt/autodisc/
chown -R root:root /opt/autodisc

cd /opt/autodisc
npm ci --include=dev
npm run build
npm prune --omit=dev

install -o root -g root -m 0644 "$ROOT/service/autodisc.service" /etc/systemd/system/autodisc.service
if [ ! -e /etc/default/autodisc ]; then
  install -o root -g root -m 0640 /dev/null /etc/default/autodisc
fi

systemctl daemon-reload
systemctl enable --now autodisc.service
echo "AutoDisc installed and started. Configure /etc/default/autodisc and restart with: systemctl restart autodisc"
