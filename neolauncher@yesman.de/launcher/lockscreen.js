// A swipe-up lock screen, Android style: no password, it is the screen you wake the phone to.
//
// It goes up the moment the panel turns off (power button, idle blank) and covers everything with the
// wallpaper, a big clock, the date, the apps that have notifications, an open padlock and the battery
// state. Swiping up (past a quarter of the screen, or a flick) slides it away and leaves the home.
// It never comes up during a call (the call screen manages the panel itself) and gets out of the way
// for a window that wants attention (an incoming call: demands-attention / urgent, whatever the app).
// Phones only (layoutManager.is_phone): a desktop's screen blank must not leave a modal swipe lock.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import GnomeDesktop from 'gi://GnomeDesktop';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const here = import.meta.url.replace(/\/[^/]*$/, '');
const {firstDelta} = await import(`${here}/gesture.js?gen=${gen}`);
const {readText, dbusCall, isPhone} = await import(`${here}/util.js?gen=${gen}`);

// Like Android, the lock screen turns the panel off by itself after a short while untouched, whatever the
// session's idle delay is (the dev phone runs with idle-delay 0, "never").
const LOCK_TIMEOUT_S = 15;
const LOCK_FADE_MS = 1000;     // the panel fades to black before it goes off; a touch meanwhile brings it back

// UPower's Device.State
const UP_CHARGING = 1, UP_FULLY_CHARGED = 4, UP_PENDING_CHARGE = 5;

function batteryText(pct, state) {
    if (state === UP_FULLY_CHARGED || (state === UP_CHARGING && pct >= 100) || (state === UP_PENDING_CHARGE && pct >= 99)) return 'Charged';
    if (state === UP_CHARGING) return `Charging · ${pct}%`;
    return `${pct}%`;
}

/** The battery line from sysfs: the first power_supply of type Battery (UPower's fallback). */
function sysfsBattery() {
    let names = [];
    try {
        const en = Gio.File.new_for_path('/sys/class/power_supply').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let i; (i = en.next_file(null));) names.push(i.get_name());
        en.close(null);
    } catch (_) { return ''; }
    const states = {'Charging': UP_CHARGING, 'Full': UP_FULLY_CHARGED, 'Not charging': UP_PENDING_CHARGE};
    for (const dev of names.sort()) {
        const dir = `/sys/class/power_supply/${dev}`;
        if (readText(`${dir}/type`) !== 'Battery') continue;
        const cap = readText(`${dir}/capacity`);
        if (cap === null) continue;
        return batteryText(Number(cap), states[readText(`${dir}/status`)] ?? 0);
    }
    return '';
}

/** UPower's DisplayDevice (the combined battery the shell's own indicator shows); sysfs when UPower is not there. */
async function battery() {
    try {
        const [props] = await dbusCall(Gio.DBus.system, 'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', ['org.freedesktop.UPower.Device']), 2000);
        if (props.IsPresent?.unpack()) return batteryText(Math.round(props.Percentage.unpack()), props.State.unpack());
    } catch (_) {}
    return sysfsBattery();
}

