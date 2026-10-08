// Notification dots (NEO-SPEC §1.1: NotificationListener → DotRenderer). GNOME's
// message tray is the listener: every source that belongs to an app contributes its
// notification count; cells show a dot (or the count) for their app, folders the sum.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
