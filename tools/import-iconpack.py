#!/usr/bin/env python3
"""Turn an Android icon-pack APK into a Neo Launcher (GNOME) icon pack folder.

    import-iconpack.py <pack.apk> <pack-id> [--title "Pack name"] [--out gnome/launcher/iconpacks]

Produces  <out>/<pack-id>/pack.json         {id, title, scale, iconback[], iconmask[], iconupon[]}
                          appfilter.json    {"<android package>": "<drawable>", …}  (first component wins)
                          gnome-map.json    {"<desktop id>": "<drawable>", …}  the launcher's own lookup
                          icons/<drawable>.png   every drawable the appfilter refers to (densest copy)
                          back/mask/upon PNGs named as in pack.json

The compiled appfilter.xml is decoded with pyaxmlparser (pip install pyaxmlparser); a plain-text
assets/appfilter.xml is used when the APK ships one. The GNOME map is built from GNOME_TO_ANDROID
below: for each desktop id the first Android package the pack knows wins, then a drawable-name
fallback (KEYWORDS) so a pack without e.g. a "GNOME Calls" entry still themes the dialer.
"""
import json, os, re, shutil, sys, zipfile, tempfile

# GNOME desktop id → Android packages (most specific first) and drawable-name keywords (fallback).
GNOME_TO_ANDROID = {
    'org.gnome.Calls.desktop':        (['com.google.android.dialer', 'com.android.dialer', 'com.oneplus.dialer', 'com.samsung.android.dialer', 'com.android.contacts'], ['phone', 'dialer', 'call']),
    'sm.puri.Chatty.desktop':         (['com.google.android.apps.messaging', 'com.android.mms', 'com.oneplus.mms', 'com.samsung.android.messaging'], ['messages', 'message', 'messaging', 'sms', 'mms']),
    'org.gnome.Settings.desktop':     (['com.android.settings'], ['settings', 'setting']),
    'mobi.phosh.MobileSettings.desktop': (['com.android.settings'], ['settings', 'setting']),
    'mobi.phosh.MobileSettings.nobuiltins.desktop': (['com.android.settings'], ['settings', 'setting']),
    'org.gnome.Snapshot.desktop':     (['com.google.android.GoogleCamera', 'com.android.camera', 'com.oneplus.camera', 'com.android.camera2', 'com.sec.android.app.camera'], ['camera']),
    'org.gnome.Calendar.desktop':     (['com.google.android.calendar', 'com.android.calendar', 'com.oneplus.calendar', 'com.samsung.android.calendar'], ['calendar']),
    'org.gnome.Weather.desktop':      (['com.oneplus.weather', 'net.oneplus.weather', 'com.google.android.apps.weather', 'com.sec.android.daemonapp', 'com.miui.weather2'], ['weather', 'weather_default']),
    'org.gnome.clocks.desktop':       (['com.google.android.deskclock', 'com.android.deskclock', 'com.oneplus.deskclock', 'com.sec.android.app.clockpackage'], ['clock', 'deskclock', 'alarm']),
    'org.gnome.Calculator.desktop':   (['com.google.android.calculator', 'com.android.calculator2', 'com.oneplus.calculator', 'com.sec.android.app.popupcalculator'], ['calculator']),
    'org.gnome.Contacts.desktop':     (['com.google.android.contacts', 'com.android.contacts', 'com.samsung.android.app.contacts'], ['contacts', 'contact', 'people']),
    'org.gnome.Maps.desktop':         (['com.google.android.apps.maps', 'com.here.app.maps', 'org.osmand'], ['maps', 'map']),
    'org.gnome.Nautilus.desktop':     (['com.google.android.apps.nbu.files', 'com.android.documentsui', 'com.oneplus.filemanager', 'com.sec.android.app.myfiles', 'com.mi.android.globalFileexplorer'], ['files', 'filemanager', 'file_manager', 'file']),
    'firefox-esr.desktop':            (['org.mozilla.firefox', 'org.mozilla.fenix', 'org.mozilla.firefox_beta'], ['firefox']),
    'org.gnome.Console.desktop':      (['com.termux', 'jackpal.androidterm'], ['termux', 'terminal']),
    'org.gnome.TextEditor.desktop':   (['com.google.android.keep', 'com.oneplus.note', 'com.samsung.android.app.notes', 'com.simplemobiletools.notes.pro'], ['notes', 'note', 'keep']),
    'org.gnome.Loupe.desktop':        (['com.google.android.apps.photos', 'com.oneplus.gallery', 'com.sec.android.gallery3d', 'com.android.gallery3d'], ['gallery', 'photos']),
    'org.gnome.Decibels.desktop':     (['com.google.android.music', 'com.spotify.music', 'net.oneplus.music', 'com.samsung.android.app.music'], ['music', 'play_music']),
    'com.github.neithern.g4music.desktop': (['com.spotify.music', 'com.google.android.apps.youtube.music', 'net.oneplus.music', 'com.google.android.music'], ['music']),
    'org.gnome.Showtime.desktop':     (['com.google.android.videos', 'com.mxtech.videoplayer.ad', 'org.videolan.vlc', 'com.oneplus.gallery'], ['video', 'videos', 'movies', 'player']),
    'org.gnome.Software.desktop':     (['com.android.vending'], ['play_store', 'playstore', 'google_play_store', 'store', 'vending']),
    'org.gnome.Papers.desktop':       (['com.google.android.apps.docs', 'com.adobe.reader', 'com.google.android.apps.pdfviewer'], ['docs', 'pdf', 'documents', 'reader']),
    'org.gnome.Screenshot.desktop':   (['com.oneplus.screenshot', 'com.android.screenshot'], ['screenshot', 'screen_recorder']),
    'org.gnome.Evolution.desktop':    (['com.google.android.gm', 'com.android.email', 'com.oneplus.mail'], ['gmail', 'mail', 'email']),
    'org.gnome.Geary.desktop':        (['com.google.android.gm', 'com.android.email'], ['gmail', 'mail', 'email']),
    'org.gnome.Epiphany.desktop':     (['com.android.chrome', 'com.android.browser'], ['chrome', 'browser']),
    'org.gnome.Music.desktop':        (['com.google.android.music', 'net.oneplus.music'], ['music']),
    'org.gnome.Photos.desktop':       (['com.google.android.apps.photos', 'com.oneplus.gallery'], ['gallery', 'photos']),
    'org.gnome.Sysprof.desktop':      ([], ['developer', 'dev']),
    'org.gnome.Shell.Extensions.desktop': ([], ['extensions', 'tweaks']),
    'org.kop316.vvmplayer.desktop':   (['com.android.phone', 'com.oneplus.dialer'], ['voicemail', 'dialer', 'phone']),
    'org.gnome.Tecla.desktop':        ([], ['keyboard']),
    'org.postmarketos.Welcome.desktop': ([], ['tips', 'welcome', 'help']),
    'eu.lucaweiss.lpa_gtk.desktop':   ([], ['simcard', 'sim_card', 'sim', 'esim']),
    'htop.desktop':                   ([], ['system', 'monitor', 'task_manager']),
    'org.gnome.Tour.desktop':         ([], ['tips', 'tour']),
    'org.gnome.Characters.desktop':   ([], ['emoji', 'characters']),
    'org.gnome.Connections.desktop':  ([], ['remote', 'connections']),
    'org.gnome.Logs.desktop':         ([], ['logs', 'log']),
    'org.gnome.Usage.desktop':        ([], ['usage', 'system']),
    'org.gnome.Boxes.desktop':        ([], ['boxes', 'vm']),
    'org.gnome.SoundRecorder.desktop': (['com.oneplus.soundrecorder', 'com.google.android.apps.recorder'], ['recorder', 'sound_recorder', 'voice_recorder']),
    'org.gnome.Totem.desktop':        (['com.google.android.videos', 'org.videolan.vlc'], ['video', 'videos']),
    'org.gnome.Podcasts.desktop':     (['com.google.android.apps.podcasts'], ['podcasts', 'podcast']),
    'org.gnome.Authenticator.desktop': (['com.google.android.apps.authenticator2'], ['authenticator']),
    'org.telegram.desktop.desktop':   (['org.telegram.messenger'], ['telegram']),
    'org.signal.Signal.desktop':      (['org.thoughtcrime.securesms'], ['signal']),
    'com.spotify.Client.desktop':     (['com.spotify.music'], ['spotify']),
    'org.videolan.VLC.desktop':       (['org.videolan.vlc'], ['vlc']),
    'org.mozilla.firefox.desktop':    (['org.mozilla.firefox'], ['firefox']),
    'org.chromium.Chromium.desktop':  (['org.chromium.chrome', 'com.android.chrome'], ['chromium', 'chrome']),
    'com.google.Chrome.desktop':      (['com.android.chrome'], ['chrome']),
    'de.yesman.app.desktop':          ([], []),
}

