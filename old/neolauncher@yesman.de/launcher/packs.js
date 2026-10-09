// Icon-pack discovery shared by the shell side (iconpack.js) and the prefs process (prefs.js):
// only Gio/GLib here, so both can import it. A pack is a folder made by tools/import-iconpack.py:
//   ~/.local/share/neolauncher/iconpacks/<id>/{pack.json, gnome-map.json, appfilter.json, icons/*.png}
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SHAPES = [
    ['system', 'System'], ['circle', 'Circle'], ['squircle', 'Squircle'], ['rounded', 'Rounded square'], ['cupertino', 'Cupertino'],
    ['teardrop', 'Teardrop'], ['cylinder', 'Cylinder'], ['square', 'Square'], ['octagon', 'Octagon'], ['hexagon', 'Hexagon'],
    ['diamond', 'Diamond'], ['egg', 'Egg'],
];

/** The user's pack folder (where the importer and install.sh put packs). */
export function packsDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'neolauncher', 'iconpacks']);
}

/** Every folder packs are looked up in: the user's first, then the system data dirs
 *  (/usr/share/neolauncher/iconpacks for packs installed by a distribution package). */
export function packsDirs() {
    return [packsDir(), ...GLib.get_system_data_dirs().map(d => GLib.build_filenamev([d, 'neolauncher', 'iconpacks']))];
}

/** [{id, title, dir}] sorted by title; the "none" entry is added by the caller. A pack id found in
 *  the user's folder hides the same id from the system folders. */
export function listPacks() {
    const out = [];
    const seen = new Set();
    for (const dir of packsDirs()) {
        let e;
        try { e = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null); } catch (_) { continue; }
        let info;
        while ((info = e.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
            const id = info.get_name();
            if (seen.has(id)) continue;
            const meta = readJson(GLib.build_filenamev([dir, id, 'pack.json']));
            if (!meta) continue;
            seen.add(id);
            out.push({id, title: meta.title ?? id, dir: GLib.build_filenamev([dir, id]), meta});
        }
        e.close(null);
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
}

export function readJson(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch (_) { return null; }
}
