// On-screen keyboard policy (Android's rule): the keyboard rises for a tap into a text field, not because an
// app focused one while opening. The mobile shell opens the panel on every text-input "enable" from a client
// (KeyboardController 'panel-state' → Keyboard._onKeyboardStateChanged → open). The keyboard registers that
// handler at construction as `this._onKeyboardStateChanged.bind(this)`, so overriding the prototype method
// changes nothing for a keyboard that already exists. The controller's own `emit` is wrapped instead (an
// InjectionManager override on that instance, restored exactly on destroy; no handler is disconnected or
// reconnected): a 'panel-state' ON is held back unless a touch or click on an app window happened in the
// last TAP_WINDOW_MS, everything else goes through untouched. A short tap on a window whose request was
// held back opens the keyboard (clients like VTE never re-request it on a click).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const TAP_WINDOW_MS = 1000;

export class OskPolicy {
    constructor(settings, log) {
        this._settings = settings; this._log = log;
        this._inj = new InjectionManager();
        this._lastPress = 0; this._pendingOn = false; this._press = null; this._hooked = null;
        this._pressId = global.stage.connect('captured-event', (s, ev) => {
            const t = ev.type();
            if (t === Clutter.EventType.TOUCH_BEGIN || t === Clutter.EventType.BUTTON_PRESS) {
                // Only a press on an app window counts: the tap that launches an app from the home must not
                // license the keyboard the app asks for while opening, nor must typing on the keyboard itself.
                const onKeyboard = Main.layoutManager.keyboardBox.contains(global.stage.get_event_actor(ev));
                if (Main.overview.visible || onKeyboard) { this._press = null; return Clutter.EVENT_PROPAGATE; }
                this._lastPress = GLib.get_monotonic_time(); this._press = ev.get_coords(); this._lastPressPos = this._press;
            } else if (t === Clutter.EventType.TOUCH_END || t === Clutter.EventType.BUTTON_RELEASE) {
                const [x, y] = ev.get_coords(); const p = this._press; this._press = null;
                const quick = (GLib.get_monotonic_time() - this._lastPress) / 1000 < 350;
                if (this._pendingOn && p && quick && Math.hypot(x - p[0], y - p[1]) < 10 && this._tapOnField(p) && !Main.overview.visible && !Main.layoutManager.keyboardBox.contains(global.stage.get_event_actor(ev))) {
                    this._pendingOn = false;
                    this._log?.('osk: opened for a tap on a window with text input enabled');
                    Main.keyboard.open(Main.layoutManager.primaryIndex);
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // the shell may recreate its Keyboard (touch mode, a11y setting): hook whatever instance exists after that
        const policy = this;
        this._inj.overrideMethod(Object.getPrototypeOf(Main.keyboard), '_syncEnabled', original => function (...args) {
            const r = original.call(this, ...args);
            policy._hook();
            return r;
        });
        this._hook();
    }

    /** Did the press land on the focused text field? The compositor only knows the field's caret rectangle
     *  (text-input set_cursor_rectangle), so "on the field" means the same line as the caret; a terminal
     *  (content purpose TERMINAL) is one big field and any tap counts. Settings keeps a hidden search entry
     *  focused and re-requests the panel on every tap: its caret sits off-window, so those taps never qualify. */
    _tapOnField(p) {
        if (!p) return false;
        const im = Main.inputMethod;
        if (im._purpose === Clutter.InputContentPurpose.TERMINAL) return true;
        const r = im._cursorRect; if (!r) return true;                 // nothing known: do not block
        if (r.width <= 0 && r.height <= 0) return false;               // an unmapped (hidden) field reports a 0×0 caret
        if (r.x < 0 || r.y < 0) return false;
        const lineH = Math.max(r.height, 24);
        const cy = r.y + lineH / 2;
        return Math.abs(p[1] - cy) <= lineH / 2 + 24;
    }

    /**
     * Landscape: keys across the whole width (Android's landscape keyboard). GNOME's AspectContainer keeps
     * the layout's width/height ratio, and with the keyboard a third of a landscape screen tall that left a
     * narrow block of keys centred in the middle. In landscape its ratio is made unlimited, so it never
     * restricts the width; portrait keeps the layout's own ratio. Re-applied when the screen rotates.
     */
    _wideKeys(kb) {
        const ac = kb?._aspectContainer;
        if (!ac || ac._neoWideKeys) return;
        const orig = ac.setRatio;
        ac._neoWideKeys = orig;
        ac.setRatio = function (w, h) {
            this._neoLast = [w, h];
            const m = Main.layoutManager.keyboardMonitor;
            if (m && m.width > m.height) { this._ratio = 1000; this.queue_relayout(); } else orig.call(this, w, h);
        };
        if (ac._ratio) ac._neoLast ??= [ac._ratio, 1];
        if (!this._kbMonId) this._kbMonId = Main.layoutManager.connect('monitors-changed', () => {
            const a = Main.keyboard._keyboard?._aspectContainer;
            if (a?._neoLast) a.setRatio(...a._neoLast);
        });
        if (ac._neoLast) ac.setRatio(...ac._neoLast);
    }

    _hook() {
        const kb = Main.keyboard._keyboard;
        if (kb) this._wideKeys(kb);
        const ctl = kb?._keyboardController;
        if (!ctl || ctl === this._hooked) return;
        this._unhook();
        const policy = this;
        this._ownEmit = Object.hasOwn(ctl, 'emit');
        this._inj.overrideMethod(ctl, 'emit', original => function (name, ...args) {
            if (name === 'panel-state' && !policy._allow(args[0])) return undefined;
            return original.call(this, name, ...args);
        });
        this._hooked = ctl;
        this._log?.('osk: policy attached to the keyboard');
    }

    /** Should this panel-state reach the keyboard? Only an ON without a recent tap on the field is held back. */
    _allow(state) {
        if (state === Clutter.InputPanelState.OFF) {
            this._pendingOn = false;
            if (this._caretWait) { GLib.source_remove(this._caretWait); this._caretWait = 0; }
        }
        if (state !== Clutter.InputPanelState.ON || !this._settings.get_boolean('keyboard-on-tap-only')) return true;
        const since = (GLib.get_monotonic_time() - this._lastPress) / 1000;
        // Qt asks for the panel before it reports where its caret is (a 0×0 rectangle for a moment): right
        // after a tap, wait for the real one before deciding, or every Qt field that takes focus on a tap (the
        // browser's address bar) was held back for good.
        const r = Main.inputMethod._cursorRect;
        if (since <= TAP_WINDOW_MS && r && r.width <= 0 && r.height <= 0) {
            this._pendingOn = true;
            if (!this._caretWait) this._caretWait = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._caretWait = 0;
                if (this._pendingOn && this._tapOnField(this._lastPressPos)) {
                    this._pendingOn = false;
                    this._log?.('osk: allowed once the caret was known');
                    Main.keyboard.open(Main.layoutManager.primaryIndex);
                } else this._log?.('osk: held back (the caret is not where the tap was)');
                return GLib.SOURCE_REMOVE;
            });
            return false;
        }
        const onField = this._tapOnField(this._lastPressPos);
        const app = global.display.focus_window?.get_wm_class?.() ?? '?';
        if (since > TAP_WINDOW_MS || !onField) { this._pendingOn = true; this._log?.(`osk: held back (${Math.round(since)} ms since the last tap, on the field: ${onField}) for ${app}`); return false; }
        this._pendingOn = false;
        this._log?.(`osk: allowed (${Math.round(since)} ms after a tap on the field) for ${app}`);
        return true;
    }

    _unhook() {
        const ctl = this._hooked; this._hooked = null;
        if (!ctl) return;
        this._inj?.restoreMethod(ctl, 'emit');
        if (!this._ownEmit) delete ctl.emit;        // restoreMethod leaves the inherited emit as an own copy
    }

    destroy() {
        if (this._pressId) { global.stage.disconnect(this._pressId); this._pressId = 0; }
        if (this._caretWait) { GLib.source_remove(this._caretWait); this._caretWait = 0; }
        this._unhook();
        this._inj?.clear(); this._inj = null;
        if (this._kbMonId) { Main.layoutManager.disconnect(this._kbMonId); this._kbMonId = 0; }
        // give the keyboard its own setRatio back (a reload installs a fresh wrapper)
        const ac = Main.keyboard._keyboard?._aspectContainer;
        if (ac?._neoWideKeys) { ac.setRatio = ac._neoWideKeys; delete ac._neoWideKeys; if (ac._neoLast) ac.setRatio(...ac._neoLast); }
    }
}
