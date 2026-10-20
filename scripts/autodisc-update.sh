#!/bin/sh
set -eu

APP_DIR=/opt/autodisc
BACKUP_DIR=/opt/autodisc.rollback
SUPPORT_BACKUP=/opt/autodisc-support.rollback
STAGING_DIR=
BUILD_DIR=
UPDATE_DIR=/var/lib/autodisc/updater
UPDATE_REQUEST=$UPDATE_DIR/request
UPDATE_STATUS=$UPDATE_DIR/status
DATABASE_PATH=/var/lib/autodisc/autodisc.sqlite
DATABASE_BACKUP=/opt/autodisc.sqlite.rollback
WAL_BACKUP=/opt/autodisc.sqlite-wal.rollback
SHM_BACKUP=/opt/autodisc.sqlite-shm.rollback
database_snapshot=0
database_existed=0
support_snapshot=0
SERVICE=autodisc.service

write_status() {
  status_tmp=$(mktemp "$UPDATE_DIR/status.tmp.XXXXXX")
  printf '%s\n' "$1" > "$status_tmp"
  chmod 0644 "$status_tmp"
  mv -f "$status_tmp" "$UPDATE_STATUS"
}

rollback() {
  exit_code=$?
  trap - EXIT
  rollback_failed=0
  set +e
  report_rollback_error() {
    printf '%s\n' "AutoDisc updater rollback error: $1" >&2
    rollback_failed=1
  }
  if [ "$exit_code" -ne 0 ]; then
    write_status failed || report_rollback_error "could not record failure status"
    if [ -d "$BACKUP_DIR" ]; then
      systemctl stop "$SERVICE" >/dev/null 2>&1 || report_rollback_error "could not stop AutoDisc before restoring files"
      rm -rf "$APP_DIR" || report_rollback_error "could not remove the failed application"
      mv "$BACKUP_DIR" "$APP_DIR" || report_rollback_error "could not restore the previous application"
    fi
    if [ "$database_snapshot" -eq 1 ]; then
      rm -f "$DATABASE_PATH" "${DATABASE_PATH}-wal" "${DATABASE_PATH}-shm" ||
        report_rollback_error "could not remove the failed database"
      if [ "$database_existed" -eq 1 ]; then
        cp -a "$DATABASE_BACKUP" "$DATABASE_PATH" ||
          report_rollback_error "could not restore the database snapshot"
        if [ -f "$WAL_BACKUP" ]; then
          cp -a "$WAL_BACKUP" "${DATABASE_PATH}-wal" ||
            report_rollback_error "could not restore the database WAL snapshot"
        fi
        if [ -f "$SHM_BACKUP" ]; then
          cp -a "$SHM_BACKUP" "${DATABASE_PATH}-shm" ||
            report_rollback_error "could not restore the database shared-memory snapshot"
        fi
      fi
    fi
    if [ "$support_snapshot" -eq 1 ]; then
      cp -a "$SUPPORT_BACKUP/autodisc-update" /usr/local/libexec/autodisc-update ||
        report_rollback_error "could not restore the previous updater helper"
      cp -a "$SUPPORT_BACKUP/autodisc.service" /etc/systemd/system/autodisc.service ||
        report_rollback_error "could not restore the previous AutoDisc service unit"
      cp -a "$SUPPORT_BACKUP/autodisc-update.service" /etc/systemd/system/autodisc-update.service ||
        report_rollback_error "could not restore the previous updater service unit"
      cp -a "$SUPPORT_BACKUP/autodisc-update.path" /etc/systemd/system/autodisc-update.path ||
        report_rollback_error "could not restore the previous updater path unit"
      systemctl daemon-reload || report_rollback_error "systemd could not reload restored units"
      systemctl restart autodisc-update.path >/dev/null 2>&1 ||
        report_rollback_error "the updater path watcher could not be restarted"
    fi
    systemctl restart "$SERVICE" >/dev/null 2>&1 ||
      report_rollback_error "the previous AutoDisc service could not be restarted"
  fi
  if [ -n "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR" || report_rollback_error "could not clean the staging directory"
  fi
  if [ -n "$BUILD_DIR" ]; then
    rm -rf "$BUILD_DIR" || report_rollback_error "could not clean the update workspace"
  fi
  if [ "$rollback_failed" -eq 0 ]; then
    rm -rf "$SUPPORT_BACKUP" || report_rollback_error "could not clean the support backup"
    rm -f "$DATABASE_BACKUP" "$WAL_BACKUP" "$SHM_BACKUP" ||
      report_rollback_error "could not clean the database backups"
  else
    printf '%s\n' "AutoDisc rollback was incomplete; recovery files were retained." >&2
  fi
  if [ "$rollback_failed" -ne 0 ]; then exit 1; fi
  exit "$exit_code"
}
trap rollback EXIT

if [ ! -f "$UPDATE_REQUEST" ] || [ -L "$UPDATE_REQUEST" ]; then
  echo "No regular AutoDisc update request was found." >&2
  exit 1
fi
version=$(cat "$UPDATE_REQUEST")
rm -f "$UPDATE_REQUEST"
if ! printf '%s\n' "$version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "The requested AutoDisc version is invalid." >&2
  exit 1
fi

latest=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const response = await fetch("https://api.github.com/repos/nick709r/DVDTOJELLYFIN/tags?per_page=100", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "AutoDisc updater" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const tags = await response.json();
  const versions = tags.map((tag) => tag.name).filter((name) => /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(name));
  if (!versions.length) throw new Error("No stable AutoDisc tags found");
  const compare = (left, right) => {
    const a = left.replace(/^v/, "").split(".").map((part) => BigInt(part));
    const b = right.replace(/^v/, "").split(".").map((part) => BigInt(part));
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  };
  versions.sort((left, right) => {
    return compare(left, right);
  });
  const latest = versions.at(-1);
  const installed = `v${JSON.parse(readFileSync("/opt/autodisc/package.json", "utf8")).version}`;
  if (compare(latest, installed) <= 0) throw new Error("No newer stable AutoDisc version is available");
  console.log(latest);
')
if [ "$version" != "$latest" ]; then
  echo "Requested version is no longer the latest stable AutoDisc tag." >&2
  exit 1
fi

write_status applying
BUILD_DIR=$(mktemp -d /opt/autodisc-update.XXXXXX)
chown autodisc:autodisc "$BUILD_DIR"
setpriv --reuid=autodisc --regid=autodisc --init-groups --reset-env -- env HOME=/var/lib/autodisc sh -c '
  set -eu
  build_dir=$1
  requested_version=$2
  cd "$build_dir"
  curl --fail --silent --show-error --location --max-time 180 \
    "https://github.com/nick709r/DVDTOJELLYFIN/archive/refs/tags/$requested_version.tar.gz" \
    --output source.tar.gz
  tar -xzf source.tar.gz
  set -- "$build_dir"/DVDTOJELLYFIN-*
  [ -d "$1" ]
  source_dir=$1
  manifest_version=$(node -p "require(\"$source_dir/package.json\").version")
  [ "$manifest_version" = "${requested_version#v}" ]
  cd "$source_dir"
  npm ci --include=dev --ignore-scripts --no-audit --no-fund
  native_prebuild="node_modules/better-sqlite3/prebuilds/linux-$(node -p 'process.arch').node"
  if [ ! -f "$native_prebuild" ]; then
    npm rebuild better-sqlite3 --no-audit --no-fund
  fi
  npm run build
  npm prune --omit=dev --ignore-scripts --no-audit --no-fund
' autodisc "$BUILD_DIR" "$version"

set -- "$BUILD_DIR"/DVDTOJELLYFIN-*
SOURCE_DIR=$1
STAGING_DIR="/opt/autodisc.next.$$"
install -d -o root -g root -m 0755 "$STAGING_DIR"
for file in package.json package-lock.json tsconfig.json README.md AUTODISC-ARCHITECTURE.md; do
  cp "$SOURCE_DIR/$file" "$STAGING_DIR/"
done
cp -R "$SOURCE_DIR/src" "$SOURCE_DIR/web" "$SOURCE_DIR/dist" "$SOURCE_DIR/node_modules" "$STAGING_DIR/"
chown -R root:root "$STAGING_DIR"

systemctl stop "$SERVICE"
rm -rf "$SUPPORT_BACKUP"
install -d -o root -g root -m 0700 "$SUPPORT_BACKUP"
cp -a /usr/local/libexec/autodisc-update "$SUPPORT_BACKUP/autodisc-update"
cp -a /etc/systemd/system/autodisc.service "$SUPPORT_BACKUP/autodisc.service"
cp -a /etc/systemd/system/autodisc-update.service "$SUPPORT_BACKUP/autodisc-update.service"
cp -a /etc/systemd/system/autodisc-update.path "$SUPPORT_BACKUP/autodisc-update.path"
support_snapshot=1
rm -f "$DATABASE_BACKUP" "$WAL_BACKUP" "$SHM_BACKUP"
if [ -f "$DATABASE_PATH" ]; then
  cp -a "$DATABASE_PATH" "$DATABASE_BACKUP"
  database_existed=1
fi
if [ -f "${DATABASE_PATH}-wal" ]; then cp -a "${DATABASE_PATH}-wal" "$WAL_BACKUP"; fi
if [ -f "${DATABASE_PATH}-shm" ]; then cp -a "${DATABASE_PATH}-shm" "$SHM_BACKUP"; fi
database_snapshot=1
rm -rf "$BACKUP_DIR"
mv "$APP_DIR" "$BACKUP_DIR"
mv "$STAGING_DIR" "$APP_DIR"
STAGING_DIR=
install -o root -g root -m 0755 "$SOURCE_DIR/scripts/autodisc-update.sh" /usr/local/libexec/autodisc-update
install -o root -g root -m 0644 "$SOURCE_DIR/service/autodisc.service" /etc/systemd/system/autodisc.service
install -o root -g root -m 0644 "$SOURCE_DIR/service/autodisc-update.service" /etc/systemd/system/autodisc-update.service
install -o root -g root -m 0644 "$SOURCE_DIR/service/autodisc-update.path" /etc/systemd/system/autodisc-update.path
systemctl daemon-reload
systemctl restart autodisc-update.path
systemctl start "$SERVICE"

attempt=0
while [ "$attempt" -lt 30 ]; do
  if systemctl is-active --quiet "$SERVICE"; then break; fi
  attempt=$((attempt + 1))
  sleep 2
done
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "The updated AutoDisc service did not become active." >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
BUILD_DIR=
write_status success
trap - EXIT
rm -rf "$BACKUP_DIR"
rm -rf "$SUPPORT_BACKUP"
rm -f "$DATABASE_BACKUP" "$WAL_BACKUP" "$SHM_BACKUP"
