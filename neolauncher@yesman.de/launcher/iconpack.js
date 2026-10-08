// Icon packs and icon shapes (Neo Launcher: Theme › Icon pack / Icon shape / Adaptive icons).
//
// Every launcher icon goes through iconActor(app, size): the app's icon is rendered once with cairo
// into ~/.cache/neolauncher/icons/<key>.png and shown as a file GIcon, so the home grid, dock,
// drawer, folder previews, drag view and recents chips all agree. The key covers the pack, the
// shape, the two treatment switches, the app and the pixel size: a settings change simply misses
// the cache and renders again.
//
//   pack icon      the pack maps the desktop id (gnome-map.json, built by tools/import-iconpack.py)
//                  → the pack's PNG as the pack drew it (its own shape).
//   wrapped icon   the pack has iconback/iconmask/iconupon (Android pack convention) and
//                  "Wrap unthemed icons" is on → back, the app icon scaled by the pack's factor,
//                  the mask cut out (DEST_OUT, as ADW/Nova do), upon drawn over.
//   legacy icon    no pack art: "Shape legacy icons" draws the app icon at the adaptive safe-zone
//                  size on a background tinted from the icon's own colours, clipped to the shape.
//   plain          none of the above → the app icon as the theme ships it.
// The drawing itself is iconrender.js (no shell imports): run in render-worker.js's own process, and here
// in-process only when the worker cannot be started.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const here = import.meta.url.replace(/\/[^/]*$/, '');
const {listPacks, readJson, SHAPES} = await import(`${here}/packs.js?gen=${gen}`);
const {Renderer} = await import(`${here}/iconrender.js?gen=${gen}`);
export {SHAPES};

const RENDER_VERSION = 5;        // bump when the drawing changes so cached PNGs are not reused
const MAX_INFLIGHT = 4;          // jobs in the worker's pipe at once

let _packs = null;

const ASSETS = Gio.File.new_for_uri(here.replace(/\?.*$/, '')).get_parent().get_child('assets');

export function initIconPacks(settings) { _packs = new IconPacks(settings); return _packs; }
export function iconPacks() { return _packs; }

/** The actor for an app at `size` logical px: the themed/shaped render when there is one, else the stock texture.
 *  A render that is not cached yet is NOT done here: the stock icon shows at once and the pack version is
 *  drawn a few per frame in the background and swapped in — a pack or shape change used to render every
 *  app synchronously and froze the shell for ten seconds. */
export function iconActor(app, size) {
    if (!app) return new St.Icon({icon_name: 'application-x-executable', icon_size: size});
    const cached = _packs?.giconIfCached(app, size);
    if (cached) return new St.Icon({gicon: cached, icon_size: size});
    const icon = app.create_icon_texture(size);
    if (cached === undefined && _packs) _packs.renderLater(app, size, gicon => { if (gicon && icon.get_parent() && icon.set_gicon) icon.set_gicon(gicon); });
    return icon;
}

