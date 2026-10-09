// Launcher data model: installed apps (Shell.AppSystem), the persisted home layout,
// folders, dock, hidden apps and launch counts — the GNOME counterpart of
// Launcher3's LauncherModel + Neo's NeoPrefs-backed state.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

export const LAYOUT_VERSION = 1;

export class LauncherModel {
    constructor(settings, log) {
        this.settings = settings; this.log = log;
        this.appSystem = Shell.AppSystem.get_default();
        this.parental = ParentalControlsManager.getDefault();
        this.rows = settings.get_int('desktop-grid-rows');
        this.cols = settings.get_int('desktop-grid-columns');
        this.dockSize = settings.get_int('dock-num-icons');
        this._counts = JSON.parse(settings.get_string('launch-counts') || '{}');
        this._listeners = new Set();
        // Two arrangements of the same home screen: portrait (the settings grid) and landscape (a wider grid
        // derived from the screen). They share membership, folder contents and the dock; positions are their own.
        this.orientation = 'portrait';
        this._portrait = this._loadLayout();
        this._landscape = null;
        this._landDims = null;
        this.layout = this._portrait;
        this.applyGrid();                 // a layout saved with another grid size is migrated before it is shown
        this._installedId = this.appSystem.connect('installed-changed', () => { this._onInstalledChanged(); });
    }

    destroy() { if (this._installedId) { this.appSystem.disconnect(this._installedId); this._installedId = 0; } }
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emit(what) { for (const fn of this._listeners) { try { fn(what); } catch (e) { logError(e); } } }

    /** All launchable apps, parental-controls filtered, sorted A→Z. */
    allApps() {
        return this.appSystem.get_installed()
            .filter(info => info.should_show() && this.parental.shouldShowApp(info))
            .map(info => this.appSystem.lookup_app(info.get_id()))
            .filter(Boolean)
            .sort((a, b) => a.get_name().localeCompare(b.get_name(), undefined, {sensitivity: 'base'}));
    }
    app(id) { return this.appSystem.lookup_app(id); }
    hidden() { return new Set(this.settings.get_strv('drawer-hidden-apps')); }
    setHidden(ids) { this.settings.set_strv('drawer-hidden-apps', [...ids]); this._emit('hidden'); }

