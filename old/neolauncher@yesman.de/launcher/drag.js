// Drag & drop the way Launcher3's DragController / Workspace / Hotseat / Folder do it
// (NEO-SPEC §3.4, §5.1): long-press lifts the icon and opens the popup; moving 16 dp
// while still holding closes the popup and starts the drag. The workspace goes
// spring-loaded (0.86, page outlines), a "Remove" drop target slides in at the top,
// hovering an icon's centre shows the folder-accept ring, hovering its edge reorders,
// holding at a screen edge turns the page (a new page at the end), the hotseat accepts
// drops, the drag view settles into its cell on release.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const {ICON_SIZE} = await import(`${import.meta.url.replace(/\/[^/]*$/, '')}/icons.js?gen=${gen}`);
const {iconActor} = await import(`${import.meta.url.replace(/\/[^/]*$/, '')}/iconpack.js?gen=${gen}`);

const G = {
    startThreshold: 16,     // deep_shortcuts_start_drag_threshold
    dragScale: 1.1,
    edgeZone: 24, edgeHoldMs: 500,   // page turn while held at the edge
    reorderMs: 650, folderMs: 100,
    dropMinMs: 100, dropMaxMs: 500, dropMaxDist: 800,
    springExitMs: 500,
    folderCentre: 0.6,      // inner fraction of the cell that means "make a folder"
};

/** feedbackd's event (fbcli -E) for a touch that did something; a no-op without fbcli. Also used by home and the Dash. */
export const haptic = (() => {
    const fbcli = GLib.find_program_in_path('fbcli');
    return event => { if (fbcli) try { Gio.Subprocess.new([fbcli, '-E', event], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE); } catch (_) {} };
})();

const M_DOCK_CELL = 63;     // hotseat icon cell (home.js M.hotseatIconCell)

export class DragController {
    constructor(home) {
        this.home = home; this.model = home.model; this.log = home.log;
        this.active = false;
    }

    /** Long-press on a cell: lift the icon a little and keep the popup; the drag may follow. */
    arm(cell, source, popup, extra = {}) {
        if (this.active) return;
        if (source !== 'drawer' && this.home.settings.get_boolean('desktop-lock')) { popup?.close(); return; }
        haptic('button-pressed');
        this.armed = {cell, source, popup, extra};
        cell._iconBin.ease({scale_x: 1.08, scale_y: 1.08, duration: 150});
    }

