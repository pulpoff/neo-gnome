const {firstDelta, firstBegin, firstPoint} = await import(`${import.meta.url.replace(/\/[^/]*$/, '')}/gesture.js?gen=${(import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0'}`);
// All Apps drawer (NEO-SPEC §1.3/§2.4/§3.2): full-screen sheet sliding up over the
// workspace, search pill (48 dp), vertical alphabetical 5-column grid with 104 dp
// cells; manual drag commits past 60 % of the travel, atomic open 600 ms / close 300 ms.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const here = import.meta.url.replace(/\/[^/]*$/, '');
const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const {AppCell} = await import(`${here}/icons.js?gen=${gen}`);

const sectionLetter = name => { const c = (name.trim()[0] ?? '#').toUpperCase(); return /[A-Z]/.test(c) ? c : /[0-9]/.test(c) ? '#' : c; };
// the theme's drawer colour (stylesheet.css), for a see-through background without a custom colour
const THEME_BG = {light: '#FAFAFA', dark: '#212121', black: '#000000'};
const D = {cellH: 104, borderY: 16, sidePad: 16, railW: 20, thumbW: 4, thumbH: 60, searchH: 48, searchMargin: 12, headerTop: 36, headerBottom: 14, openMs: 600, closeMs: 300, commit: 0.6};