export const LockScreen = GObject.registerClass({GTypeName: `NeoLockScreen_${gen}`},
class LockScreen extends St.Widget {
    _init(home) {
        super._init({name: 'neoLockScreen', style_class: 'neo-lock', reactive: true, visible: false, layout_manager: new Clutter.FixedLayout()});
        this.home = home; this.log = m => home.log?.(m);
        this._bg = new St.Widget({x_expand: true, y_expand: true});
        this.add_child(this._bg);
        this._bgManager = new Background.BackgroundManager({container: this._bg, monitorIndex: Main.layoutManager.primaryIndex, controlPosition: false});
        this._dim = new St.Widget({style_class: 'neo-lock-dim'});
        this.add_child(this._dim);

        this._clock = new St.Label({style_class: 'neo-lock-clock'});
        this._date = new St.Label({style_class: 'neo-lock-date'});
        this._icons = new St.BoxLayout({style_class: 'neo-lock-notif', visible: false});
        this._padlock = new St.Icon({icon_name: 'changes-allow-symbolic', style_class: 'neo-lock-padlock'});
        this._status = new St.Label({style_class: 'neo-lock-status'});
        for (const a of [this._clock, this._date, this._icons, this._padlock, this._status]) this.add_child(a);

        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._clockId = this._wallClock.connect('notify::clock', () => this._update());

        this._setupGesture();
        // the clock's size is only known once its 84 px style applies: lay out again when it changes
        this._clock.connect('notify::height', () => this._layout());
        Main.layoutManager.addTopChrome(this, {affectsInputRegion: true, trackFullscreen: false});

        const mm = global.backend.get_monitor_manager();
        this._psId = mm.connect('power-save-mode-changed', () => {
            // going dark: a fading veil stays until the next wake
            if (mm.power_save_mode !== 0) { this._onScreenOff(); this._stopTimer(); } else { this._update(); this._armLit(); }
        });
        // The shell's own blank (power key, idle, our timeout) brings the lock up. Mutter's power-save signal is
        // not enough: it does not always fire on the way down, and power_save_mode can still read 0 inside it.
        const pm = Main.powerManager;
        if (pm?._turnOffScreen) {
            const proto = Object.getPrototypeOf(pm);
            const orig = proto.__neoOrigTurnOff ??= proto._turnOffScreen;
            const origOn = proto.__neoOrigTurnOn ??= proto._turnOnScreen;
            const lock = this;
            this._pm = pm;
            // going dark: the lock comes up, but its timeout must not run on a dark panel
            pm._turnOffScreen = async function (...args) {
                const r = await orig.apply(this, args);
                if (!lock._destroyed) { lock._onScreenOff(); lock._stopTimer(); }
                return r;
            };
            // lit again (power key, double tap): the 15 s start now, on the shell's own wake, not on Mutter's signal
            if (origOn) pm._turnOnScreen = function (...args) {
                const r = origOn.apply(this, args);
                if (!lock._destroyed) lock._armLit();
                return r;
            };
        }
        // any touch, drag or key on the lock screen starts its timeout again
        this.connect('captured-event', (_a, ev) => {
            const t = ev.type();
            if (t === Clutter.EventType.TOUCH_BEGIN || t === Clutter.EventType.TOUCH_UPDATE || t === Clutter.EventType.BUTTON_PRESS ||
                t === Clutter.EventType.MOTION || t === Clutter.EventType.KEY_PRESS) this._armLit();
            return Clutter.EVENT_PROPAGATE;
        });
        this._focusId = global.display.connect('window-demands-attention', () => this.dismiss(true));
        // double tap while the panel is off (touch firmware gesture → keychord.service → this file): wake the screen
        try {
            this._wakeMon = Gio.File.new_for_path('/run/neolauncher/wake').monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._wakeMonId = this._wakeMon.connect('changed', (_m, _f, _o, type) => {
                if (type !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && type !== Gio.FileMonitorEvent.CHANGED) return;
                const now = GLib.get_monotonic_time(); if (this._wokeAt && now - this._wokeAt < 1e6) return; this._wokeAt = now;
                this.log('lock: double tap wake');
                try { Main.powerManager?._turnOnScreen?.(); } catch (_) {}
                try { global.backend.get_monitor_manager().power_save_mode = 0; } catch (_) {}
            });
        } catch (e) { this.log(`wake monitor: ${e.message}`); }
        this._urgentId = global.display.connect('window-marked-urgent', () => this.dismiss(true));
        // the screen rotates under a showing lock screen too
        this._monId = Main.layoutManager.connect('monitors-changed', () => { if (this.visible) { this._fitToMonitor(); this._layout(); } });
        this.connect('destroy', () => this._onDestroy());
        // The phone starts on the lock screen: once per shell process (the launcher's first load at login),
        // never on a hot reload or a re-enable after a lock; extension.js keeps that count, as this module is
        // imported again on a dev reload. Synchronously: the home must never be seen before the lock at boot.
        if (isPhone() && home.ext?.claimBootLock?.() && !this._inCall()) this.show_();
    }

    _onDestroy() {
        this._destroyed = true;
        this._disarm();
        if (this._pm) { delete this._pm._turnOffScreen; delete this._pm._turnOnScreen; this._pm = null; }   // back to the prototype's own
        if (this._monId) { Main.layoutManager.disconnect(this._monId); this._monId = 0; }
        const mm = global.backend.get_monitor_manager();
        if (this._psId) mm.disconnect(this._psId);
        if (this._focusId) global.display.disconnect(this._focusId);
        if (this._wakeMonId) { this._wakeMon.disconnect(this._wakeMonId); this._wakeMon.cancel(); }
        if (this._urgentId) global.display.disconnect(this._urgentId);
        if (this._clockId) this._wallClock.disconnect(this._clockId);
        this._releaseGrab();
        this._bgManager?.destroy();
    }

    /** No lock while a call runs: the call screen owns the panel (proximity off/on) and must stay usable. */
    _inCall() { return !!this.home.callProximity?.active; }

    /** A black veil over the whole stage eases in; at full black the panel is turned off. */
    _fadeOut() {
        this._dropFade();
        const veil = this._veil = new St.Widget({style: 'background-color: black;', reactive: false, opacity: 0,
            x: 0, y: 0, width: global.stage.width, height: global.stage.height});
        Main.layoutManager.uiGroup.add_child(veil);
        Main.layoutManager.uiGroup.set_child_above_sibling(veil, null);
        veil.ease({opacity: 255, duration: LOCK_FADE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => {
            if (this._veil !== veil) return;          // a touch took it away meanwhile
            this._screenOff();
            // the veil goes once the panel is dark, so the next wake shows the lock screen, not black
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { if (this._veil === veil) this._dropFade(); return GLib.SOURCE_REMOVE; });
        }});
    }

    _dropFade() {
        if (!this._veil) return;
        const veil = this._veil; this._veil = null;
        veil.remove_all_transitions(); veil.destroy();
    }

    _screenOff() {
        this.log('lock: screen off');
        // the power key's own blank; the monitor manager directly if the shell's power manager is not there
        try {
            if (Main.powerManager?._turnOffScreen) Main.powerManager._turnOffScreen();
            else global.backend.get_monitor_manager().power_save_mode = 3;
        } catch (e) { this.log(`lock: screen off failed: ${e.message}`); }
    }

    _stopTimer() { if (this._timeoutId) { GLib.source_remove(this._timeoutId); this._timeoutId = 0; } }

    /** The panel was just lit: start the timeout without trusting Mutter's power_save_mode. */
    _armLit() {
        this._stopTimer();
        this._dropFade();             // a veil left from the last fade goes as soon as the panel is lit
        if (!this.visible || this._inCall()) return;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LOCK_TIMEOUT_S, () => {
            this._timeoutId = 0;
            if (!this.visible || this._inCall()) return GLib.SOURCE_REMOVE;
            this.log(`lock: ${LOCK_TIMEOUT_S} s untouched, fading out`);
            this._fadeOut();
            return GLib.SOURCE_REMOVE;
        });
    }

    _disarm() { this._stopTimer(); this._dropFade(); }

    _onScreenOff() {
        if (this._inCall() || this.visible) return;
        this.show_();
    }

    _fitToMonitor() {
        // below the status bar, which stays visible as on Android; the wallpaper is placed as if full-screen
        const mon = Main.layoutManager.primaryMonitor, ph = Main.panel?.height ?? 0;
        this.set_position(mon.x, mon.y + ph); this.set_size(mon.width, mon.height - ph);
        this._bg.set_position(0, -ph); this._bg.set_size(mon.width, mon.height); this._dim.set_size(mon.width, mon.height - ph);
    }

    show_() {
        if (!isPhone()) return;
        this._fitToMonitor();
        this.clip_to_allocation = true;
        this.translation_y = 0; this.opacity = 255;
        this._update();
        this.show();
        if (!this._grab) this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.LOCK_SCREEN});
        this.log('lock: shown');
    }

    _releaseGrab() { if (this._grab) { Main.popModal(this._grab); this._grab = null; } }

    /** Slide up and away; `toHome` = leave the launcher's home showing (the Android unlock). */
    dismiss(immediate = false) {
        if (!this.visible) return;
        this._disarm();
        this._releaseGrab();
        const done = () => { this.hide(); this.translation_y = 0; this.opacity = 255; };
        if (immediate) { done(); return; }
        const mon = Main.layoutManager.primaryMonitor;
        this.ease({translation_y: -mon.height, opacity: 160, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: done});
        // unlocking lands on the home, as on Android
        try { if (!Main.overview.visible) Main.overview.show(); } catch (_) {}
        this.home.recents?.goHome?.();
        this.log('lock: dismissed');
    }

    _update() {
        if (!this.visible && this._lastUpdate) return;
        this._lastUpdate = true;
        const now = GLib.DateTime.new_now_local();
        this._clock.text = now.format('%H:%M');
        this._date.text = now.format('%a, %b %-d');
        const token = this._batteryToken = (this._batteryToken ?? 0) + 1;
        battery().then(text => {
            if (token !== this._batteryToken || this._destroyed) return;
            this._status.text = text;
            this._layout();
        });
        // the apps that have notifications waiting, as a row of icons
        this._icons.destroy_all_children();
        const seen = new Set();
        for (const src of Main.messageTray?.getSources?.() ?? []) {
            if (!src.count && !(src.notifications?.length)) continue;
            const key = src.app?.get_id?.() ?? src.title; if (seen.has(key)) continue; seen.add(key);
            const gicon = src.app?.get_icon?.() ?? src.icon ?? null;
            if (gicon) this._icons.add_child(new St.Icon({gicon, icon_size: 18, style_class: 'neo-lock-notif-icon'}));
            if (seen.size >= 6) break;
        }
        this._icons.visible = this._icons.get_n_children() > 0;
        this._layout();
    }

    _layout() {
        const mon = Main.layoutManager.primaryMonitor, ph = Main.panel?.height ?? 0, W = mon.width, H = mon.height - ph;
        const top = 36;
        this._clock.set_position(24, top);
        const ch = Math.max(this._clock.height, this._clock.get_preferred_height(-1)[1]);
        this._date.set_position(28, top + ch + 4);
        const [, dh] = this._date.get_preferred_height(-1);
        this._icons.set_position(24, top + ch + dh + 24);
        const [, pw] = this._padlock.get_preferred_width(-1);
        // landscape: the screen is short, so the padlock and the hint sit near the bottom edge
        const landscape = W > mon.height;
        this._padlock.set_position(Math.round((W - pw) / 2), H - (landscape ? 92 : 150));
        const [, sw] = this._status.get_preferred_width(-1);
        this._status.set_position(Math.round((W - sw) / 2), H - (landscape ? 50 : 104));
    }

    _setupGesture() {
        const pan = new Clutter.PanGesture({pan_axis: Clutter.PanAxis.Y});
        pan.connect('pan-update', g => { const dy = firstDelta(g)[1]; this.translation_y = Math.min(0, dy); this.opacity = Math.round(255 * (1 - Math.min(0.5, -this.translation_y / this.height))); });
        pan.connect('end', g => {
            const dy = firstDelta(g)[1], vy = g.get_velocity().get_y();
            if (-dy > this.height * 0.25 || vy < -0.8) this.dismiss();
            else this.ease({translation_y: 0, opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        pan.connect('cancel', () => this.ease({translation_y: 0, opacity: 255, duration: 200}));
        this.add_action(pan);
    }
});
