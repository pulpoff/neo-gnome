// Notification dots (NEO-SPEC §1.1: NotificationListener → DotRenderer). GNOME's
// message tray is the listener: every source that belongs to an app contributes its
// notification count; cells show a dot (or the count) for their app, folders the sum.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export class NotificationDots {
    constructor(onChange) {
        this._onChange = onChange; this._sources = new Map(); this.counts = new Map();
        const tray = Main.messageTray;
        this._addedId = tray.connect('source-added', (t, s) => this._track(s));
        this._removedId = tray.connect('source-removed', (t, s) => this._untrack(s));
        for (const s of tray.getSources()) this._track(s);
    }
    _track(source) {
        if (this._sources.has(source)) return;
        this._sources.set(source, source.connect('notify::count', () => this._recount()));
        this._recount();
    }
    _untrack(source) {
        const id = this._sources.get(source); if (id) source.disconnect(id); this._sources.delete(source); this._recount();
    }
    _recount() {
        const counts = new Map();
        for (const s of this._sources.keys()) {
            const app = s.app ?? s._app; const id = app?.get_id?.(); if (!id || !s.count) continue;
            counts.set(id, (counts.get(id) ?? 0) + s.count);
        }
        const changed = counts.size !== this.counts.size || [...counts].some(([k, v]) => this.counts.get(k) !== v);
        this.counts = counts;
        if (changed) this._onChange(counts);
    }
    countFor(item) {
        if (item.type === 'app') return this.counts.get(item.id) ?? 0;
        return (item.items ?? []).reduce((n, id) => n + (this.counts.get(id) ?? 0), 0);
    }
    destroy() {
        for (const [s, id] of this._sources) s.disconnect(id); this._sources.clear();
        Main.messageTray.disconnect(this._addedId); Main.messageTray.disconnect(this._removedId);
    }
}

/**
 * Android plays the notification sound (and buzzes) for every app; GNOME only plays a sound an app attaches to
 * its notification, and next to none do, so notifications arrived silent. A new notification from an app that
 * brought no sound of its own gets feedbackd's 'message-new-instant' (sound + vibration in the 'full' profile,
 * vibration alone in 'quiet'). Silent in Do Not Disturb, for apps whose sound is off in Settings, for critical
 * ones (a ringing call rings by itself) and while the user is looking at that app.
 */
export class NotificationSounds {
    constructor() {
        this._sources = new Map();
        this._banners = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._fbcli = GLib.find_program_in_path('fbcli');
        const tray = Main.messageTray;
        this._addedId = tray.connect('source-added', (t, s) => this._track(s));
        this._removedId = tray.connect('source-removed', (t, s) => this._untrack(s));
        for (const s of tray.getSources()) this._track(s);
    }
    _track(source) {
        if (this._sources.has(source)) return;
        this._sources.set(source, source.connect('notification-added', (src, n) => this._onAdded(src, n)));
    }
    _untrack(source) {
        const id = this._sources.get(source); if (id) source.disconnect(id); this._sources.delete(source);
    }
    _onAdded(source, n) {
        const app = source.app ?? source._app;
        if (!app || !this._fbcli || n.sound?._soundName || n.sound?._soundFile || n.forFeedback || n.isTransient) return;   // FDO notifications carry an empty Sound
        if (n.urgency === MessageTray.Urgency.CRITICAL || !source.policy?.enableSound) return;
        if (!this._banners.get_boolean('show-banners')) return;                 // Do Not Disturb
        const focus = global.display.focus_window;
        if (!Main.overview.visible && !Main.sessionMode.isLocked && focus &&
            Shell.WindowTracker.get_default().get_window_app(focus) === app) return;
        const now = GLib.get_monotonic_time();
        if (now - (this._last ?? 0) < 1.5e6) return;                             // a burst plays once
        this._last = now;
        try { Gio.Subprocess.new([this._fbcli, '-E', 'message-new-instant', '-t', '1'], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE); } catch (_) {}
    }
    destroy() {
        for (const [s, id] of this._sources) s.disconnect(id); this._sources.clear();
        Main.messageTray.disconnect(this._addedId); Main.messageTray.disconnect(this._removedId);
    }
}

/**
 * The status LED (white, above the screen) breathes while the screen is off and notifications are unread, as on
 * Android: it fades up over 1.2 s, back down over 1.2 s, and rests dark for 2.6 s. The LED's pattern trigger
 * does the fading in the kernel (it ramps between consecutive points); feedbackd's udev rule puts the LED on
 * that trigger and gives its group, which the phone's user is in, the pattern file. Stopping writes an all-dark
 * pattern: a brightness of 0 would drop the trigger, and only root can set it again. The screen state is polled
 * while something is unread: mutter's power-save signal is not reliable here.
 */
const LED = '/sys/class/leds/white:status';
const BREATHE = '0 1200 511 1200 0 2600 0 0';
const DARK = '0 1000 0 1000';

export class NotificationLed {
    constructor() {
        this._sources = new Map();
        const tray = Main.messageTray;
        this._addedId = tray.connect('source-added', (t, s) => this._track(s));
        this._removedId = tray.connect('source-removed', (t, s) => { this._untrack(s); this._sync(); });
        for (const s of tray.getSources()) this._track(s);
        this._sync();
    }
    _track(source) {
        if (this._sources.has(source)) return;
        this._sources.set(source, source.connect('notify::count', () => this._sync()));
    }
    _untrack(source) {
        const id = this._sources.get(source); if (id) source.disconnect(id); this._sources.delete(source);
    }
    _unread() { let n = 0; for (const s of this._sources.keys()) n += s.count ?? 0; return n; }
    _screenOff() { return global.backend.get_monitor_manager().power_save_mode !== 0; }
    _sync() {
        const want = this._unread() > 0;
        if (want && !this._poll)
            this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => { this._apply(); return GLib.SOURCE_CONTINUE; });
        if (!want && this._poll) { GLib.source_remove(this._poll); this._poll = 0; }
        this._apply();
    }
    _apply() {
        const on = this._unread() > 0 && this._screenOff();
        if (on === this._on) return;
        this._on = on;
        this._write(on ? BREATHE : DARK);
    }
    _write(pattern) {
        try {
            const f = Gio.File.new_for_path(`${LED}/pattern`);
            f.replace_contents(new TextEncoder().encode(pattern), null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) { console.warn(`[neolauncher] led: ${e.message}`); }
    }
    destroy() {
        if (this._poll) { GLib.source_remove(this._poll); this._poll = 0; }
        if (this._on) this._write(DARK);
        this._on = false;
        for (const [s, id] of this._sources) s.disconnect(id); this._sources.clear();
        Main.messageTray.disconnect(this._addedId); Main.messageTray.disconnect(this._removedId);
    }
}
