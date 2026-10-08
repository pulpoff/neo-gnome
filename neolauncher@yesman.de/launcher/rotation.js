// Auto-rotation with a physical keyboard attached.
//
// Mutter only rotates the panel in touch mode: as soon as a keyboard (a Bluetooth one included)
// is connected, panel-orientation-managed goes false and the screen stays where it is, so a phone
// used in landscape with a keyboard snaps back or stops following the accelerometer. While mutter
// is not managing the orientation (and the user has not locked it), follow iio-sensor-proxy here
// and apply the transform through DisplayConfig as a temporary configuration. When the keyboard
// goes away mutter manages it again and this steps aside.
//
// Phones only: panel-orientation-managed is false on every desktop (no accelerometer, or a keyboard is
// always there), and a desktop or a phone on an external screen must never have its monitors
// reconfigured from here. So this runs on the mobile shell (layoutManager.is_phone) with exactly one
// logical monitor, and that monitor must be the built-in panel.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const here = import.meta.url.replace(/\/[^/]*$/, '');
const {displayState, builtinLogical, isPhone} = await import(`${here}/util.js?gen=${gen}`);

// iio-sensor-proxy orientation -> MetaMonitorTransform (mutter's own mapping)
const TRANSFORM = {'normal': 0, 'left-up': 1, 'bottom-up': 2, 'right-up': 3};

export class KeyboardRotation {
    constructor(log) {
        this.log = log;
        this._mm = global.backend.get_monitor_manager();
        this._touch = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.peripherals.touchscreen'});
        this._managedId = this._mm.connect('notify::panel-orientation-managed', () => this._update());
        this._lockId = this._touch.connect('changed::orientation-lock', () => this._update());
        // The shell binds its "Auto Rotate" quick toggle to panel-orientation-managed, so the toggle
        // vanished the moment a keyboard connected. Rotation goes on here (honouring that very lock), so
        // the toggle stays; the binding only runs mutter -> toggle, and is overridden after each change.
        this._toggle = Main.panel.statusArea.quickSettings?._autoRotate?.quickSettingsItems?.[0] ?? null;
        if (this._toggle) {
            this._toggleId = this._toggle.connect('notify::visible', () => { if (!this._toggle.visible && this._eligible()) this._toggle.visible = true; });
            if (this._eligible()) this._toggle.visible = true;
        }
        this._phoneId = Main.layoutManager.connect('notify::is-phone', () => this._update());
        this._monId = Main.layoutManager.connect('monitors-changed', () => this._update());
        this._update();
    }

    /** A phone on its own panel; a docked phone or a desktop is left to mutter. */
    _eligible() { return isPhone() && Main.layoutManager.monitors.length === 1; }

    destroy() {
        this._stop();
        if (this._managedId) { this._mm.disconnect(this._managedId); this._managedId = 0; }
        if (this._lockId) { this._touch.disconnect(this._lockId); this._lockId = 0; }
        if (this._phoneId) { Main.layoutManager.disconnect(this._phoneId); this._phoneId = 0; }
        if (this._monId) { Main.layoutManager.disconnect(this._monId); this._monId = 0; }
        if (this._toggleId) { this._toggle.disconnect(this._toggleId); this._toggleId = 0; this._toggle.visible = this._mm.panel_orientation_managed; }
    }

    _update() {
        const want = this._eligible() && !this._mm.panel_orientation_managed && !this._touch.get_boolean('orientation-lock');
        if (want && !this._sensor && !this._starting) this._start();
        else if (!want && (this._sensor || this._starting)) this._stop();
    }

    _start() {
        this._starting = true;
        this.log?.('rotation: mutter is not managing the panel orientation (keyboard attached), following the accelerometer');
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'net.hadess.SensorProxy', '/net/hadess/SensorProxy', 'net.hadess.SensorProxy', null, (_o, res) => {
                this._starting = false;
                let proxy;
                try { proxy = Gio.DBusProxy.new_for_bus_finish(res); } catch (e) { this.log?.(`rotation: no sensor proxy: ${e.message}`); return; }
                if (this._stopped) { this._stopped = false; return; }
                this._sensor = proxy;
                proxy.call('ClaimAccelerometer', null, Gio.DBusCallFlags.NONE, -1, null, (p, r) => {
                    try { p.call_finish(r); } catch (e) { this.log?.(`rotation: claim failed: ${e.message}`); }
                    this._apply();
                });
                this._propsId = proxy.connect('g-properties-changed', () => this._apply());
            });
    }

    _stop() {
        if (this._starting) { this._stopped = true; this._starting = false; }
        if (!this._sensor) return;
        if (this._propsId) { this._sensor.disconnect(this._propsId); this._propsId = 0; }
        this._sensor.call('ReleaseAccelerometer', null, Gio.DBusCallFlags.NONE, -1, null, null);
        this._sensor = null;
    }

    async _apply() {
        const o = this._sensor?.get_cached_property('AccelerometerOrientation')?.unpack();
        const transform = TRANSFORM[o];
        if (transform === undefined || !this._eligible()) return;
        let state;
        try { state = await displayState(); } catch (e) { this.log?.(`rotation: GetCurrentState: ${e.message}`); return; }
        if (!this._sensor || !this._eligible()) return;                // stopped meanwhile
        const panel = builtinLogical(state);
        if (state.logical.length !== 1 || !panel || panel[3] === transform) return;
        // Every logical monitor goes back as it is, only the built-in one turns: ApplyMonitorsConfig takes
        // the whole layout, and a monitor left out of it is switched off.
        const logical = [];
        for (const lm of state.logical) {
            const [x, y, scale, current, primary, specs] = lm;
            const monitors = [];
            for (const spec of specs) {
                const mon = state.monitors.find(m => m[0][0] === spec[0]);
                const mode = mon?.[1].find(md => md[6]?.['is-current']);
                if (!mode) return;                                      // a monitor without a current mode: leave it all alone
                monitors.push([spec[0], mode[0], {}]);
            }
            logical.push([x, y, scale, lm === panel ? transform : current, primary, monitors]);
        }
        const args = new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [state.serial, 1 /* temporary */, logical, {}]);
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'ApplyMonitorsConfig', args, null, Gio.DBusCallFlags.NONE, -1, null, (c, r) => {
                try { c.call_finish(r); this.log?.(`rotation: ${o} -> transform ${transform}`); } catch (e) { this.log?.(`rotation: apply: ${e.message}`); }
            });
    }
}