export const Drawer = GObject.registerClass({GTypeName: `NeoDrawer_${gen}`},
class Drawer extends St.Widget {
    _init(home) {
        super._init({style_class: 'neo-drawer', reactive: true, x_expand: true, y_expand: true, layout_manager: new Clutter.BinLayout(), visible: false});
        this.home = home; this.settings = home.settings; this.model = home.model;
        this._progress = 0;          // 0 closed … 1 open (ALL_APPS_VERTICAL_PROGRESS)
        this._content = new St.BoxLayout({style_class: 'neo-drawer-content', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, reactive: true});   // reactive: a non-reactive actor's gestures never see the touch
        this.add_child(this._content);
        // search pill
        this._search = new St.Entry({style_class: 'neo-search', hint_text: 'Search apps', can_focus: true, x_expand: true});
        this._search.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 24}));
        const clear = new St.Icon({icon_name: 'edit-clear-symbolic', icon_size: 20, reactive: true, visible: false});
        const more = new St.Icon({icon_name: 'view-more-symbolic', icon_size: 20, style_class: 'neo-search-more'});
        const tail = new St.BoxLayout(); tail.add_child(clear); tail.add_child(more);
        this._search.set_secondary_icon(tail);
        // St.Entry owns clicks on its icons: × clears, ⋮ opens the home options
        this._search.connect('secondary-icon-clicked', () => { if (this._search.text) { this._search.text = ''; this._search.grab_key_focus(); } else this.home.runGesture('options_popup', {x: 300, y: 60}); });
        this._search.clutter_text.connect('text-changed', () => { clear.visible = this._search.text.length > 0; more.visible = !clear.visible; this._applyFilter(); });
        this._search.clutter_text.connect('activate', () => this._activateFirst());
        const searchBin = new St.Bin({style_class: 'neo-search-bin', x_expand: true, child: this._search, visible: this.settings.get_boolean('search-drawer-enabled')});
        this._content.add_child(searchBin);
        // grid
        this._scroll = new St.ScrollView({style_class: 'neo-drawer-scroll', x_expand: true, y_expand: true, overlay_scrollbars: true});
        this._scroll.set_policy?.(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);   // EXTERNAL kills St's touch scrolling; the overlay bar is hidden in the stylesheet instead
        this._gridBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._results = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, visible: false});   // search hits, packed from the top
        this._gridBox.add_child(this._results);
        this._scroll.set_child(this._gridBox);
        // The list covers the screen, so a scroll changes every pixel anyway: repaint all of it. With only the
        // region the shell computed, a band at the bottom (about a row high) kept the old picture while scrolling.
        this._scroll.vadjustment.connectObject('notify::value', () => global.stage.queue_redraw(), this);
        // list + A–Z rail (Launcher3 RecyclerViewFastScroller + letter sections) overlaid at the right edge
        const listBox = new St.Widget({layout_manager: new Clutter.FixedLayout(), clip_to_allocation: true});
        listBox.add_child(this._scroll);
        // RecyclerViewFastScroller: a thin thumb at the grid's right edge that follows the scroll and can be dragged;
        // the letter bubble shows the section under the finger while dragging (Launcher3 has no permanent A–Z rail).
        this._rail = new St.Widget({style_class: 'neo-az-rail', reactive: true, layout_manager: new Clutter.FixedLayout()});
        this._thumb = new St.Widget({style_class: 'neo-fast-thumb', width: D.thumbW, height: D.thumbH});
        this._rail.add_child(this._thumb);
        listBox.add_child(this._rail);
        this._bubble = new St.Label({style_class: 'neo-az-bubble', visible: false});
        listBox.add_child(this._bubble);
        this._listBox = listBox;
        this._content.add_child(listBox);
        // paged layout (drawer-layout 1): pages of cols×rows with dots
        this._pagedBox = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true, visible: false, clip_to_allocation: true, reactive: true});
        this._pagesStrip = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this._pagedBox.add_child(this._pagesStrip);
        this._pagedDots = new St.BoxLayout({style_class: 'neo-page-dots', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END, y_expand: true, x_expand: true});
        this._pagedBox.add_child(this._pagedDots);
        this._content.add_child(this._pagedBox);
        this._setupRail(); this._setupPagedSwipe();
        this._rows = [];
        this.refresh();
        this.connect('notify::allocation', () => { this._sizeList(); this._applyProgress(this._progress, false); });
        // Only the app set matters here: a drag/drop or rename ('layout') changes nothing in the drawer, hidden apps
        // arrive through the drawer-hidden-apps setting (home), and home refreshes it after a rotation, off the animation.
        // 'apps' fires on every installed-changed (a desktop file touched by a background refresh): rebuild only when
        // what the drawer shows changed, or the rows rebuilt in idle made icons blink when the drawer was opened
        this._unsub = this.model.onChange(what => { if (what === 'apps' && this._drawerSignature() !== this._builtSignature) this.refresh(); });
        // the shell's overview swipe is given back by home (_onDestroy), not here
        this.connect('destroy', () => {
            this._destroyed = true;
            this._unsub?.();
            if (this._resetTimer) { GLib.source_remove(this._resetTimer); this._resetTimer = 0; }
            if (this._buildId) { GLib.source_remove(this._buildId); this._buildId = 0; }
            this._progressAdj?.remove_transition('value');
        });
        // One pan gesture does both jobs, as AllAppsContainerView does on Android: a finger moving down with the
        // list at its top drags the drawer closed; any other movement scrolls the list (the gesture claims the
        // touch before St's own scrolling sees it, so the list is scrolled here, with a flick at the end).
        const pan = new Clutter.PanGesture();
        let dragging = false, scrolling = false;
        const adj = () => this._scroll.vadjustment;
        let lastY = 0;
        pan.connect('recognize', () => { dragging = false; scrolling = false; lastY = 0; });
        pan.connect('pan-update', g => {
            const dy = firstDelta(g)[1]; const stepY = dy - lastY; lastY = dy;
            if (!dragging && !scrolling) { if (dy > 0 && (adj()?.value ?? 0) <= 0) dragging = true; else scrolling = true; }
            if (dragging) this._applyProgress(1 - Math.max(0, dy) / this._travel(), false);
            else if (scrolling) { const a = adj(); if (a) a.value = Math.max(0, Math.min(a.upper - a.page_size, a.value - stepY)); }
        });
        pan.connect('end', g => {
            const dy = firstDelta(g)[1]; const vy = g.get_velocity().get_y() * 1000;
            if (dragging) { if (dy / this._travel() > (1 - D.commit) || vy > 500) this.close(); else this._animateTo(1, 200); }
            else if (scrolling) { const a = adj(); if (a && Math.abs(vy) > 100) a.ease(Math.max(0, Math.min(a.upper - a.page_size, a.value - vy * 0.35)), {duration: 450, mode: Clutter.AnimationMode.EASE_OUT_CUBIC}); }
        });
        pan.connect('cancel', () => { if (dragging) this._animateTo(1, 200); });
        this.home.guardBack?.(pan); this._content.add_action(pan);
        this._search.clutter_text.connect('key-press-event', (t, ev) => { if (ev.get_key_symbol() === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; } return Clutter.EVENT_PROPAGATE; });
    }

    _travel() { return this.get_height() || Main.layoutManager.primaryMonitor.height; }
    /** The list box sizes itself from the drawer, never from its own children (a FixedLayout's natural size would feed back). */
    _sizeList() {
        const H = this._travel(), W = this.get_width() || Main.layoutManager.primaryMonitor.width;
        const node = this._content.get_theme_node(); const padT = node.get_padding(St.Side.TOP), padB = node.get_padding(St.Side.BOTTOM), padL = node.get_padding(St.Side.LEFT), padR = node.get_padding(St.Side.RIGHT);
        const searchH = this._content.get_first_child().visible ? this._content.get_first_child().get_preferred_height(-1)[1] : 0;
        const w = Math.max(1, W - padL - padR), h = Math.max(1, H - padT - padB - searchH - (searchH ? D.searchMargin : 0));
        // The list runs to the screen's top and bottom edges and scrolls under the status bar: the space the
        // first row keeps below the bar (or the search field) and after the last row is padding inside it.
        // Spacers, not padding: St's scroll view clips its child to the box inside the child's padding, so padded
        // rows stopped 50 px below the top and 14 px above the bottom instead of reaching the edges.
        this._padTop = searchH ? 14 : 50; this._padBottom = 14;
        this._syncSpacers();
        if (this._listBox.width === w && this._listBox.height === h && this._scroll.width === w && this._scroll.height === h) return;
        this._listBox.set_size(w, h); this._scroll.set_size(w, h);
        this._placeRail(w, h);
    }
    /** Launcher3's fast scroller has its own strip at the grid's right edge; the cells make room for it. */
    /** The first and last children of the grid: the space before the first row and after the last one. */
    _syncSpacers() {
        const box = this._gridBox;
        if (!this._spaceTop || this._spaceTop.get_parent() !== box) { this._spaceTop = new St.Widget(); box.insert_child_at_index(this._spaceTop, 0); }
        if (!this._spaceBottom || this._spaceBottom.get_parent() !== box) { this._spaceBottom = new St.Widget(); box.add_child(this._spaceBottom); }
        if (box.get_first_child() !== this._spaceTop) box.set_child_below_sibling(this._spaceTop, null);
        if (box.get_last_child() !== this._spaceBottom) box.set_child_above_sibling(this._spaceBottom, null);
        this._spaceTop.height = this._padTop ?? 50; this._spaceBottom.height = this._padBottom ?? 14;
    }
    _placeRail(w, h) {
        this._rail.set_size(D.railW, h); this._rail.set_position(w - D.railW, 0);
        this._updateThumb();
    }
    _cellW(cols) { return Math.floor((Main.layoutManager.primaryMonitor.width - 2 * D.sidePad - D.railW) / cols); }

    /** What the grid is built from: the apps in order and the settings that shape it. */
    _drawerSignature() {
        const k = n => (this.settings.settings_schema.has_key(n) ? this.settings.get_value(n).print(false) : '');
        return JSON.stringify([this.model.drawerApps().map(a => a.get_id()),
            ['drawer-grid-columns', 'drawer-layout', 'drawer-sort-mode', 'drawer-app-suggestions', 'drawer-hide-labels',
             'drawer-icon-scale', 'drawer-label-scale', 'drawer-multiline-label', 'drawer-hidden-apps'].map(k),
            this.home?.drawerColumns?.() ?? 0]);
    }
    refresh(...args) {
        this._builtSignature = this._drawerSignature();
        this._refresh(...args);
        this._syncSpacers();              // the rebuild cleared them; they go back first and last
    }
    _refresh() {
        if (this._buildId) { GLib.source_remove(this._buildId); this._buildId = 0; }   // the rows it would add belong to the old grid
        this.applyBackground();
        this._gridBox.destroy_all_children(); this._cells = []; this._resultCells = []; this._sections = [];
        this._results = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, visible: false}); this._gridBox.add_child(this._results);   // destroyed with the rows above
        this._pagesStrip.destroy_all_children(); this._pagedDots.destroy_all_children(); this._pagedPages = [];
        const cols = (this.home?.drawerColumns?.() ?? this.settings.get_int('drawer-grid-columns'));
        const opts = this._cellOpts();
        let apps = this.model.drawerApps();
        this._layout = this.settings.get_int('drawer-layout');
        const paged = this._layout === 1 || this._layout === 3;
        this._scroll.get_parent().visible = !paged; this._pagedBox.visible = paged;
        if (paged) { this._buildPaged(apps, cols, opts); this._applyFilter(); return; }
        if (this.settings.get_boolean('drawer-app-suggestions')) {
            const sug = this.model.mostUsed(cols);
            if (sug.length) { this._addRow(sug.map(a => ({type: 'app', id: a.get_id()})), cols, opts, 'neo-drawer-row suggestions'); this._gridBox.add_child(new St.Widget({style_class: 'neo-drawer-divider'})); }
        }
        const alpha = this.settings.get_int('drawer-sort-mode') <= 1;
        let i = 0;
        const buildRows = (n) => {
            for (const end = Math.min(apps.length, i + n * cols); i < end; i += cols) {
                const row = this._addRow(apps.slice(i, i + cols).map(a => ({type: 'app', id: a.get_id()})), cols, opts);
                if (alpha) for (const a of apps.slice(i, i + cols)) { const L = sectionLetter(a.get_name()); if (!this._sections.some(x => x.letter === L)) this._sections.push({letter: L, row}); }
            }
        };
        buildRows(12);                       // two screenfuls now; the rest while idle (each row is 5 St widgets)
        if (i < apps.length) this._buildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._destroyed) { this._buildId = 0; return GLib.SOURCE_REMOVE; }
            buildRows(2); this._applyFilter(); this._updateThumb();
            if (i < apps.length) return GLib.SOURCE_CONTINUE;
            this._buildId = 0; return GLib.SOURCE_REMOVE;
        });
        this._updateThumb();
        this._applyFilter();
        this.home.updateDots?.();
        if (this._listBox.width > 1) this._placeRail(this._listBox.width, this._listBox.height);
        this._rail.visible = !this.settings.get_boolean('drawer-hide-scrollbar');
    }
    _buildPaged(apps, cols, opts) {
        const rows = Math.max(1, Math.floor((this._travel() - D.headerTop - D.searchH - D.searchMargin * 2 - 40) / (D.cellH + D.borderY)));
        const per = cols * rows, W = Main.layoutManager.primaryMonitor.width - 2 * D.sidePad;
        for (let p = 0; p * per < apps.length; p++) {
            const page = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, width: W});
            const chunk = apps.slice(p * per, (p + 1) * per);
            for (let i = 0; i < chunk.length; i += cols) {
                const row = new St.BoxLayout({style_class: 'neo-drawer-row', x_expand: true, height: D.cellH + D.borderY});
                for (const a of chunk.slice(i, i + cols)) { const cell = this._makeCell({type: 'app', id: a.get_id()}, opts); row.add_child(cell); }
                for (let k = chunk.slice(i, i + cols).length; k < cols; k++) row.add_child(new St.Widget({width: Math.floor(W / cols)}));
                page.add_child(row);
            }
            page.set_position(p * W, 0); this._pagesStrip.add_child(page); this._pagedPages.push(page);
            const dot = new St.Widget({style_class: 'neo-dot', width: 8, height: 8, opacity: p === 0 ? 255 : 100}); this._pagedDots.add_child(dot);
        }
        this._pagedIndex = 0; this._pagesStrip.set_position(0, 0);
    }
    _cellOpts() {
        return {showLabel: !this.settings.get_boolean('drawer-hide-labels'), iconScale: this.settings.get_double('drawer-icon-scale'), labelScale: this.settings.get_double('drawer-label-scale'), multiline: this.settings.get_boolean('drawer-multiline-label'), model: this.model, home: this.home};
    }
    /** Drawer background: the theme's colour, or the custom colour (#AARRGGBB / #RRGGBB), times the opacity setting. */
    applyBackground() {
        const custom = this.settings.get_boolean('drawer-custom-background'), opacity = this.settings.get_double('drawer-background-opacity');
        if (!custom && opacity >= 1) { this.set_style(null); return; }      // the stylesheet's theme colour as it is
        const hex = (custom ? this.settings.get_string('drawer-background-color') : null) || THEME_BG[this.home._theme] || THEME_BG.dark;
        const m = hex.match(/^#([0-9a-f]{2})?([0-9a-f]{6})$/i); if (!m) { this.set_style(null); return; }
        const n = parseInt(m[2], 16), a = (m[1] ? parseInt(m[1], 16) / 255 : 1) * opacity;
        this.set_style(`background-color: rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(3)});`);
    }
    /** A new app cell, kept in `list` (the grid's cells, or the search results' own list). */
    _makeCell(it, opts, list = this._cells) {
        const cols = (this.home?.drawerColumns?.() ?? this.settings.get_int('drawer-grid-columns'));
        const cell = new AppCell(it, opts); cell.set_size(this._cellW(cols), D.cellH + D.borderY);
        cell.connect('long-press', c => this.home._onCellLongPress(c, 'drawer'));
        cell.connect('drag-start', (c, g) => this.home.drag.begin(c, 'drawer', g));
        cell.connect('launched', () => this.close());
        list.push(cell); return cell;
    }
    /** Thumb position from the adjustment, like RecyclerViewFastScroller.updateThumbOffset. */
    _updateThumb() {
        const adj = this._scroll.vadjustment; if (!adj) return;
        const range = Math.max(0, adj.upper - adj.page_size), h = this._rail.height || 1;
        this._thumb.visible = range > 1;
        this._thumb.set_position(Math.round(this._rail.width - D.thumbW), Math.round((h - D.thumbH) * (range > 0 ? adj.value / range : 0)));
    }
    _setupRail() {
        this._scroll.vadjustment.connect('notify::value', () => this._updateThumb());
        this._scroll.vadjustment.connect('notify::upper', () => this._updateThumb());
        const jump = (y, show) => {
            const adj = this._scroll.vadjustment; const range = Math.max(0, adj.upper - adj.page_size);
            const [, ry] = this._rail.get_transformed_position(); const h = Math.max(1, this._rail.height - D.thumbH);
            const f = Math.max(0, Math.min(1, (y - ry - D.thumbH / 2) / h));
            adj.value = f * range;
            // the section whose first row is at or above the viewport top
            let sec = null; for (const x of this._sections) { if (x.row.y <= adj.value + 1) sec = x; else break; }
            this._bubble.text = sec?.letter ?? ''; this._bubble.visible = show && !!sec;
            const [, ly] = this._rail.get_parent().get_transformed_position();
            this._bubble.set_position(Math.round(this._rail.x - 72), Math.round(y - ly - 28));
        };
        const pan = new Clutter.PanGesture({pan_axis: Clutter.PanAxis.Y});
        pan.connect('recognize', g => jump(firstBegin(g)[1], true));
        pan.connect('pan-update', g => jump(firstPoint(g)[1], true));
        pan.connect('end', () => { this._bubble.visible = false; });
        pan.connect('cancel', () => { this._bubble.visible = false; });
        this.home.guardBack?.(pan); this._rail.add_action(pan);
        const click = new Clutter.ClickGesture();
        click.connect('recognize', g => { jump(g.get_point_coords_abs(0).y, false); });
        this._rail.add_action(click);
    }
    _setupPagedSwipe() {
        const pan = new Clutter.PanGesture({pan_axis: Clutter.PanAxis.X});
        let x0 = 0;
        pan.connect('recognize', () => { x0 = this._pagesStrip.x; this._pagesStrip.remove_all_transitions(); });
        pan.connect('pan-update', g => { const total = {get_x: () => firstDelta(g)[0]}; this._pagesStrip.x = x0 + total.get_x(); });
        pan.connect('end', g => {
            const W = Main.layoutManager.primaryMonitor.width - 2 * D.sidePad; const vx = g.get_velocity().get_x() * 1000; const [, total] = g.get_delta(); const dx = total.get_x();
            let next = this._pagedIndex; if (Math.abs(vx) > 500) next += vx < 0 ? 1 : -1; else if (Math.abs(dx) > W * 0.4) next += dx < 0 ? 1 : -1;
            this._snapPaged(Math.max(0, Math.min(this._pagedPages.length - 1, next)));
        });
        pan.connect('cancel', () => this._snapPaged(this._pagedIndex));
        this._pagedBox.add_action(pan);
    }
    _snapPaged(i) {
        const W = Main.layoutManager.primaryMonitor.width - 2 * D.sidePad; this._pagedIndex = i;
        this._pagesStrip.ease({x: -i * W, duration: 350, mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        this._pagedDots.get_children().forEach((d, k) => d.ease({opacity: k === i ? 255 : 100, duration: 200}));
    }
    _addRow(items, cols, opts, cls = 'neo-drawer-row') {
        const row = new St.BoxLayout({style_class: cls, x_expand: true, height: D.cellH + D.borderY});
        for (const it of items) row.add_child(this._makeCell(it, opts));
        for (let k = items.length; k < cols; k++) row.add_child(new St.Widget({width: this._cellW(cols)}));
        this._gridBox.add_child(row);
        return row;
    }
    _applyFilter() {
        const q = (this._search.text ?? '').trim().toLowerCase();
        if (!q) { this._results.visible = false; this._results.destroy_all_children(); this._resultCells = []; for (const r of this._gridBox.get_children()) r.visible = r !== this._results; for (const c of this._cells) c.visible = true; return; }
        const fuzzy = this.settings.get_boolean('search-fuzzy');
        const colsNow = (this.home?.drawerColumns?.() ?? this.settings.get_int('drawer-grid-columns'));
        const match = name => { const n = name.toLowerCase(); if (n.startsWith(q) || n.split(/\s+/).some(w => w.startsWith(q))) return true; if (fuzzy) { let i = 0; for (const ch of n) if (ch === q[i]) i++; return i === q.length; } return false; };
        for (const c of this._cells) c.visible = match(c.app?.get_name() ?? '');
        // AllAppsRecyclerView shows the hits as a fresh grid right under the search bar, not the full grid with holes
        for (const r of this._gridBox.get_children()) r.visible = false;
        this._results.destroy_all_children(); this._results.visible = true;
        const hits = this.model.drawerApps(this.settings.get_boolean('search-hidden-apps')).filter(a => match(a.get_name()));
        const opts = this._cellOpts();
        this._resultCells = [];                     // result cells are not part of the grid's cell list (destroyed per query)
        for (let i = 0; i < hits.length; i += colsNow) {
            const row = new St.BoxLayout({style_class: 'neo-drawer-row', x_expand: true, height: D.cellH + D.borderY});
            for (const a of hits.slice(i, i + colsNow)) row.add_child(this._makeCell({type: 'app', id: a.get_id()}, opts, this._resultCells));
            for (let k = hits.length - i; k < colsNow && k > 0; k++) row.add_child(new St.Widget({width: this._cellW(colsNow)}));
            this._results.add_child(row);
        }
        if (this._scroll.vadjustment) this._scroll.vadjustment.value = 0;
        for (const p of this._pagedPages ?? []) for (const r of p.get_children()) { const cells = r.get_children().filter(x => x instanceof AppCell); r.visible = cells.some(c => c.visible); }
    }
    _activateFirst() {
        const first = this._results?.visible ? this._resultCells?.[0] : this._cells.find(c => c.visible);
        if (first) first.activate();
        else if (this.settings.get_boolean('search-global') && this._search.text.trim()) { Gio.AppInfo.launch_default_for_uri(this.settings.get_string('search-provider').replace('%s', encodeURIComponent(this._search.text.trim())), null); this.close(); }
    }

    // ---------------- open/close with the Launcher3 interpolators ----------------
    _applyProgress(p, atomic) {
        p = Math.max(0, Math.min(1, p));
        this._progress = p;
        const H = this._travel();
        this.visible = p > 0;
        // The shell's single-finger overview SwipeTracker (vertical, on the stage) would otherwise take the
        // finger from the list: no scrolling, and a swipe down dropped the overview to the app layer.
        const ov = Main.overview._singleFingerOverviewGesture;
        if (ov) { const want = p <= 0.5 && !Main.wm.workspaceTracker?.zeroOpenWindows; if (ov.enabled !== want) ov.enabled = want; }
        this.translation_y = (1 - p) * H;
        // The icons ride on the sheet and fade in over the whole swipe, the home's fade-out mirrored (Launcher3 fades
        // them in over .4-.8, which left the lower half of a rising sheet empty until they appeared)
        const fade = p;
        this._content.opacity = Math.round(255 * fade);
        this.opacity = Math.round(255 * Math.max(0, Math.min(1, atomic ? (p - 0.264) / 0.57 : (p - 0.117) / 0.283)));
        // workspace + hotseat: no scaling, a fade that follows the sheet
        const ws = this.home._column; const step = atomic ? 0.333 : 0.4;
        ws.scale_x = ws.scale_y = 1;
        // faded over the whole swipe: gone exactly when the drawer is fully open, not halfway up
        ws.opacity = Math.round(255 * (1 - p));
    }
    /** Driven by an St.Adjustment eased on the frame clock (a GLib timer at 8 ms jittered against 120 Hz). */
    _animateTo(target, duration, mode = Clutter.AnimationMode.EASE_OUT_QUINT) {
        if (!this._progressAdj) {
            this._progressAdj = new St.Adjustment({actor: this, lower: 0, upper: 1, value: this._progress});   // actor: the frame clock that drives the transition (without it the ease never ticks)
            this._progressAdj.connect('notify::value', a => { if (this._animating) this._applyProgress(a.value, true); });
        }
        const adj = this._progressAdj;
        adj.remove_transition('value');
        adj.value = this._progress; this.visible = true; this._animating = true;
        adj.ease(target, {duration, mode, onComplete: () => {
            this._animating = false; this._applyProgress(target, true);
            if (target === 0) this.visible = false;
            else if (this._focusSearchOnOpen) { this._search.grab_key_focus(); this._focusSearchOnOpen = false; }
        }});
    }
    open({focusSearch = false} = {}) { this._focusSearchOnOpen = focusSearch; this._animateTo(1, D.openMs); }
    close() {
        this._search.text = ''; global.stage.set_key_focus(null); this._animateTo(0, D.closeMs);
        if (!this.settings.get_boolean('drawer-save-scroll-position')) { if (this._resetTimer) GLib.source_remove(this._resetTimer); this._resetTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, D.closeMs + 20, () => { this._resetTimer = 0; if (this._scroll.vadjustment) this._scroll.vadjustment.value = 0; if (this._pagedPages?.length) this._snapPaged(0); return GLib.SOURCE_REMOVE; }); }
    }
    get isOpen() { return this._progress > 0.5; }
    // AllAppsTransitionController: the sheet's top edge sits at the finger (not "the bottom edge plus the distance moved").
    beginDrag(y) { this._dragY0 = y; this.visible = true; this.updateDrag(y); }
    updateDrag(y) { this._applyProgress(1 - y / this._travel(), false); }
    endDrag(y, vel) { const p = this._progress; if (p > D.commit * 0.5 && (p > 1 - D.commit || -vel > 500)) this._animateTo(1, 300); else this._animateTo(0, 200); }
});
