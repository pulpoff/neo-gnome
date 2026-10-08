// The status bar stays unless a window really is fullscreen.
//
// The shell hides the top bar (and drops its strut) when mutter reports the monitor "in fullscreen", and
// mutter counts any window without server-side decorations that exactly covers the monitor as fullscreen.
// Every GTK4/libadwaita app is such a window once it is maximized to the whole screen, which happens after
// a rotation from landscape (where the work area is the full screen): the bar disappeared, the strut went
// with it, the window stayed monitor-sized, and the bar never came back. Here "in fullscreen" also needs a
// window on that monitor whose fullscreen flag is set, so only video players and the like hide the bar.
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class FullscreenGuard {
    constructor(log) {
        this.log = log;
        const mon = Main.layoutManager.monitors[0];
        this._proto = mon ? Object.getPrototypeOf(mon) : null;
        if (!this._proto) return;
        this._orig = Object.getOwnPropertyDescriptor(this._proto, 'inFullscreen');
        Object.defineProperty(this._proto, 'inFullscreen', {
            configurable: true,
            get() {
                if (!global.display.get_monitor_in_fullscreen(this.index)) return false;
                // the topmost window on this monitor decides, as mutter's own check does
                const ws = global.workspace_manager.get_active_workspace();
                const wins = global.display.sort_windows_by_stacking(global.display.list_all_windows()
                    .filter(w => w.get_monitor() === this.index && !w.minimized && w.located_on_workspace(ws) && w.get_window_type() === Meta.WindowType.NORMAL));
                return !!wins.at(-1)?.is_fullscreen();
            },
        });
        // mutter only signals its own idea of fullscreen; a window entering or leaving real fullscreen while
        // already monitor-sized changes ours without a signal
        this._windows = new Map();                  // window -> its two handler ids, both dropped when it goes
        const watch = w => {
            if (this._windows.has(w)) return;
            const ids = [w.connect('notify::fullscreen', () => this._update())];
            ids.push(w.connect('unmanaged', () => { for (const id of ids) w.disconnect(id); this._windows?.delete(w); }));
            this._windows.set(w, ids);
        };
        global.display.list_all_windows().forEach(watch);
        this._createdId = global.display.connect('window-created', (d, w) => watch(w));
        this._update();
    }

    _update() { Main.layoutManager._updateFullscreen?.(); }

    destroy() {
        if (this._createdId) { global.display.disconnect(this._createdId); this._createdId = 0; }
        for (const [w, ids] of this._windows ?? []) for (const id of ids) { try { w.disconnect(id); } catch (_) {} }
        this._windows?.clear();
        if (this._proto && this._orig) { Object.defineProperty(this._proto, 'inFullscreen', this._orig); this._update(); }
        this._proto = null;
    }
}