/**
 * Android-style rotation animation. Mutter applies a new orientation inside this process before an
 * extension hears about it, so the old screen cannot be captured; the new layout is animated into
 * place instead. On monitors-changed the panel transform (read from DisplayConfig) is compared with
 * the previous one; the UI is put in the starting pose at once (turned back, zoomed out) and the
 * easing only starts once the compositor has painted a frame after the modeset: started earlier,
 * the KMS reprogramming ate the whole timeline and one half-turned frame was all that showed.
 * No opacity change: fading uiGroup renders the whole UI offscreen on every frame.
 */
export class RotationAnimation {
    constructor(log) {
        this.log = log;
        this._transform = null;
        this._mon = this._monSize();
        this._readTransform(t => { this._transform = t; });
        this._monId = Main.layoutManager.connect('monitors-changed', () => this._onMonitorsChanged());
    }
    destroy() {
        this._destroyed = true;
        if (this._monId) { Main.layoutManager.disconnect(this._monId); this._monId = 0; }
        this._cancelPending();
        this._reset();
    }
    /** A rotation still waiting for its first frame (or mid-animation) must not ease uiGroup after a disable. */
    _cancelPending() {
        if (this._paintId) { global.stage.disconnect(this._paintId); this._paintId = 0; }
        if (this._idleId) { GLib.source_remove(this._idleId); this._idleId = 0; }
        if (this._framesId) { global.stage.disconnect(this._framesId); this._framesId = 0; }
    }
    _monSize() { const m = Main.layoutManager.primaryMonitor; return m ? {w: m.width, h: m.height} : null; }
    _readTransform(cb) {
        // the built-in panel's transform (the first logical monitor when nothing says built-in)
        displayState().then(st => cb((builtinLogical(st) ?? st.logical[0])?.[3] ?? null), () => cb(null));
    }
    _reset() {
        const ui = Main.layoutManager.uiGroup;
        ui.remove_all_transitions(); ui.rotation_angle_z = 0; ui.scale_x = 1; ui.scale_y = 1;
    }

    _onMonitorsChanged() {
        const before = this._mon; const after = this._monSize(); this._mon = after;
        this._readTransform(t => {
            const prev = this._transform; this._transform = t;
            if (this._destroyed || t === null || prev === null || t === prev || !before || !after) return;
            const steps = ((t - prev) % 4 + 4) % 4;
            // mutter's transforms turn counter-clockwise; the content starts where it was
            const angle = steps === 2 ? 180 : (steps === 1 ? 90 : -90);
            const fit = steps === 2 ? 1 : Math.min(before.h / after.w, before.w / after.h);
            const ui = Main.layoutManager.uiGroup;
            this._cancelPending();
            ui.remove_all_transitions();
            ui.set_pivot_point(0.5, 0.5);
            ui.rotation_angle_z = angle; ui.scale_x = fit * 0.85; ui.scale_y = fit * 0.85;
            const t0 = GLib.get_monotonic_time();
            // start once a frame of the new mode has been painted (the modeset is over)
            this._paintId = global.stage.connect('after-paint', () => {
                global.stage.disconnect(this._paintId); this._paintId = 0;
                this._idleId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    this._idleId = 0;
                    if (this._destroyed) return GLib.SOURCE_REMOVE;
                    this.log?.(`rotation anim: ${prev} -> ${t} (${angle} deg), first frame after ${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)} ms`);
                    let frames = 0; const ts = GLib.get_monotonic_time();
                    this._framesId = global.stage.connect('after-paint', () => { frames++; });
                    ui.ease({rotation_angle_z: 0, scale_x: 1, scale_y: 1, duration: 260,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onStopped: () => {
                            if (this._framesId) { global.stage.disconnect(this._framesId); this._framesId = 0; }
                            this.log?.(`rotation anim: ${frames} frames in ${((GLib.get_monotonic_time() - ts) / 1000).toFixed(0)} ms`);
                            if (!this._destroyed) this._reset();
                        }});
                    return GLib.SOURCE_REMOVE;
                });
            });
            global.stage.queue_redraw();
        });
    }
}
