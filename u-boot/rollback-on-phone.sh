#!/bin/sh
# sudo sh rollback-on-phone.sh ./boot-partition-backup-<date>.img
set -eu
BK=${1:?backup image}
dd if="$BK" of=/dev/disk/by-partlabel/boot bs=4M conv=fsync status=none; sync
cmp -n "$(stat -c %s "$BK")" "$BK" /dev/disk/by-partlabel/boot && echo "OK: original U-Boot restored"
