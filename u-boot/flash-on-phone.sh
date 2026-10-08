#!/bin/sh
# Run ON THE PHONE as root:  sudo sh flash-on-phone.sh ./u-boot-gear.img
# Writes the quiet U-Boot into the Android "boot" partition (that is where ABL loads
# U-Boot from on this device; the Linux kernel lives on the ESP, not here).
# A backup of the partition is kept in <dir of the image>/boot-partition-backup-<date>.img;
# rollback: sudo sh rollback-on-phone.sh <that file>
# If the phone does not boot at all afterwards: hold Volume-Down + Power for fastboot
# (Xiaomi ABL) and `fastboot flash boot boot-partition-backup-<date>.img` from a PC.
set -eu
IMG=${1:?path to u-boot image}
PART=/dev/disk/by-partlabel/boot
[ -b "$PART" ] || { echo "no boot partition"; exit 1; }
head -c 8 "$IMG" | grep -q ANDROID || { echo "not an Android boot image"; exit 1; }
BK=$(dirname "$IMG")/boot-partition-backup-$(date +%Y%m%d-%H%M).img
echo "== backing up $PART ($(blockdev --getsize64 $PART) bytes) to $BK"
dd if="$PART" of="$BK" bs=4M status=none
sync; ls -l "$BK"
echo "== writing $IMG"
dd if="$IMG" of="$PART" bs=4096 conv=fsync status=none
sync
echo "== verify"
cmp -n "$(stat -c %s "$IMG")" "$IMG" "$PART" && echo "OK: boot partition now holds $IMG"