    /** Shell.DndStartGesture recognized on a cell (held, then moved): the drag proper. */
    begin(cell, source, gesture, extra = {}) {
        if (this.active) return;
        if (source !== 'drawer' && this.home.settings.get_boolean('desktop-lock')) return;
        const armed = this.armed; this.armed = null;
        const popup = armed?.cell === cell ? armed.popup : null;
        this.active = true; this.cell = cell; this.source = source; this.extra = extra; this.item = cell.item; this.dragging = false;
        const beginEv = gesture.get_point_begin_event(), trig = gesture.get_drag_triggering_event();
        [this.startX, this.startY] = beginEv.get_coords();
        [this.lastX, this.lastY] = trig.get_coords();
        this.device = trig.get_device(); this.seq = trig.get_event_sequence();
        this.layer = new St.Widget({name: 'neoDragLayer', reactive: true});
        this.layer.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));
        Main.layoutManager.addTopChrome(this.layer);
        this.grab = Main.pushModal(this.layer);
        if ((this.grab.get_seat_state() & Clutter.GrabState.POINTER) === 0) { Main.popModal(this.grab); this.grab = null; this.layer.destroy(); this.layer = null; this.active = false; this.log('drag: no pointer grab'); return; }
        this._evId = this.layer.connect('event', (a, ev) => this._onEvent(ev));
        this.log(`drag begin ${cell.item.id} from ${source} at ${Math.round(this.lastX)},${Math.round(this.lastY)}`);
        popup?.close();
        this._startDrag();
    }

    _onEvent(ev) {
        const t = ev.type();
        if (t === Clutter.EventType.KEY_PRESS) { if (ev.get_key_symbol() === Clutter.KEY_Escape) this._cancel(); return Clutter.EVENT_STOP; }
        if (ev.get_device() !== this.device) return Clutter.EVENT_PROPAGATE;
        const seq = ev.get_event_sequence();
        if (this.seq && seq?.get_slot() !== this.seq.get_slot()) return Clutter.EVENT_PROPAGATE;
        if (t === Clutter.EventType.TOUCH_UPDATE || t === Clutter.EventType.MOTION) {
            const [x, y] = ev.get_coords(); this.lastX = x; this.lastY = y;
            if (this.dragging) this._moveTo(x, y);
            return Clutter.EVENT_STOP;
        }
        if (t === Clutter.EventType.TOUCH_END || t === Clutter.EventType.BUTTON_RELEASE) { if (this.dragging) this._drop(); return Clutter.EVENT_STOP; }
        if (t === Clutter.EventType.TOUCH_CANCEL) { this._cancel(); return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    }

    /** The launcher goes away: drop any drag in progress (modal grab, layer, drag view) and every timer, without
     *  touching the layout or rebuilding the home that is being destroyed. */
    destroy() {
        this._destroyed = true;
        this.armed = null;
        this._teardownLayer();      // also destroys the drag view, a child of the layer
        this.view = null; this.active = false; this.dragging = false; this._target = null; this.seq = null;
    }

    /** The long press ended without a drag (the cell tells us on release). */
    disarm(cell) { if (this.armed?.cell === cell) { cell._iconBin.ease({scale_x: 1, scale_y: 1, duration: 150}); this.armed = null; } }

    _teardownLayer() {
        if (this._evId && this.layer) { this.layer.disconnect(this._evId); this._evId = 0; }
        if (this.grab) { Main.popModal(this.grab); this.grab = null; }
        this.layer?.destroy(); this.layer = null;
        if (this._edgeTimer) { GLib.source_remove(this._edgeTimer); this._edgeTimer = 0; }
        if (this._hoverTimer) { GLib.source_remove(this._hoverTimer); this._hoverTimer = 0; }
        if (this._springTimer) { GLib.source_remove(this._springTimer); this._springTimer = 0; }
    }

    // ---------------- drag ----------------
    _startDrag() {
        this.dragging = true;
        haptic('button-pressed');
        const home = this.home, cell = this.cell;
        // drag view: a copy of the icon, scaled, with a shadow, parented to the drag layer
        const bin = cell._iconBin; const [bx, by] = bin.get_transformed_position();
        const size = bin.width;
        this.view = new St.Bin({style_class: 'neo-drag-view', width: size, height: size});
        const app = cell.app;
        this.view.set_child(cell.item.type === 'app' ? iconActor(app, size) : new Clutter.Clone({source: bin.get_child()}));
        this.view.set_pivot_point(0.5, 0.5);
        this.layer.add_child(this.view);
        this.offX = Math.max(0, Math.min(size, this.startX - bx)); this.offY = Math.max(0, Math.min(size, this.startY - by));
        this.view.set_position(Math.round(this.lastX - this.offX), Math.round(this.lastY - this.offY));
        this.view.ease({scale_x: G.dragScale, scale_y: G.dragScale, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        // the source cell goes invisible (Launcher3 hides the dragged view); the drawer/folder closes
        cell.opacity = 0; cell._iconBin.set_scale(1, 1);
        if (this.source === 'drawer') home.drawer.close();
        if (this.source === 'folder') { this.extra.folderView?.close(); }
        home.setSpringLoaded(true);
        home.showDropTargetBar(true);
        this._moveTo(this.lastX, this.lastY);
    }

    _moveTo(x, y) {
        this.view.set_position(Math.round(x - this.offX), Math.round(y - this.offY));
        const home = this.home, mon = Main.layoutManager.primaryMonitor;
        // Launcher3 targets by the dragged icon's centre, not the finger
        const half = this.view.width * G.dragScale / 2;
        const tx = this.view.x + this.view.width / 2, ty = this.view.y + this.view.height / 2;
        // targets, in priority: remove bar, hotseat, edge page turn, workspace cell
        const target = this._hitTest(tx, ty);
        const key = t => `${t.kind}:${t.page}:${t.col}:${t.row}:${t.index}:${t.folder ? 'f' : ''}:${t.occupant?.id ?? ''}`;
        if (key(target) !== key(this._target ?? {})) {
            this._target = target; this._targetSince = GLib.get_monotonic_time();
            home.showDropHighlight(target);
            if (this._hoverTimer) { GLib.source_remove(this._hoverTimer); this._hoverTimer = 0; }
            if (target.kind === 'cell' && target.occupant) {
                this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, target.folder ? G.folderMs : G.reorderMs, () => { this._hoverTimer = 0; home.showDropHighlight(target, true); return GLib.SOURCE_REMOVE; });
            }
        }
        // edge hold → page turn
        const atEdge = x < mon.x + G.edgeZone ? -1 : x > mon.x + mon.width - G.edgeZone ? 1 : 0;
        if (atEdge !== this._edgeDir) {
            this._edgeDir = atEdge;
            if (this._edgeTimer) { GLib.source_remove(this._edgeTimer); this._edgeTimer = 0; }
            if (atEdge) this._edgeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, G.edgeHoldMs, () => { this._edgeTimer = 0; home.turnPageForDrag(atEdge); this._edgeDir = 0; return GLib.SOURCE_REMOVE; });
        }
    }

    _hitTest(x, y) {
        const home = this.home;
        const bar = home._dropBar; const [bx, by] = bar.get_transformed_position();
        if (bar.visible && x >= bx - 24 && x <= bx + bar.width + 24 && y <= by + bar.height + 8) return {kind: 'remove'};
        const [hx, hy] = home._hotseat.get_transformed_position();
        const dockN = () => Math.max(1, Math.min(home.model.dockSize, home.model.layout.dock.length + (this.source === 'dock' ? 0 : 1)));
        if (home._sideDock && home._hotseatRow && x >= hx) {
            // phone landscape: the dock is a column at the right edge; the slot comes from y
            const n = dockN(), kids = home._hotseatRow.get_children();
            const [, ry] = (kids[0] ?? home._hotseatRow).get_transformed_position();
            const cellH = kids[0]?.height || M_DOCK_CELL;
            let index = Math.floor((y - ry) / cellH); index = Math.max(0, Math.min(n - 1, index));
            return {kind: 'dock', index};
        }
        if (!home._sideDock && y >= hy) {
            const n = dockN();
            const [rx] = home._hotseatRow.get_transformed_position(); const rw = home._hotseatRow.width * (home._hotseat.scale_x || 1);
            const cellW = rw / n; let index = Math.floor((x - rx) / cellW); index = Math.max(0, Math.min(n - 1, index));
            return {kind: 'dock', index};
        }
        const g = home.cellGeometry(); const [wx, wy] = home._workspace.get_transformed_position();
        const sc = home._column.scale_x || 1; const cx = (x - wx) / sc, cy = (y - wy) / sc;
        if (cx < 0 || cy < 0 || cx > g.W || cy > g.H) return {kind: 'none'};
        let col = Math.floor((cx - g.padX) / g.cellW), row = Math.floor((cy - g.padTop) / g.cellH);
        col = Math.max(0, Math.min(home.cols - 1, col)); row = Math.max(0, Math.min(home.rows - 1, row));
        const page = home.currentPage;
        const occupant = (home.model.layout.pages[page] ?? []).find(it => it.col === col && it.row === row && it !== this.item);
        let folder = false;
        if (occupant) {
            const fx = (cx - g.padX - col * g.cellW) / g.cellW, fy = (cy - g.padTop - row * g.cellH) / g.cellH;
            const m = (1 - G.folderCentre) / 2; folder = fx > m && fx < 1 - m && fy > m && fy < 1 - m;
        }
        return {kind: 'cell', page, col, row, occupant, folder};
    }

    _drop() {
        const home = this.home, model = home.model, t = this._target ?? {kind: 'none'}, item = this.item;
        this.log(`drag drop ${JSON.stringify({kind: t.kind, page: t.page, col: t.col, row: t.row, index: t.index, occupant: t.occupant?.id, folder: t.folder})}`);
        let dest = null;         // stage rect the drag view settles into
        const g = home.cellGeometry(); const [wx, wy] = home._workspace.get_transformed_position(); const sc = home._column.scale_x || 1;
        const cellRect = (col, row) => ({x: wx + (g.padX + col * g.cellW + (g.cellW - ICON_SIZE) / 2) * sc, y: wy + (g.padTop + row * g.cellH + 10) * sc});
        const detach = () => {
            if (this.source === 'home') model.detachItem(this.cell.pageIndex, item);
            else if (this.source === 'dock') model.removeFromDock(item, false);
            else if (this.source === 'folder') model.removeFromFolder(this.extra.folder, item.id, false);
        };
        const dragged = this.source === 'drawer' ? {type: 'app', id: item.id} : (this.source === 'folder' ? {type: 'app', id: item.id} : item);
        if (t.kind === 'remove') {
            detach(); model.save(); haptic('button-released');
            this.view.ease({opacity: 0, scale_x: 0.2, scale_y: 0.2, duration: 150, onComplete: () => this._finish()});
            return;
        }
        if (t.kind === 'dock') {
            detach();
            if (!model.addToDock(dragged, t.index)) {
                const victim = model.layout.dock[Math.min(t.index, model.layout.dock.length - 1)];
                if (victim && this.source === 'home') {           // full hotseat: swap with the icon under the drop
                    model.removeFromDock(victim, false); model.addToDock(dragged, t.index);
                    model.placeItem(this.cell.pageIndex, victim, item.col ?? 0, item.row ?? 0);
                } else model.restore(this.source, this.cell.pageIndex, dragged, this.extra);
            }
            model.save(); dest = null;
        } else if (t.kind === 'cell') {
            const page = t.page;
            if (t.occupant && t.folder) {
                detach();
                if (t.occupant.type === 'folder') model.addToFolder(t.occupant, dragged);
                else model.makeFolder(page, t.occupant, dragged);
                model.save(); dest = cellRect(t.col, t.row);
            } else {
                detach();
                if (t.occupant) {           // reorder: the occupant takes the dragged item's old cell, or the first free one
                    const old = this.source === 'home' ? {page: this.cell.pageIndex, col: item.col, row: item.row} : null;
                    const free = old && old.page === page ? {col: old.col, row: old.row} : model.freeCell(page);
                    if (free) { t.occupant.col = free.col; t.occupant.row = free.row; }
                    else { model.addToFirstFreeCell({...t.occupant}); model.detachItem(page, t.occupant); }
                }
                model.placeItem(page, dragged, t.col, t.row); model.save(); dest = cellRect(t.col, t.row);
            }
        } else {
            // nowhere: snap back to where it came from
            if (this.source === 'home') dest = cellRect(item.col, item.row);
            model.save();
        }
        haptic('button-released');
        const vx = this.view.x, vy = this.view.y;
        const dist = dest ? Math.hypot(dest.x - vx, dest.y - vy) : 0;
        const dur = Math.round(G.dropMinMs + (G.dropMaxMs - G.dropMinMs) * Math.min(1, dist / G.dropMaxDist));
        if (dest) this.view.ease({x: Math.round(dest.x), y: Math.round(dest.y), scale_x: 1, scale_y: 1, duration: dur, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: () => this._finish()});
        else this.view.ease({opacity: 0, duration: 120, onComplete: () => this._finish()});
    }

    _finish() {
        if (this._destroyed) return;
        const home = this.home;
        this._teardownLayer();
        home.showDropHighlight({kind: 'none'});
        home.showDropTargetBar(false);
        home.rebuild();
        if (this._springTimer) GLib.source_remove(this._springTimer);
        this._springTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, G.springExitMs, () => { this._springTimer = 0; if (!this.active) home.setSpringLoaded(false); return GLib.SOURCE_REMOVE; });
        this.active = false; this.dragging = false; this._target = null; this.seq = null;
    }

    _cancel() {
        if (this.dragging) { this.cell.opacity = 255; this._finish(); }
        else { this._teardownLayer(); this.active = false; }
    }
}