class IconPacks {
    constructor(settings) {
        this._settings = settings;
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'neolauncher', 'icons']);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);
        this._theme = St.IconTheme.new();
        this._memo = new Map();
        this.reload();
    }

    /** Re-read the settings and the selected pack; cached renders keyed on them are simply bypassed. */
    reload() {
        const s = this._settings;
        this.shape = s.get_string('icon-shape');
        this.legacy = s.get_boolean('icon-legacy-treatment');
        this.wrap = s.get_boolean('icon-pack-wrap');
        this.packId = s.get_string('icon-pack');
        this.pack = null;
        if (this.packId) {
            const p = listPacks().find(x => x.id === this.packId);
            if (p) this.pack = {...p, map: readJson(GLib.build_filenamev([p.dir, 'gnome-map.json'])) ?? {}};
        }
        this._memo.clear();
        this._pending?.clear(); this._jobs = [];   // results for the previous pack/shape are no longer wanted
    }

    /** Have the worker render every installed app at the given sizes ahead of time (it runs in its own process). */
    prewarm(sizes) {
        // queued a few apps per idle tick: the cache checks and icon-theme lookups for ~100 apps at once took ~270 ms
        const apps = Shell.AppSystem.get_default().get_installed().map(i => i.get_id());
        const gen = (this._prewarmGen = (this._prewarmGen ?? 0) + 1);
        if (this._prewarmId) GLib.source_remove(this._prewarmId);
        this._prewarmId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (gen !== this._prewarmGen) return GLib.SOURCE_REMOVE;
            for (let k = 0; k < 8 && apps.length; k++) {
                const a = Shell.AppSystem.get_default().lookup_app(apps.shift()); if (!a) continue;
                for (const sz of sizes) if (this.giconIfCached(a, sz) === undefined) this.renderLater(a, sz, null);
            }
            if (apps.length) return GLib.SOURCE_CONTINUE;
            this._prewarmId = 0; return GLib.SOURCE_REMOVE;
        });
    }
    stopPrewarm() { if (this._prewarmId) { GLib.source_remove(this._prewarmId); this._prewarmId = 0; } this._dropWorker(); }

    /** The system shape: what the pack asks for (OnePlus ships circles), else a squircle like a Pixel. */
    get effectiveShape() { return this.shape === 'system' ? (this.pack?.meta?.shape ?? 'squircle') : this.shape; }

    _keyFor(app, size) {
        // The mobile shell lays out in logical px (360×800) with a 3× resource scale: St loads a GIcon at size × 3, so render at that.
        const scale = Main.layoutManager.primaryMonitor?.geometry_scale || St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const px = Math.round(size * scale);
        const key = `v${RENDER_VERSION}|${this.packId}|${this.effectiveShape}|${this.legacy ? 1 : 0}|${this.wrap ? 1 : 0}|${app.get_id()}|${px}`;
        return {px, key, path: GLib.build_filenamev([this._cacheDir, GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, key, -1) + '.png'])};
    }

    /** The gicon when it is already rendered (memo or PNG on disk), null when nothing custom applies, undefined when a render is still needed. */
    giconIfCached(app, size) {
        const {key, path} = this._keyFor(app, size);
        if (this._memo.has(key)) return this._memo.get(key);
        if (!this.pack && this.shape === 'system') { this._memo.set(key, null); return null; }   // stock icons: nothing to draw
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) { const g = new Gio.FileIcon({file: Gio.File.new_for_path(path)}); this._memo.set(key, g); return g; }
        return undefined;
    }

    /** Queue a render in the worker process; `cb(gicon|null)` runs when the PNG exists (or nothing custom applies).
     *  Several cells asking for the same app share one job. The shell never draws an icon itself. */
    renderLater(app, size, cb) {
        const {px, key, path} = this._keyFor(app, size);
        const pending = (this._pending ??= new Map());
        if (pending.has(key)) { if (cb) pending.get(key).cbs.push(cb); return; }
        pending.set(key, {path, cbs: cb ? [cb] : []});
        const job = this._jobFor(app, px, key, path);
        // at most a few jobs in the pipe: writing a whole pack at once would fill it and block the shell
        (this._jobs ??= []).push({job, app, size});
        this._pump();
    }
    /** Everything iconrender.js's Renderer needs (it has no shell, so no icon theme and no app objects). */
    _jobFor(app, px, key, path) {
        const id = app.get_id();
        const pm = this.pack?.map?.[id];
        return {key, id, px, path, shape: this.effectiveShape, rawShape: this.shape, legacy: this.legacy, wrap: this.wrap,
            pack: this.pack ? {dir: this.pack.dir, meta: this.pack.meta, map: pm ? {[id]: pm} : {}} : null,
            srcFile: this._srcFileFor(app, px), assetsDir: ASSETS.get_path(), cacheDir: this._cacheDir};
    }
    _pump() {
        this._inflight ??= 0;
        while (this._inflight < MAX_INFLIGHT && this._jobs?.length) {
            const {job, app, size} = this._jobs.shift();
            if (!this._pending?.has(job.key)) continue;              // dropped by a reload
            if (this._send(job)) { this._inflight++; continue; }
            const p = this._pending.get(job.key); this._pending.delete(job.key);   // no worker: draw here (slow, but correct)
            let g = null; try { g = this.giconFor(app, size); } catch (_) {}
            for (const f of p.cbs) { try { f(g); } catch (_) {} }
        }
    }

    /** The app icon's file at about `px`, resolved with the shell's icon theme (the worker has none). */
    _srcFileFor(app, px) {
        const gicon = app.get_icon(); if (!gicon) return null;
        if (gicon instanceof Gio.FileIcon) return gicon.get_file().get_path();
        if (gicon instanceof Gio.ThemedIcon) for (const name of gicon.get_names()) { const f = this._theme.lookup_icon(name, px, 0)?.get_filename(); if (f) return f; }
        return null;
    }

    _send(job) {
        if (!this._worker) {
            try {
                const script = Gio.File.new_for_uri(here.replace(/\?.*$/, '')).get_child('render-worker.js').get_path();
                this._worker = Gio.Subprocess.new(['gjs', '-m', script], Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
                this._wIn = this._worker.get_stdin_pipe();
                this._wOut = new Gio.DataInputStream({base_stream: this._worker.get_stdout_pipe()});
                const w = this._worker;
                const readNext = () => this._wOut?.read_line_async(GLib.PRIORITY_DEFAULT, null, (st, res) => {
                    let line = null; try { [line] = st.read_line_finish_utf8(res); } catch (_) {}
                    if (line === null) { if (this._worker === w) this._dropWorker(); return; }
                    this._onResult(line); readNext();
                });
                readNext();
            } catch (e) { console.warn(`[neolauncher] render worker: ${e.message}`); this._worker = null; return false; }
        }
        try { this._wIn.write_all(new TextEncoder().encode(JSON.stringify(job) + '\n'), null); return true; }
        catch (e) { this._dropWorker(); return false; }
    }
    _onResult(line) {
        this._inflight = Math.max(0, (this._inflight ?? 1) - 1);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this._pump(); return GLib.SOURCE_REMOVE; });
        const sp = line.indexOf(' '), status = line.slice(0, sp), key = line.slice(sp + 1);
        const job = this._pending?.get(key); if (!job) return;
        this._pending.delete(key);
        const gicon = status === 'ok' ? new Gio.FileIcon({file: Gio.File.new_for_path(job.path)}) : null;
        this._memo.set(key, gicon);
        for (const f of job.cbs) { try { f(gicon); } catch (_) {} }
    }
    _dropWorker() {
        try { this._worker?.force_exit(); } catch (_) {}
        this._worker = null; this._wIn = null; this._wOut = null;
        this._pending?.clear(); this._jobs = []; this._inflight = 0;
    }

    /** In-process fallback when there is no worker: the same Renderer, run here (slow, but correct). */
    giconFor(app, size) {
        const {px, key, path} = this._keyFor(app, size);
        if (this._memo.has(key)) return this._memo.get(key);
        let gicon = null;
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
                GLib.mkdir_with_parents(this._cacheDir, 0o755);   // the cache dir may have been wiped since enable()
                if (!new Renderer(this._jobFor(app, px, key, path)).run(px, path)) { this._memo.set(key, null); return null; }
            }
            gicon = new Gio.FileIcon({file: Gio.File.new_for_path(path)});
        } catch (e) { if (GLib.getenv('NEOLAUNCHER_DEBUG') || this._settings.get_boolean('debug-logging')) console.warn(`[neolauncher] icon ${app.get_id()}: ${e.message}`); gicon = null; }
        this._memo.set(key, gicon);
        return gicon;
    }
}
