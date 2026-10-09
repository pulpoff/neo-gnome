#!/bin/sh
# build-debs.sh OUT [PHONE]: the Neo-on-Phosh packages for the Mobian image, into OUT:
#   neo-launcher_<v>_all.deb                 this tree's neo-launcher/ (+ the h2o and oneplus icon packs from
#                                            gnome/launcher/iconpacks, which are not in git: third-party art)
#   phosh-mobile-settings_0.58.0-1+suryaN   Mobile Settings with the POCO page (launcher, screen lock) and the About fix
#   phosh*/libphosh*_0.58.0-1+neoN           Phosh with debian/patches/0100-0103, as built on the phone
# The arm64 parts are built on the phone (root@PHONE, default 10.66.0.1) and fetched from there:
#   Phosh in /usr/src/neo/phosh-0.58.0 (see README), the plugin in /usr/src/neo/phosh-mobile-settings-0.58.0.
set -eu
OUT=$1 PHONE=${2:-10.66.0.1}
HERE=$(cd "$(dirname "$0")" && pwd)
PACKS=$HERE/../launcher/iconpacks
NEO_VERSION=1.0.3
PLUGIN_VERSION=0.58.0-1+surya1
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR root@$PHONE"
SCP="scp -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# --- neo-launcher (arch all) -----------------------------------------------------------------------------------
P=$WORK/neo-launcher N=$HERE/neo-launcher
install -d "$P/DEBIAN" "$P/usr/bin" "$P/usr/share/neo-launcher/iconpacks" "$P/usr/lib/systemd/user/neo-launcher.service.d" \
    "$P/usr/share/glib-2.0/schemas"
install -m 644 "$N"/src/*.js "$N"/src/*.css "$P/usr/share/neo-launcher/"
install -m 755 "$N"/src/appmem.py "$P/usr/share/neo-launcher/"
install -m 755 "$N/neo-launcher" "$P/usr/bin/neo-launcher"
install -m 644 "$N/data/neo-launcher.service" "$P/usr/lib/systemd/user/"
install -m 644 "$N/data/renderer.conf" "$P/usr/lib/systemd/user/neo-launcher.service.d/"
install -m 644 "$N/data/de.yesman.neo.gschema.xml" "$P/usr/share/glib-2.0/schemas/"
for pack in h2o oneplus; do
    [ -d "$PACKS/$pack" ] && cp -r --no-preserve=ownership "$PACKS/$pack" "$P/usr/share/neo-launcher/iconpacks/" || echo "no icon pack $pack" >&2
done
cat > "$P/DEBIAN/control" <<EOF
Package: neo-launcher
Version: $NEO_VERSION
Architecture: all
Maintainer: pulpoff <pashkovsky@gmail.com>
Depends: gjs, python3, gir1.2-gtk-4.0, gir1.2-adw-1, libgtk4-layer-shell0, gir1.2-gtk4layershell-1.0, grim, wtype, systemd, phosh (>= 0.58.0-1+neo13)
Section: x11
Priority: optional
Description: Neo, a Launcher3-like home screen for Phosh
 Pages, dock, an app drawer that follows the finger, icon packs and shapes, the
 back gesture from the screen edges and a One UI task view. Replaces Phosh's
 app grid; Phosh keeps the lock screen, notifications and quick settings.
EOF
cat > "$P/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
glib-compile-schemas /usr/share/glib-2.0/schemas
systemctl --global enable neo-launcher.service >/dev/null 2>&1 || true
EOF
cat > "$P/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
[ "$1" = remove ] || [ "$1" = purge ] || exit 0
systemctl --global disable neo-launcher.service >/dev/null 2>&1 || true
glib-compile-schemas /usr/share/glib-2.0/schemas || true
EOF
chmod 755 "$P/DEBIAN/postinst" "$P/DEBIAN/postrm"
dpkg-deb --root-owner-group -Zxz --build "$P" "$OUT/neo-launcher_${NEO_VERSION}_all.deb" >/dev/null

# --- Mobile Settings with the POCO page (plugins/surya in its tree) and the About patch, built on the phone ---------
for pkg in phosh-mobile-settings_ libpms-1.0-0_ libpms-1.0-common_; do
    $SCP "root@$PHONE:/usr/src/neo/${pkg}0.58.0-1+surya*_*.deb" "$OUT/" 2>/dev/null || true
done

# --- Phosh with the Neo patches: the newest build on the phone ------------------------------------------------
V=$($SSH 'cd /usr/src/neo && ls phosh_0.58.0-1+neo*_arm64.deb | sed "s/.*+neo\([0-9]*\)_.*/\1/" | sort -n | tail -1')
for pkg in phosh_ phosh-common_ phosh-plugins_ phosh-mobile-tweaks_ libphosh-0.45-0_; do
    $SCP "root@$PHONE:/usr/src/neo/${pkg}0.58.0-1+neo${V}_*.deb" "$OUT/"
done
ls -l "$OUT"
