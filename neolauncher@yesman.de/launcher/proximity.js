// Screen off at the ear during a call (Android/iOS behaviour). The Yesman app switches this on for
// an earpiece call and off again when the loudspeaker is chosen or the call ends. While the
// proximity sensor reports "near" the panel is powered down and a modal layer swallows every
// touch, so a cheek cannot open the notification shade or hang up.
//
// A full-screen modal any session-bus client could raise is a lock-out, so the switch is bounded:
// it belongs to the D-Bus name that turned it on and goes off when that name leaves the bus (the
// app crashed or quit mid-call), it goes off by itself after MAX_CALL_S, the modal's action mode is
// LOCK_SCREEN (the power key, bound with ActionMode.ALL, still works), and waking the panel with
// the power key while "near" drops the layer until the sensor reports "near" again.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MAX_CALL_S = 4 * 3600;          // no earpiece call runs this long; a stuck "on" ends here

export class CallProximity {
    constructor(log) {
        this._log = log; this._proxy = null; this._active = false; this._near = false; this._grab = null; this._sig = 0;
        this._token = 0; this._watchId = 0; this._capId = 0; this._psId = 0;
    }

    /** On while a call holds the switch (launcher/lockscreen.js stays down then). */
    get active() { return this._active; }

    /** `owner`: the D-Bus caller ({connection, sender}); the switch lives as long as that name is on the bus. */
    set(on, owner = null) {
        this._disown();
        if (on) this._own(owner);
        if (on === this._active) return;
        this._active = on;
        if (on) this._claim(); else this._release();
    }

    _own(owner) {
        if (owner?.connection && owner.sender) {
            this._watchId = Gio.bus_watch_name_on_connection(owner.connection, owner.sender, Gio.BusNameWatcherFlags.NONE, null, () => {
                this._log?.(`proximity: ${owner.sender} left the bus, released`);
                this.set(false);
            });
        }
        this._capId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MAX_CALL_S, () => {
            this._capId = 0;
            this._log?.('proximity: on for too long, released');
            this.set(false);
            return GLib.SOURCE_REMOVE;
        });
    }
    _disown() {
        if (this._watchId) { Gio.bus_unwatch_name(this._watchId); this._watchId = 0; }
        if (this._capId) { GLib.source_remove(this._capId); this._capId = 0; }
    }

    _claim() {
        const token = ++this._token;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'net.hadess.SensorProxy', '/net/hadess/SensorProxy', 'net.hadess.SensorProxy', null, (_o, res) => {
                let proxy;
                try { proxy = Gio.DBusProxy.new_for_bus_finish(res); } catch (e) { this._log?.(`proximity: ${e.message}`); return; }
                if (token !== this._token) return;                          // released before the proxy came
                if (!proxy.get_cached_property('HasProximity')?.unpack()) { this._log?.('proximity: no sensor'); return; }
                this._proxy = proxy;
                this._sig = proxy.connect('g-properties-changed', () => this._update());
                proxy.call('ClaimProximity', null, Gio.DBusCallFlags.NONE, -1, null, (p, r) => {
                    try { p.call_finish(r); } catch (e) { this._log?.(`proximity: claim ${e.message}`); }
                    if (token === this._token) this._update();
                });
                this._log?.('proximity: watching');
            });
    }
    _release() {
        this._token++;
        if (this._proxy) {
            if (this._sig) { this._proxy.disconnect(this._sig); this._sig = 0; }
            this._proxy.call('ReleaseProximity', null, Gio.DBusCallFlags.NONE, -1, null, null);
            this._proxy = null;
        }
        this._setNear(false);
    }
    _update() {
        const near = !!this._proxy?.get_cached_property('ProximityNear')?.unpack();
        this._setNear(near);
    }
    _setNear(near) {
        if (near === this._near) return;
        this._near = near;
        const pm = Main.powerManager;
        if (near) {
            // a full-stage black layer with a modal grab: the panel goes dark and nothing underneath gets the touch
            this._layer = new St.Widget({style: 'background-color: black;', reactive: true, x: 0, y: 0, width: global.stage.width, height: global.stage.height});
            this._layer.connect('event', () => Clutter.EVENT_STOP);
            Main.layoutManager.addTopChrome(this._layer);
            this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.LOCK_SCREEN});
            // The panel coming back on while the layer is up was not us (we turn it on only after dropping the
            // layer): the power key. The user wants the screen, so the layer goes until the next "near".
            const mm = global.backend.get_monitor_manager();
            let wentOff = false;
            this._psId = mm.connect('power-save-mode-changed', () => {
                if (mm.power_save_mode !== 0) { wentOff = true; return; }
                if (!wentOff) return;
                this._log?.('proximity: woken by the power key, layer down');
                this._dropLayer();
            });
            try { pm?._turnOffScreen?.(); } catch (e) { this._log?.(`proximity: screen off ${e.message}`); }
            this._log?.('proximity: near, screen off');
        } else {
            const covered = !!this._layer;
            this._dropLayer();
            if (covered) { try { pm?._turnOnScreen?.(); } catch (e) { this._log?.(`proximity: screen on ${e.message}`); } }
            this._log?.('proximity: far, screen on');
        }
    }
    _dropLayer() {
        if (this._psId) { global.backend.get_monitor_manager().disconnect(this._psId); this._psId = 0; }
        if (this._grab) { Main.popModal(this._grab); this._grab = null; }
        this._layer?.destroy(); this._layer = null;
    }
    destroy() { this.set(false); this._disown(); }
}