DENSITY_ORDER = ['drawable-nodpi-v4', 'drawable-xxxhdpi-v4', 'drawable-xxhdpi-v4', 'drawable-xhdpi-v4', 'drawable-hdpi-v4', 'drawable-mdpi-v4', 'drawable']


class ResourcePool:
    """One zip-like view over an APK, or over every .apk inside an .xapk / .apks bundle (base + config splits)."""
    def __init__(self, path):
        self.path = path; self.zips = []; self.tmp = None
    def __enter__(self):
        outer = zipfile.ZipFile(self.path)
        inner = [n for n in outer.namelist() if n.lower().endswith('.apk')]
        if inner:
            self.tmp = tempfile.mkdtemp(prefix='iconpack-')
            for n in inner:
                dst = os.path.join(self.tmp, os.path.basename(n))
                with open(dst, 'wb') as f: f.write(outer.read(n))
                self.zips.append(zipfile.ZipFile(dst))
            outer.close()
        else:
            self.zips.append(outer)
        self.index = {}
        for z in self.zips:
            for n in z.namelist(): self.index.setdefault(n, z)
        return self
    def __exit__(self, *a):
        for z in self.zips: z.close()
        if self.tmp: shutil.rmtree(self.tmp, ignore_errors=True)
    def namelist(self): return list(self.index)
    def read(self, n): return self.index[n].read(n)


