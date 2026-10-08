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
