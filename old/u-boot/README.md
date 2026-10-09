# Quiet U-Boot for the POCO X3 NFC (surya)

The phone boots ABL → U-Boot (an Android boot image in the `boot` partition) → systemd-boot
(on the ESP) → Linux. Stock U-Boot draws its whole console on the panel: the banner, probe
messages and its boot menu. This build leaves the panel quiet and draws only a small gray gear
under the POCO logo.

| File | What it is |
|---|---|
| `u-boot-gear.img` | **The image to flash.** The quiet build with the gear logo. Flashed and booting on a POCO X3 NFC since 2026-10-06. |
| `boot-original.img` | The original U-Boot read back from the phone, for rollback. |
| `qcom-quiet.config` | Config fragment merged on top of `qcom_defconfig qcom-phone.config`. It sets `CONFIG_NO_FB_CLEAR=y` (keep ABL's picture on the panel), adds `BLKMAP`/`CMD_BLKMAP`/`CMD_UFETCH`/`IPV6` (needed to map the postmarketOS image's ESP), and selects the env below. |
| `qcom-phone-quiet.env` | `stdout`/`stderr` go to serial only. `show_console` re-adds `vidconsole` when the boot menu is entered, so the menu and errors still appear when needed. |
| `u-boot.config` | The full resulting `.config`. |
| `0001-video-centre-the-logo.patch`, `u_boot_logo-gear.bmp` | The gear (200x200, 8-bit gray) replaces `drivers/video/u_boot_logo.bmp` and is drawn centred, 200 px below the middle of the panel. |

SHA-256:

    9dd5c9fb9993e735f6757aa8ad8d17ecb0d7da7e39c9c847c1708a73362f2605  u-boot-gear.img
    279902a1055c9c86eca8b7ff0f3e8a479929e4cf1326887be452da4e10afe5e4  boot-original.img

## Flash

From a PC: hold **Volume Down + Power** for Xiaomi fastboot, then run:

    fastboot flash boot u-boot-gear.img
    fastboot reboot

Or on the phone itself, as root, with the cable connected. The script backs up the partition
next to the image first:

    sudo sh flash-on-phone.sh ./u-boot-gear.img

To roll back, flash `boot-original.img` through fastboot, or run
`sudo sh rollback-on-phone.sh <backup>.img`.

## Build

The source is [sm7150-mainline/u-boot](https://github.com/sm7150-mainline/u-boot) at commit `f8c04469`
(branch `tauchgang`).

    git apply 0001-video-centre-the-logo.patch
    cp u_boot_logo-gear.bmp drivers/video/u_boot_logo.bmp
    cp qcom-quiet.config qcom-phone-quiet.env board/qualcomm/   # where qcom-phone.config lives
    make O=.output CROSS_COMPILE=aarch64-linux-gnu- qcom_defconfig qcom-phone.config qcom-quiet.config
    make -j8 O=.output CROSS_COMPILE=aarch64-linux-gnu-
    # needs: bison flex swig xxd libgnutls28-dev libssl-dev python3-dev uuid-dev

Packing: the image is an Android boot image v0 (page 4096, kernel 0x8000, ramdisk 0x1000000,
tags 0x100), with kernel = `gzip(u-boot-nodtb.bin)` + `sm7150-xiaomi-surya-huaxing.dtb`. This is
the same layout as the image read back from the phone.