    /** Drawer list honouring hidden apps (unless `includeHidden`: "Search hidden apps") and the sort mode. */
    drawerApps(includeHidden = false) {
        const hidden = includeHidden ? new Set() : this.hidden();
        let apps = this.allApps().filter(a => !hidden.has(a.get_id()));
        switch (this.settings.get_int('drawer-sort-mode')) {
        case 1: apps.reverse(); break;
        case 2: apps.sort((a, b) => (this._counts[b.get_id()] ?? 0) - (this._counts[a.get_id()] ?? 0) || a.get_name().localeCompare(b.get_name())); break;
        case 4: { const t = new Map(apps.map(a => [a, this._installTime(a)])); apps.sort((a, b) => t.get(b) - t.get(a)); break; }   // one stat per app, not per comparison
        default: break;      // 0 A→Z (allApps' order); 3 "by colour" is not offered (prefs) and falls back to A→Z
        }
        return apps;
    }
    /** When the app's .desktop file appeared (creation time where the filesystem records it, else its mtime), in s. */
    _installTime(app) {
        try {
            const info = Gio.File.new_for_path(app.get_app_info().get_filename()).query_info('time::created,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            return info.get_attribute_uint64('time::created') || info.get_attribute_uint64('time::modified');
        } catch (_) { return 0; }
    }

    recordLaunch(id) {
        this._counts[id] = (this._counts[id] ?? 0) + 1;
        this.settings.set_string('launch-counts', JSON.stringify(this._counts));
    }
    mostUsed(n = 5) { return Object.entries(this._counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => this.app(id)).filter(Boolean); }

    // ---------------- layout ----------------
    _loadLayout() {
        const raw = this.settings.get_string('layout');
        if (raw) { try { const l = JSON.parse(raw); if (l.version === LAYOUT_VERSION) return l; } catch (e) { this.log(`bad layout: ${e.message}`); } }
        return this._defaultLayout();
    }
    /** Persist and tell the listeners once: `what` is 'layout', or 'apps' when the installed set changed too. */
    save(what = 'layout') {
        this._persist(this.layout);
        // keep the other orientation's arrangement in step (removals, new icons, folders, dock)
        const other = this.layout === this._portrait ? this._landscape : this._portrait;
        if (other) {
            const dims = other === this._portrait ? this._portraitDims() : this._landDims;
            if (this._sync(this.layout, other, dims)) this._persist(other);
        }
        this._emit(what);
    }
    _persist(layout) {
        if (layout === this._portrait) this.settings.set_string('layout', JSON.stringify(layout));
        else this.settings.set_string('layout-landscape', JSON.stringify({...layout, dims: this._landDims}));
    }
    _portraitDims() { return {cols: this.settings.get_int('desktop-grid-columns'), rows: this.settings.get_int('desktop-grid-rows')}; }

    /**
     * Switch the arrangement the home screen shows. dims ({cols, rows}) is the landscape grid; it comes from
     * the screen, not from settings. The first landscape arrangement (or one saved for another grid size)
     * is the portrait one reflowed in reading order. Returns true when anything changed.
     */
    setOrientation(orientation, dims = null) {
        const same = orientation === this.orientation && (orientation === 'portrait' ||
            (this._landDims && dims && this._landDims.cols === dims.cols && this._landDims.rows === dims.rows));
        if (same) return false;
        if (orientation === 'landscape') {
            this._landDims = dims;
            if (!this._landscape) {
                let saved = null;
                try { saved = JSON.parse(this.settings.get_string('layout-landscape') || 'null'); } catch (_) { saved = null; }
                if (saved?.version === LAYOUT_VERSION && saved.dims?.cols === dims.cols && saved.dims?.rows === dims.rows) { delete saved.dims; this._landscape = saved; }
                else this._landscape = {version: LAYOUT_VERSION, pages: [[]], dock: [], folders: {}};
            }
            this._migrate(this._landscape, dims);
            this._sync(this._portrait, this._landscape, dims);
            this.layout = this._landscape; this.cols = dims.cols; this.rows = dims.rows;
        } else {
            if (this._landscape) this._sync(this._landscape, this._portrait, this._portraitDims());
            this.layout = this._portrait; const d = this._portraitDims(); this.cols = d.cols; this.rows = d.rows;
        }
        this.orientation = orientation;
        this._persist(this.layout);
        this._emit('orientation');      // home rebuilds its pages; the drawer's app list is the same in both
        return true;
    }

    /** Top-level items of a layout in reading order (page, then row, then column). */
    _readingOrder(layout) {
        const out = [];
        for (const page of layout.pages) out.push(...[...page].sort((a, b) => (a.row - b.row) || (a.col - b.col)));
        return out;
    }

    /**
     * Make dst hold what src holds: drop items src no longer has at the top level, give folders src's
     * contents and name, add src's other items at dst's first free cells (in src's reading order), copy the
     * dock. Positions already in dst are kept. Returns true when dst changed.
     */
    _sync(src, dst, dims) {
        const key = it => `${it.type}:${it.id}`;
        const srcItems = this._readingOrder(src);
        const srcKeys = new Set(srcItems.map(key));
        const srcFolders = new Map(srcItems.filter(it => it.type === 'folder').map(it => [it.id, it]));
        let changed = false;
        for (const page of dst.pages) {
            for (let k = page.length - 1; k >= 0; k--) {
                const it = page[k];
                if (!srcKeys.has(key(it))) { page.splice(k, 1); changed = true; continue; }
                const f = it.type === 'folder' ? srcFolders.get(it.id) : null;
                if (f && (JSON.stringify(f.items) !== JSON.stringify(it.items) || f.name !== it.name)) { it.items = [...f.items]; it.name = f.name; changed = true; }
            }
        }
        const have = new Set(dst.pages.flat().map(key));
        for (const it of srcItems) {
            if (have.has(key(it))) continue;
            const {col: _c, row: _r, ...rest} = it;
            this._placeFirstFree(dst, {...rest, ...(rest.items ? {items: [...rest.items]} : {})}, dims);
            changed = true;
        }
        const dock = JSON.stringify(src.dock ?? []);
        if (JSON.stringify(dst.dock ?? []) !== dock) { dst.dock = JSON.parse(dock); changed = true; }
        if (!this.settings.get_boolean('desktop-allow-empty-pages'))
            for (let i = dst.pages.length - 1; i >= 0 && dst.pages.length > 1; i--) if (!dst.pages[i].length) { dst.pages.splice(i, 1); changed = true; }
        return changed;
    }
    _placeFirstFree(layout, item, dims) {
        for (const page of layout.pages) {
            const used = new Set(page.map(it => `${it.col},${it.row}`));
            for (let row = 0; row < dims.rows; row++) for (let col = 0; col < dims.cols; col++)
                if (!used.has(`${col},${row}`)) { page.push({...item, col, row}); return; }
        }
        layout.pages.push([{...item, col: 0, row: 0}]);
    }
    /** Move every item outside dims (or sharing a cell) to the first free cell. Returns how many moved. */
    _migrate(layout, dims) {
        const moved = [];
        for (const page of layout.pages) {
            const seen = new Set();
            for (const it of [...page]) {
                const k = `${it.col},${it.row}`;
                if (it.col >= dims.cols || it.row >= dims.rows || seen.has(k)) { page.splice(page.indexOf(it), 1); moved.push(it); } else seen.add(k);
            }
        }
        for (const it of moved) this._placeFirstFree(layout, it, dims);
        return moved.length;
    }

    /**
     * Launcher3's default: the favourites in the dock, every other app auto-added
     * to the workspace pages (desktopIconAddInstalled) column by column, row by row.
     */
    _defaultLayout() {
        // GNOME favourites first; a phone with none set gets Neo's stock hotseat (phone, messages, browser, camera) from what is installed
        let favs = AppFavorites.getAppFavorites().getFavorites().map(a => a.get_id());
        if (!favs.length) favs = ['org.gnome.Calls.desktop', 'sm.puri.Chatty.desktop', 'firefox-esr.desktop', 'org.gnome.Snapshot.desktop'].filter(id => this.app(id));
        favs = favs.slice(0, this.dockSize);
        const dock = favs.map(id => ({type: 'app', id}));
        const rest = this.allApps().map(a => a.get_id()).filter(id => !favs.includes(id));
        const pages = [];
        let page = [], i = 0;
        for (const id of rest) {
            const col = i % this.cols, row = Math.floor(i / this.cols);
            page.push({type: 'app', id, col, row});
            i += 1;
            if (i >= this.cols * this.rows) { pages.push(page); page = []; i = 0; }
        }
        if (page.length || !pages.length) pages.push(page);
        return {version: LAYOUT_VERSION, pages, dock, folders: {}};
    }

    /** Apps present nowhere on the home screen (for auto-add of new installs). */
    _placedIds() {
        const ids = new Set();
        for (const p of this.layout.pages) for (const it of p) { if (it.type === 'app') ids.add(it.id); else if (it.type === 'folder') (it.items ?? []).forEach(x => ids.add(x)); }
        for (const it of this.layout.dock) { if (it.type === 'app') ids.add(it.id); else (it.items ?? []).forEach(x => ids.add(x)); }
        return ids;
    }

    _onInstalledChanged() {
        const installed = new Set(this.allApps().map(a => a.get_id()));
        let changed = false;
        // drop uninstalled apps
        for (const p of this.layout.pages) {
            for (let k = p.length - 1; k >= 0; k--) {
                const it = p[k];
                if (it.type === 'app' && !installed.has(it.id)) { p.splice(k, 1); changed = true; }
                if (it.type === 'folder') { const n = it.items.length; it.items = it.items.filter(id => installed.has(id)); if (it.items.length !== n) changed = true; if (!it.items.length) { p.splice(k, 1); } }
            }
        }
        this.layout.dock = this.layout.dock.filter(it => it.type !== 'app' || installed.has(it.id));
        // auto-add new installs
        if (this.settings.get_boolean('desktop-icon-add-installed')) {
            const placed = this._placedIds();
            for (const id of installed) if (!placed.has(id)) { this.addToFirstFreeCell({type: 'app', id, fresh: true}); changed = true; }
        }
        if (changed) this.save('apps'); else this._emit('apps');   // one notification: home rebuilds and the drawer refreshes once
    }

    /** Re-read the grid prefs and move every item that no longer fits (col/row outside the grid, two items in one
     *  cell, dock longer than its icon count) to the first free cell — Launcher3's GridMigration, in short. */
    applyGrid() {
        this.dockSize = this.settings.get_int('dock-num-icons');
        const pd = this._portraitDims();
        // the settings grid is the portrait one; in landscape the screen decides (setOrientation)
        const dims = this.layout === this._portrait ? pd : this._landDims;
        this.rows = dims.rows; this.cols = dims.cols;
        let moved = this._migrate(this._portrait, pd);
        if (this._landscape && this._landDims) moved += this._migrate(this._landscape, this._landDims);
        const dock = this.layout.dock ?? [];
        const extra = [];
        while (dock.length > this.dockSize) extra.push(dock.pop());
        for (const it of extra) this.addToFirstFreeCell(it);
        this._pruneEmptyPages?.();
        if (moved || extra.length) this.save();
        return moved + extra.length;
    }
    freeCell(pageIndex) {
        const used = new Set((this.layout.pages[pageIndex] ?? []).map(it => `${it.col},${it.row}`));
        for (let row = 0; row < this.rows; row++) for (let col = 0; col < this.cols; col++) if (!used.has(`${col},${row}`)) return {col, row};
        return null;
    }
    addToFirstFreeCell(item) {
        for (let p = 0; p < this.layout.pages.length; p++) { const c = this.freeCell(p); if (c) { this.layout.pages[p].push({...item, ...c}); return p; } }
        this.layout.pages.push([{...item, col: 0, row: 0}]);
        return this.layout.pages.length - 1;
    }
    removeItem(pageIndex, item) {
        const p = this.layout.pages[pageIndex]; const k = p.indexOf(item); if (k >= 0) p.splice(k, 1);
        if (!p.length && this.layout.pages.length > 1 && !this.settings.get_boolean('desktop-allow-empty-pages')) this.layout.pages.splice(pageIndex, 1);
        this.save();
    }
    /** Take an item off a page without saving (drag in progress). */
    detachItem(pageIndex, item) { const p = this.layout.pages[pageIndex]; if (!p) return; const k = p.indexOf(item); if (k >= 0) p.splice(k, 1); }
    placeItem(pageIndex, item, col, row) {
        while (this.layout.pages.length <= pageIndex) this.layout.pages.push([]);
        item.col = col; item.row = row; this.layout.pages[pageIndex].push(item);
        this._pruneEmptyPages();
    }
    _pruneEmptyPages() {
        if (this.settings.get_boolean('desktop-allow-empty-pages')) return;
        for (let i = this.layout.pages.length - 1; i >= 0 && this.layout.pages.length > 1; i--) if (!this.layout.pages[i].length) this.layout.pages.splice(i, 1);
    }
    addToDock(item, index) {
        const d = this.layout.dock; if (d.includes(item)) return true;
        if (d.length >= this.dockSize) return false;
        delete item.col; delete item.row; d.splice(Math.max(0, Math.min(d.length, index)), 0, item); return true;
    }
    removeFromDock(item, save = true) { const d = this.layout.dock; const k = d.indexOf(item); if (k >= 0) d.splice(k, 1); if (save) this.save(); }
    addToFolder(folder, item) { if (item.type === 'app' && !folder.items.includes(item.id)) folder.items.push(item.id); else if (item.type === 'folder') for (const id of item.items ?? []) if (!folder.items.includes(id)) folder.items.push(id); }
    removeFromFolder(folder, id, save = true) {
        folder.items = (folder.items ?? []).filter(x => x !== id);
        // a folder with one app left turns back into that app, an empty one disappears (Launcher3)
        for (const page of this.layout.pages) {
            const k = page.indexOf(folder); if (k < 0) continue;
            if (folder.items.length === 1) page[k] = {type: 'app', id: folder.items[0], col: folder.col, row: folder.row};
            else if (!folder.items.length) page.splice(k, 1);
        }
        const dk = this.layout.dock.indexOf(folder);
        if (dk >= 0) { if (folder.items.length === 1) this.layout.dock[dk] = {type: 'app', id: folder.items[0]}; else if (!folder.items.length) this.layout.dock.splice(dk, 1); }
        if (save) this.save();
    }
    /** Put a detached item back where it came from (failed drop). */
    restore(source, pageIndex, item, extra = {}) {
        if (source === 'home') this.placeItem(pageIndex, item, item.col ?? 0, item.row ?? 0);
        else if (source === 'dock') this.addToDock(item, this.layout.dock.length);
        else if (source === 'folder' && extra.folder) this.addToFolder(extra.folder, item);
    }
    makeFolder(pageIndex, target, dragged, name = '') {
        const p = this.layout.pages[pageIndex];
        const items = [];
        for (const it of [target, dragged]) { if (it.type === 'app') items.push(it.id); else items.push(...(it.items ?? [])); }
        const folder = {type: 'folder', id: `folder-${GLib.uuid_string_random().slice(0, 8)}`, name, items, col: target.col, row: target.row};
        for (const it of [target, dragged]) { const k = p.indexOf(it); if (k >= 0) p.splice(k, 1); }
        p.push(folder); return folder;
    }
}
