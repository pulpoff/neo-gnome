// Windows wider than the phone are shown at exactly the screen's width.
//
// Desktop apps declare a minimum size, and mutter never makes a window smaller than that: Chromium's is about
// 500 px on a 360 px screen, so it hung off the right edge however it was maximized. Such a window is laid out
// at its minimum width, as tall as the work area divided by the same factor, and its actor is scaled down by
// width-of-the-work-area / width-of-the-window, so it fills the screen edge to edge, no less and no more. Mutter
// maps touches through the actor's transform, so input lands where it is drawn.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

export class WindowFitter {
    constructor(log) {
        this.log = log;
        this._windows = new Map();                  // window -> its handler ids
        this._createdId = global.display.connect('window-created', (d, w) => this._watch(w));
        this._waId = global.display.connect('workareas-changed', () => { for (const w of this._windows.keys()) this._queue(w); });
        for (const w of global.display.list_all_windows()) this._watch(w);
    }

    _watch(w) {
        if (this._windows.has(w) || w.get_window_type() !== Meta.WindowType.NORMAL) return;
        const ids = [
            w.connect('size-changed', () => this._queue(w)),
            w.connect('position-changed', () => this._queue(w)),
            w.connect('unmanaged', () => this._forget(w)),
        ];
        this._windows.set(w, ids);
        this._queue(w);
    }

    _forget(w) {
        const ids = this._windows.get(w); if (!ids) return;
        for (const id of ids) { try { w.disconnect(id); } catch (_) {} }
        if (w._neoFitIdle) { GLib.source_remove(w._neoFitIdle); w._neoFitIdle = 0; }
        this._windows.delete(w);
    }

    // after the client has answered: a fit inside a size-changed handler would race mutter's own constraints
    _queue(w) {
        if (w._neoFitIdle) return;
        w._neoFitIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { w._neoFitIdle = 0; this._fit(w); return GLib.SOURCE_REMOVE; });
    }

    _fit(w) {
        const actor = w.get_compositor_private();
        if (!actor || w.is_fullscreen() || w.minimized) return;
        const wa = w.get_work_area_current_monitor(), r = w.get_frame_rect();
        const unscaled = () => { if (actor.scale_x !== 1) { actor.set_scale(1, 1); this.log?.(`fit: ${w.get_wm_class()} back to 1:1`); } };
        // the client's own minimum is what it settles at: shrinking is mutter's job, scaling is ours
        const width = r.width;
        if (width <= wa.width) { w._neoFitScale = 0; w._neoFitAsked = 0; unscaled(); return; }
        // a window that is only wide right now (Angelfish opened at 996 px) fits once asked: ask first, and
        // scale only one that stays wider than the screen after that, i.e. its minimum is wider
        if (!w._neoFitScale && (w._neoFitAsked ?? 0) < 2) {
            w._neoFitAsked = (w._neoFitAsked ?? 0) + 1;
            if (w.get_maximized()) w.unmaximize(Meta.MaximizeFlags.BOTH);
            w.move_resize_frame(true, wa.x, wa.y, wa.width, wa.height);
            if (this._askId) GLib.source_remove(this._askId);
            this._askId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => { this._askId = 0; this._queue(w); return GLib.SOURCE_REMOVE; });
            return;
        }
        const s = wa.width / width, height = Math.round(wa.height / s);
        if (w.get_maximized()) w.unmaximize(Meta.MaximizeFlags.BOTH);
        if (r.x !== wa.x || r.y !== wa.y || r.height !== height) w.move_resize_frame(true, wa.x, wa.y, width, height);
        // the actor's origin is the buffer's, which sits the shadow's width outside the frame
        const b = w.get_buffer_rect();
        actor.set_pivot_point((r.x - b.x) / Math.max(1, b.width), (r.y - b.y) / Math.max(1, b.height));
        if (Math.abs(actor.scale_x - s) > 0.001) {
            actor.set_scale(s, s);
            this.log?.(`fit: ${w.get_wm_class()} ${width}px wide shown at ${wa.width}px (x${s.toFixed(3)})`);
        }
        w._neoFitScale = s;
    }

    destroy() {
        if (this._createdId) global.display.disconnect(this._createdId);
        if (this._waId) global.display.disconnect(this._waId);
        if (this._askId) GLib.source_remove(this._askId);
        this._createdId = this._waId = 0;
        for (const w of [...this._windows.keys()]) {
            this._forget(w);
            const a = w.get_compositor_private(); if (a) a.set_scale(1, 1);
            delete w._neoFitScale; delete w._neoFitAsked;
        }
    }
}
