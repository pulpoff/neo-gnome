// Android's gesture navigation "back": a drag in from the left or right screen edge. The arrow
// pill slides out while the drag is held (recognised) and the action fires on release.
//
// What "back" means here:
//   launcher showing   → close what is open on it (folder, drawer, search text), else nothing
//   an app is focused  → Alt+Left through a virtual keyboard: Adw.NavigationView, Gtk.Stack-based
//                        pages and Firefox all pop a page on it
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const {firstDelta} = await import(`${import.meta.url.replace(/\/[^/]*$/, '')}/gesture.js?gen=${(import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0'}`);

const PILL_MS = 220;

export class BackGesture {
    constructor(home) {
        this.home = home;
        this.settings = home.settings;
        this._gestures = [];
        // St.Bin centres its child; a plain St.Widget left the arrow at the pill's corner
        this._arrow = new St.Icon({icon_name: 'go-previous-symbolic', icon_size: 20, style_class: 'neo-back-arrow', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});   // St.Bin places the child by the child's own alignment
        this._pill = new St.Widget({style_class: 'neo-back-pill', visible: false, reactive: false, width: 44, height: 44, layout_manager: new Clutter.BinLayout()});
        this._pill.add_child(this._arrow);
        Main.layoutManager.uiGroup.add_child(this._pill);
        // One pan gesture on the stage (capture phase) that only recognises for a touch that began within EDGE px of
        // the left or right edge. Shell.EdgeDragGesture completes at recognition and hides the rest of the touch, so the
        // pan is what lets the pill ride with the finger and the action wait for the release (Android's rules).
        const EDGE = 24, ARM = 48;
        const g = new Clutter.PanGesture();
        let side = null, armed = false;
        const beginX = () => { try { return g.get_point_begin_coords_abs(0).x; } catch (_) { return g.get_begin_centroid_abs().x; } };
        g.connect('may-recognize', () => {
            if (!this.settings.get_boolean('gesture-back-edges')) return false;
            const x = beginX(), W = Main.layoutManager.primaryMonitor.width;
            side = x <= EDGE ? St.Side.LEFT : x >= W - EDGE ? St.Side.RIGHT : null;
            return side !== null;
        });
        g.connect('recognize', () => { armed = false; this._show(side, g); });
        g.connect('pan-update', () => {
            const [dx, dy] = firstDelta(g); let y = this._pill.y + 22; try { y = g.get_point_coords_abs(0).y; } catch (_) {}
            this._pill.y = Math.round(y - 22);
            const inward = side === St.Side.LEFT ? dx : -dx;
            const now = inward > ARM && Math.abs(dy) < 160;
            if (now !== armed) { armed = now; this._pill.ease({opacity: armed ? 255 : 110, duration: 100}); }
        });
        g.connect('end', () => { const go = armed; armed = false; this._hide(); if (go) this.back(); });
        g.connect('cancel', () => { armed = false; this._hide(); });
        global.stage.add_action_full('neo-back-edges', Clutter.EventPhase.CAPTURE, g);
        this._gestures.push(g);      // home.backGestures: app cells and pans let these win (home.guardBack, icons.js)
        this._keyboard = null;
    }
    get gestures() { return this._gestures; }

    destroy() {
        for (const g of this._gestures) global.stage.remove_action(g);
        this._gestures = [];
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = 0; }
        this._pill.destroy(); this._pill = null;
        this._keyboard = null;
    }

    _show(side, g) {
        const monitor = Main.layoutManager.primaryMonitor;
        let y = monitor.height / 2;
        try { y = g.get_point_coords_abs(0).y; } catch (_) { try { y = global.get_pointer()[1]; } catch (_2) {} }
        const p = this._pill;
        p.remove_all_transitions();
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = 0; }
        this._arrow.icon_name = side === St.Side.LEFT ? 'go-previous-symbolic' : 'go-next-symbolic';
        p.set_position(side === St.Side.LEFT ? 0 : monitor.width - 44, Math.round(y - 22));
        p.translation_x = side === St.Side.LEFT ? -44 : 44;
        p.opacity = 0; p.visible = true;
        p.ease({translation_x: 0, opacity: 255, duration: PILL_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        // never leave the pill behind if the gesture's end is lost
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => { this._hideTimer = 0; this._hide(); return GLib.SOURCE_REMOVE; });
    }

    _hide() {
        const p = this._pill; if (!p?.visible) return;
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = 0; }
        p.remove_all_transitions();
        const side = p.x > 0 ? 1 : -1;
        p.ease({opacity: 0, translation_x: side * 24, duration: PILL_MS, mode: Clutter.AnimationMode.EASE_IN_CUBIC, onComplete: () => { p.visible = false; }});
    }

    back() {
        const home = this.home;
        if (this.closePowerDialog?.()) return;           // the power menu, over whatever is showing
        if (Main.overview.visible) {
            if (home.dash?.isOpen) { home.dash.close(); return; }
            if (home.folderView?.isOpen) { home.folderView.close(); return; }
            if (home.drawer?.isOpen) {
                if (home.drawer._search?.text) { home.drawer._search.text = ''; return; }
                home.drawer.close(); return;
            }
            if (home.recents?.active) { home.recents.goHome?.(); return; }
            return;
        }
        this._sendAltLeft();
    }

    _sendAltLeft() {
        if (!this._keyboard) this._keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const kb = this._keyboard, t = () => GLib.get_monotonic_time();
        kb.notify_keyval(t(), Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        kb.notify_keyval(t(), Clutter.KEY_Left, Clutter.KeyState.PRESSED);
        kb.notify_keyval(t(), Clutter.KEY_Left, Clutter.KeyState.RELEASED);
        kb.notify_keyval(t(), Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
    }
}