def decode_axml(data):
    try:
        from pyaxmlparser.core import AXMLPrinter
    except ImportError:
        sys.exit('pyaxmlparser is needed for the compiled appfilter.xml: pip install pyaxmlparser')
    return AXMLPrinter(data).get_xml().decode()


def parse_appfilter(xml):
    """{'scale': f, 'iconback': [...], 'iconmask': [...], 'iconupon': [...], 'items': [(component, drawable)]}"""
    out = {'scale': 1.0, 'iconback': [], 'iconmask': [], 'iconupon': [], 'items': []}
    for tag in ('iconback', 'iconmask', 'iconupon'):
        for m in re.finditer(r'<%s\b([^>]*)/?>' % tag, xml):
            out[tag] += re.findall(r'img\d+="([^"]+)"', m.group(1))
    m = re.search(r'<scale\b[^>]*factor="([\d.]+)"', xml)
    if m: out['scale'] = float(m.group(1))
    for m in re.finditer(r'<item\b([^>]*)/?>', xml):
        a = m.group(1)
        c = re.search(r'component="([^"]*)"', a); d = re.search(r'drawable="([^"]*)"', a)
        if c and d: out['items'].append((c.group(1), d.group(1)))
    return out


def main():
    args = sys.argv[1:]
    if len(args) < 2: sys.exit(__doc__)
    apk, pack_id = args[0], args[1]
    title = pack_id.title(); out_root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'iconpacks')
    i = 2
    while i < len(args):
        if args[i] == '--title': title = args[i + 1]; i += 2
        elif args[i] == '--out': out_root = args[i + 1]; i += 2
        else: sys.exit('unknown argument ' + args[i])
    out = os.path.join(out_root, pack_id)
    os.makedirs(os.path.join(out, 'icons'), exist_ok=True)

    with ResourcePool(apk) as z:
        names = set(z.namelist())
        if 'assets/appfilter.xml' in names and b'<item' in z.read('assets/appfilter.xml')[:200000]:
            xml = z.read('assets/appfilter.xml').decode('utf-8', 'replace')
        elif 'res/xml/appfilter.xml' in names:
            xml = decode_axml(z.read('res/xml/appfilter.xml'))
        else:
            sys.exit('no appfilter.xml in ' + apk)
        af = parse_appfilter(xml)

        # Where does each drawable live? Densest copy wins.
        located = {}
        for n in names:
            m = re.match(r'res/(drawable[^/]*)/([^/]+)\.(png|webp)$', n)
            if not m: continue
            d, base = m.group(1), m.group(2)
            rank = DENSITY_ORDER.index(d) if d in DENSITY_ORDER else 99
            if base not in located or rank < located[base][0]: located[base] = (rank, n)

        appfilter = {}
        for comp, drawable in af['items']:
            m = re.match(r'ComponentInfo\{([^/}]+)/', comp)
            if not m or drawable not in located: continue
            appfilter.setdefault(m.group(1), drawable)
        wanted = set(appfilter.values()) | set(af['iconback']) | set(af['iconmask']) | set(af['iconupon'])
        copied = 0
        for base in sorted(wanted):
            if base not in located: continue
            data = z.read(located[base][1])
            with open(os.path.join(out, 'icons', base + '.png'), 'wb') as f: f.write(data)
            copied += 1

    # GNOME map over every drawable the APK ships (a pack's generic "ic_phone" need not be in its appfilter).
    PKG_LIKE = re.compile(r'(^|_)(com|net|org|cn|de|me|tv|io|air|jp|kr|ru|uk|us|tw|app|eu|co|in|fr|it|es|br|dk|fi|be)_')
    drawables = {d for d in located if not PKG_LIKE.search(d)}
    gnome_map = {}
    for desktop, (packages, keywords) in GNOME_TO_ANDROID.items():
        # A pack's generic drawable ("calendar", "ic_phone") is its canonical design for that kind of app:
        # exact keyword names first, then the Android package table, then a loose substring match.
        hit = None
        for kw in keywords:
            exact = [d for d in drawables if d in (kw, 'ic_' + kw, kw + 's', 'ic_' + kw + 's')]
            if exact: hit = sorted(exact, key=len)[0]; break
        if not hit: hit = next((appfilter[p] for p in packages if p in appfilter), None)
        if not hit:
            for kw in keywords:
                near = [d for d in drawables if d.endswith('_' + kw) or d.startswith(kw + '_') or d.startswith('ic_' + kw + '_')]
                if near: hit = sorted(near, key=len)[0]; break
        if hit: gnome_map[desktop] = hit
    # copy the mapped drawables too (they may not be appfilter targets)
    with ResourcePool(apk) as z:
        for base in set(gnome_map.values()):
            dst = os.path.join(out, 'icons', base + '.png')
            if not os.path.exists(dst) and base in located:
                with open(dst, 'wb') as f: f.write(z.read(located[base][1])); copied += 1
    # the shape the pack designs for (OnePlus appfilter: <icon_shape value="1"/> = circle)
    m = re.search(r'<icon_shape\b[^>]*value="(\d+)"', xml)
    shape = {'1': 'circle', '2': 'squircle', '3': 'rounded', '4': 'teardrop', '5': 'square'}.get(m.group(1)) if m else None

    pack = {'id': pack_id, 'title': title, 'scale': af['scale'], 'shape': shape,
            'iconback': [b for b in af['iconback'] if b in located], 'iconmask': [b for b in af['iconmask'] if b in located], 'iconupon': [b for b in af['iconupon'] if b in located]}
    json.dump(pack, open(os.path.join(out, 'pack.json'), 'w'), indent=1)
    json.dump(appfilter, open(os.path.join(out, 'appfilter.json'), 'w'), indent=0, sort_keys=True)
    json.dump(gnome_map, open(os.path.join(out, 'gnome-map.json'), 'w'), indent=1, sort_keys=True)
    print(f'{pack_id}: {len(af["items"])} appfilter items, {len(appfilter)} packages, {copied} icons copied, scale {af["scale"]}, back/mask/upon {len(pack["iconback"])}/{len(pack["iconmask"])}/{len(pack["iconupon"])}, {len(gnome_map)} GNOME apps mapped')
    for k, v in sorted(gnome_map.items()): print(f'   {k:45s} → {v}')


if __name__ == '__main__':
    main()
