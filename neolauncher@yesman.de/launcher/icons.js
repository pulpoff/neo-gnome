// Icons and labels the way BubbleTextView draws them: 56 dp icon, 14.4 sp label,
// press feedback 1.0→1.1 over 200 ms (FastBitmapDrawable), optional shaped
// background for non-adaptive icons ("legacy treatment").
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const {iconActor, iconPacks} = await import(`${import.meta.url.replace(/\/[^/]*$/, '')}/iconpack.js?gen=${gen}`);

export const ICON_SIZE = 56;           // iconImageSize (dp)
export const LABEL_SIZE = 14.4;        // iconTextSize (sp)
export const PRESS_SCALE = 1.1;        // FastBitmapDrawable.PRESSED_SCALE
export const CLICK_FEEDBACK_MS = 200;

export const AppCell = GObject.registerClass({
    GTypeName: `NeoAppCell_${gen}`,
    Signals: {'launched': {}, 'released': {}, 'long-press': {'param_types': [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]}, 'drag-start': {'param_types': [GObject.TYPE_OBJECT]}},
}, class AppCell extends St.Button {
    /** `item` = layout item {type:'app'|'folder', ...}; `opts` {showLabel, iconScale, labelScale, multiline, model, home} */
    _init(item, opts = {}) {
        super._init({style_class: 'neo-cell', reactive: true, can_focus: true, track_hover: true, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.item = item; this.opts = opts;
        const size = Math.round(ICON_SIZE * (opts.iconScale ?? 1));
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
        this._iconBin = new St.Bin({style_class: 'neo-icon', width: size, height: size, x_align: Clutter.ActorAlign.CENTER});
        this._iconBin.set_pivot_point(0.5, 0.5);
        // icon + notification dot stacked (an St.Bin holds one child only)
        this._iconStack = new St.Widget({layout_manager: new Clutter.FixedLayout(), width: size, height: size, x_align: Clutter.ActorAlign.CENTER});
        this._iconStack.add_child(this._iconBin);
        this._badge = new St.Label({style_class: 'neo-badge', visible: false, text: ''});
        this._iconStack.add_child(this._badge);
        box.add_child(this._iconStack);
        this._label = new St.Label({style_class: 'neo-label', x_align: Clutter.ActorAlign.CENTER, visible: opts.showLabel !== false});
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._label.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        // A fixed label height (two lines when multiline is on, else one) keeps every icon at the same spot in
        // the grid: the cell centres icon + label as one block, so a label that grew a second line pushed its
        // icon up out of the row. Pango crops a longer name at that height with an ellipsis.
        this._styleLabel(opts);
        box.add_child(this._label);
        this.set_child(box);
        this._size = size;
        this.refresh();
        // press feedback: scale the icon 1.0 → 1.1 (ACCEL on press, DEACCEL on release)
        this.connect('notify::pressed', () => this._iconBin.ease({scale_x: this.pressed ? PRESS_SCALE : 1, scale_y: this.pressed ? PRESS_SCALE : 1,
            duration: CLICK_FEEDBACK_MS, mode: this.pressed ? Clutter.AnimationMode.EASE_IN_QUAD : Clutter.AnimationMode.EASE_OUT_QUAD}));
        this.connect('clicked', () => this.activate());
        this.connect('notify::pressed', () => { if (!this.pressed) this.emit('released'); });
        const lp = new Clutter.LongPressGesture({long_press_duration_ms: 300});   // 0.75 × 400 ms
        lp.connect('recognize', g => { const c = g.get_point_coords_abs(0); this.emit('long-press', c.x, c.y); });
        this.add_action(lp);
        // the shell's own drag-start gesture (touch: hold, then move) — the popup from the long
        // press stays until this recognizes, exactly Launcher3's pre-drag
        const dnd = new Shell.DndStartGesture({timeout_threshold: 300});
        dnd.connect('recognize', g => this.emit('drag-start', g));
        lp.can_not_cancel(dnd); dnd.can_not_cancel(lp);
        for (const g of opts.home?.backGestures ?? []) { lp.can_not_cancel(g); dnd.can_not_cancel(g); }   // an edge drag over an icon must survive the icon's own gestures
        this.add_action(dnd);
        this.dndGesture = dnd;
    }

    _styleLabel(opts) {
        this._label.clutter_text.set_line_wrap(!!opts.multiline);
        const fontPx = LABEL_SIZE * (opts.labelScale || 1);
        const lines = opts.multiline ? 2 : 1;
        this._label.style = `font-size: ${fontPx.toFixed(1)}px; height: ${Math.ceil(fontPx * 1.32) * lines}px;`;
    }

    /** Take another layout item for the same app (the other orientation's copy) without rebuilding the cell.
     *  False when the icon or label size differs: the caller builds a new cell then. */
    reuse(item, opts) {
        const o = this.opts;
        if (item.type !== 'app' || item.id !== this.item?.id || o.iconScale !== opts.iconScale || o.labelScale !== opts.labelScale || o.showLabel !== opts.showLabel) return false;
        this.item = item; this.opts = opts;
        this._label.text = item.label ?? this.app?.get_name() ?? item.id;
        if (!!o.multiline !== !!opts.multiline) this._styleLabel(opts);
        this._iconBin.set_scale(1, 1); this.opacity = 255; this.translation_x = 0; this.translation_y = 0;
        return true;
    }

    setBadge(count, showCount) {
        const on = count > 0;
        this._badge.visible = on; if (!on) return;
        this._badge.text = showCount ? String(Math.min(99, count)) : '';
        if (showCount) this._badge.add_style_class_name('count'); else this._badge.remove_style_class_name('count');
        const [, w] = this._badge.get_preferred_width(-1), [, h] = this._badge.get_preferred_height(-1);
        this._badge.set_position(Math.round(this._size - w * 0.7), Math.round(-h * 0.3));
    }
    _markDestroy() { if (!this._destroyHooked) { this._destroyHooked = true; this.connect('destroy', () => { this._destroyed = true; }); } }
    get app() { return this.item.type === 'app' ? (this.opts.model?.app(this.item.id) ?? Shell.AppSystem.get_default().lookup_app(this.item.id)) : null; }

    refresh() {
        const old = this._iconBin.get_child(); if (old) old.destroy();
        if (this.item.type === 'app') {
            const app = this.app;
            this._label.text = this.item.label ?? app?.get_name() ?? this.item.id;
            const icon = iconActor(app, this._size);
            this._iconBin.set_child(icon);
        } else if (this.item.type === 'folder') {
            this._label.text = this.item.name || 'Unnamed Folder';
            this._iconBin.set_child(folderPreview(this.item, this._size, this.opts.model));
            this._iconBin.add_style_class_name('neo-folder-preview');
        }
    }

    /** Icon pack / shape changed: keep the cell and its current icon, swap in the new render when the worker
     *  delivers it (no actor is rebuilt, so the change costs the shell almost nothing). */
    swapIcon() {
        this._markDestroy();
        if (this.item.type === 'folder') { this.refresh(); return; }
        const app = this.app; if (!app) return;
        const packs = iconPacks();
        const set = gicon => {
            if (this._destroyed) return;
            const cur = this._iconBin.get_child();
            if (gicon && cur?.set_gicon && !(cur instanceof St.Widget && !(cur instanceof St.Icon))) { cur.set_gicon(gicon); return; }
            const icon = gicon ? new St.Icon({gicon, icon_size: this._size}) : app.create_icon_texture(this._size);
            cur?.destroy(); this._iconBin.set_child(icon);
        };
        const cached = packs?.giconIfCached(app, this._size);
        if (cached !== undefined || !packs) { set(cached ?? null); return; }    // no packs yet: the stock icon
        packs.renderLater(app, this._size, set);
    }

    /** AppIcon.activate(): create the workspace for the window the mobile shell expects, then launch. */
    activate() {
        if (this.item.type !== 'app') { this.emit('launched'); return; }
        const app = this.app; if (!app) return;
        const time = global.get_current_time();
        try { Main.wm.workspaceTracker?.maybeCreateWorkspaceForWindow?.(time, app, this); } catch (_) {}
        const ws = global.workspace_manager.get_active_workspace_index();
        if (app.state === Shell.AppState.RUNNING) app.activate(); else app.activate_full(ws, time);
        this.opts.model?.recordLaunch(this.item.id);
        this.emit('launched');
        Main.overview.hide();
    }
});

/** ClippedFolderIconLayoutRule: up to 4 previews (2×2) at 0.44–0.51 scale on a round/shaped background. */
export function folderPreview(item, size, model) {
    const bg = new St.Widget({style_class: 'neo-folder-bg', width: size, height: size, layout_manager: new Clutter.FixedLayout()});
    const ids = (item.items ?? []).slice(0, 4);
    const n = ids.length, scale = n <= 1 ? 0.51 : 0.44, s = Math.round(size * scale);
    const positions = n <= 1 ? [[0.5, 0.5]] : n === 2 ? [[0.3, 0.5], [0.7, 0.5]] : n === 3 ? [[0.3, 0.32], [0.7, 0.32], [0.5, 0.7]] : [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]];
    ids.forEach((id, i) => {
        const app = model?.app(id) ?? Shell.AppSystem.get_default().lookup_app(id);
        const icon = iconActor(app, s);
        const [fx, fy] = positions[i];
        icon.set_position(Math.round(fx * size - s / 2), Math.round(fy * size - s / 2));
        bg.add_child(icon);
    });
    return bg;
}
