// The mouse pointer shows only when a mouse (or touchpad) is actually being used.
//
// With a keyboard attached mutter leaves touch mode, and from then on it makes the pointer visible by
// itself: after a rotation (monitors changed) or when a Bluetooth keyboard brings a pointer interface of
// its own, an arrow sat on the screen of a phone driven by touch. Here the last real input decides: motion,
// a button or a scroll from a pointer device shows the cursor; a touch hides it, and any other attempt to
// show it while the last input was not a pointer is undone.
//
// Touch hardware only: on a machine without a touchscreen the pointer is the only way in, and hiding it at
// enable left a desktop with no cursor until the mouse moved. Disabled, the pointer is handed back as
// mutter itself would show it (visible unless the seat is in touch mode).
import Clutter from 'gi://Clutter';

const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const here = import.meta.url.replace(/\/[^/]*$/, '');
const {hasTouchscreen, touchMode} = await import(`${here}/util.js?gen=${gen}`);

const POINTER_EVENTS = new Set([Clutter.EventType.MOTION, Clutter.EventType.BUTTON_PRESS, Clutter.EventType.SCROLL]);
const POINTER_DEVICES = new Set([Clutter.InputDeviceType.POINTER_DEVICE, Clutter.InputDeviceType.TOUCHPAD_DEVICE]);

export class CursorGuard {
    constructor(log) {
        this.log = log;
        if (!hasTouchscreen()) { this.log?.('cursor guard: no touchscreen, pointer left alone'); return; }
        this._tracker = global.backend.get_cursor_tracker();
        this._pointerUsed = false;
        this._eventId = global.stage.connect('captured-event', (s, ev) => {
            const t = ev.type();
            if (t === Clutter.EventType.TOUCH_BEGIN) { this._pointerUsed = false; this._hide(); }
            else if (POINTER_EVENTS.has(t) && !(ev.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED) &&
                POINTER_DEVICES.has(ev.get_source_device()?.get_device_type())) {
                this._pointerUsed = true;
                if (!this._tracker.get_pointer_visible()) this._tracker.set_pointer_visible(true);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // Mutter shows the cursor whenever the last input device is not a touchscreen, and a keyboard that
        // also declares mouse axes (the BT5.2 one does) counts as a mouse: every key press showed it. It is
        // hidden again inside the same signal, before a frame is drawn (hiding it later made it blink), and
        // real pointer motion shows it from the event handler above.
        this._visId = this._tracker.connect('visibility-changed', () => {
            if (!this._pointerUsed && this._tracker.get_pointer_visible()) this._hide();
        });
        this._hide();
    }

    _hide() {
        if (this._tracker.get_pointer_visible()) this._tracker.set_pointer_visible(false);
    }

    destroy() {
        if (this._eventId) { global.stage.disconnect(this._eventId); this._eventId = 0; }
        if (this._visId) { this._tracker.disconnect(this._visId); this._visId = 0; }
        if (this._tracker) { this._tracker.set_pointer_visible(!touchMode()); this._tracker = null; }
    }
}
