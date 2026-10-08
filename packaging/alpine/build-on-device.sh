#!/usr/bin/env bash
# Build the apk on an Alpine-based phone (Nura / postmarketOS) that has `alpine-sdk` and a
# signing key (`abuild-keygen -a -n`, user in group abuild), then copy the result back here.
#   PHONE=user@host packaging/alpine/build-on-device.sh
# Result: packaging/alpine/out/neolauncher-gnome-shell-<ver>-r<rel>.apk (+ the signing public key)
set -euo pipefail
PHONE=${PHONE:-pulp@192.168.10.98}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
VER=$(sed -n 's/^pkgver=//p' "$HERE/APKBUILD")
REL=$(sed -n 's/^pkgrel=//p' "$HERE/APKBUILD")
TAR=neolauncher-gnome-shell-$VER.tar.gz
make -s -C "$ROOT" dist
REMOTE=abuild/neolauncher-gnome-shell
ssh "$PHONE" "rm -rf $REMOTE && mkdir -p $REMOTE"
scp -q "$ROOT/$TAR" "$HERE/APKBUILD" "$HERE/60_neolauncher.gschema.override" "$HERE"/neolauncher-gnome-shell.post-* "$PHONE:$REMOTE/"
ssh "$PHONE" "cd $REMOTE && abuild checksum >/dev/null && abuild -r 2>&1 | grep -E '^>>>|ERROR|error' | tail -15"
mkdir -p "$HERE/out"
scp -q "$PHONE:.local/share/abuild/abuild/*/neolauncher-gnome-shell-$VER-r$REL.apk" "$HERE/out/"   # REPODEST default of abuild 3.18
scp -q "$PHONE:.config/abuild/*.rsa.pub" "$HERE/out/" 2>/dev/null || scp -q "$PHONE:.abuild/*.rsa.pub" "$HERE/out/" 2>/dev/null || true
ls -la "$HERE/out/"
