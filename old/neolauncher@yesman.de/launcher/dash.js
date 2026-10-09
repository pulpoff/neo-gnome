// Dash (Neo `dash/DashPage`): the bottom sheet that double tap opens. A grid of `dash-line-size`
// columns (4–6): *controls* span two cells and toggle a system switch (filled when on), *actions*
// are square and run something. Items and their order come from the `dash-items` setting.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const {haptic} = await import(`${import.meta.url.replace(/\/[^/]*$/, '')}/drag.js?gen=${gen}`);

const OPEN_MS = 267, CLOSE_MS = 200;                 // ComposeBottomSheet
const GAP = 8, PAD = 8, CONTROL_ASPECT = 2.15;

const qs = () => Main.panel.statusArea?.quickSettings;
const launch = (desktopId) => {
    const info = Gio.DesktopAppInfo.new(desktopId); if (!info) throw new Error(`${desktopId} is not installed`);
    const ctx = global.create_app_launch_context(global.get_current_time(), -1); ctx.setenv('XDG_CURRENT_DESKTOP', 'GNOME');
    info.launch([], ctx);
};
const locationSettings = () => { try { return new Gio.Settings({schema_id: 'org.gnome.system.location'}); } catch (_) { return null; } };
const touchSettings = () => { try { return new Gio.Settings({schema_id: 'org.gnome.settings-daemon.peripherals.touchscreen'}); } catch (_) { return null; } };

/** Every provider Neo offers, with a GNOME backend. `available()` hides the ones this device cannot do. */
export const PROVIDERS = {
    wifi: {kind: 'control', label: 'Wi-Fi', icon: 'network-wireless-symbolic',
        available: () => !!qs()?._network?._client, get: () => !!qs()._network._client.wireless_enabled, set: v => { qs()._network._client.wireless_enabled = v; }},
    bluetooth: {kind: 'control', label: 'Bluetooth', icon: 'bluetooth-active-symbolic',
        available: () => !!qs()?._bluetooth?._client, get: () => !!qs()._bluetooth._client.default_adapter_powered, set: v => { qs()._bluetooth._client.default_adapter_powered = v; }},
    airplane: {kind: 'control', label: 'Airplane mode', icon: 'airplane-mode-symbolic',
        available: () => !!qs()?._rfkill?._manager, get: () => !!qs()._rfkill._manager.airplaneMode, set: v => { qs()._rfkill._manager.airplaneMode = v; }},
    location: {kind: 'control', label: 'Location', icon: 'location-services-active-symbolic',
        available: () => !!locationSettings(), get: () => locationSettings().get_boolean('enabled'), set: v => locationSettings().set_boolean('enabled', v)},
    rotation: {kind: 'control', label: 'Auto rotation', icon: 'rotation-allowed-symbolic',
        available: () => !!touchSettings(), get: () => !touchSettings().get_boolean('orientation-lock'), set: v => touchSettings().set_boolean('orientation-lock', !v)},
    edit_dash: {kind: 'action', label: 'Edit Dash', icon: 'document-edit-symbolic', run: (dash) => dash.home.openPreferences()},
    wallpaper: {kind: 'action', label: 'Pick wallpaper', icon: 'preferences-desktop-wallpaper-symbolic', run: () => { launch('gnome-background-panel.desktop'); Main.overview.hide(); }},
    home_settings: {kind: 'action', label: 'Home settings', icon: 'preferences-system-symbolic', run: (dash) => dash.home.openPreferences()},
    volume: {kind: 'action', label: 'Volume', icon: 'audio-volume-high-symbolic', run: () => qs()?.menu?.open()},
    settings: {kind: 'action', label: 'Device settings', icon: 'org.gnome.Settings-symbolic', run: () => { launch('org.gnome.Settings.desktop'); Main.overview.hide(); }},
    apps: {kind: 'action', label: 'Manage apps', icon: 'view-app-grid-symbolic', run: () => { launch('gnome-applications-panel.desktop'); Main.overview.hide(); }},
    all_apps: {kind: 'action', label: 'All apps', icon: 'view-grid-symbolic', run: (dash) => dash.home.drawer.open()},
    sleep: {kind: 'action', label: 'Sleep', icon: 'weather-clear-night-symbolic', run: () => Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)', ['org.gnome.Mutter.DisplayConfig', 'PowerSaveMode', new GLib.Variant('i', 3)]), null, Gio.DBusCallFlags.NONE, -1, null, null)},
    audio_player: {kind: 'action', label: 'Audio player', icon: 'multimedia-player-symbolic', run: () => { const a = Gio.AppInfo.get_default_for_type('audio/mpeg', false); if (!a) throw new Error('No audio player set'); a.launch([], global.create_app_launch_context(global.get_current_time(), -1)); Main.overview.hide(); }},
};
export const DEFAULT_ITEMS = ['wifi', 'bluetooth', 'settings', 'volume', 'all_apps', 'edit_dash'];

export const Dash = GObject.registerClass({GTypeName: `NeoDash_${gen}`}, class Dash extends St.Widget {
    _init(home) {
        super._init({style_class: 'neo-dash-scrim', reactive: true, x_expand: true, y_expand: true, visible: false, opacity: 0, layout_manager: new Clutter.BinLayout()});
        this.home = home; this.settings = home.settings;
        this._sheet = new St.BoxLayout({style_class: 'neo-dash', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.END, x_align: Clutter.ActorAlign.FILL});
        this.add_child(this._sheet);
        this._grid = new St.Widget({layout_manager: new Clutter.FixedLayout(), x_expand: true});
        this._sheet.add_child(this._grid);
        this.connect('button-release-event', (a, ev) => { const [, y] = ev.get_coords(); if (y < this._sheet.get_transformed_position()[1]) this.close(); return Clutter.EVENT_STOP; });
        this.connect('touch-event', (a, ev) => { if (ev.type() !== Clutter.EventType.TOUCH_END) return Clutter.EVENT_PROPAGATE; const [, y] = ev.get_coords(); if (y < this._sheet.get_transformed_position()[1]) this.close(); return Clutter.EVENT_STOP; });
    }

    get isOpen() { return this.visible && this.opacity > 0; }

    open() {
        this._build();
        this.visible = true;
        const h = this._sheet.height || 200;
        this._sheet.translation_y = h;
        this.ease({opacity: 255, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._sheet.ease({translation_y: 0, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUINT});
    }
    close() {
        if (!this.visible) return;
        this.ease({opacity: 0, duration: CLOSE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => { this.visible = false; }});
        this._sheet.ease({translation_y: this._sheet.height, duration: CLOSE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});
    }

    _build() {
        this._grid.destroy_all_children();
        const cols = Math.max(4, Math.min(6, this.settings.get_int('dash-line-size')));
        const W = (this.home.get_width() || Main.layoutManager.primaryMonitor.width);
        const cell = Math.floor((W - 2 * PAD - (cols - 1) * GAP) / cols);
        const ids = this.settings.get_strv('dash-items').filter(id => PROVIDERS[id] && (PROVIDERS[id].available?.() ?? true));
        let col = 0, row = 0, rowH = cell;
        const controlH = Math.round((2 * cell + GAP) / CONTROL_ASPECT);
        for (const id of ids) {
            const p = PROVIDERS[id], span = p.kind === 'control' ? 2 : 1;
            if (col + span > cols) { col = 0; row += 1; }
            const tile = p.kind === 'control' ? this._controlTile(id, p) : this._actionTile(id, p);
            const w = span * cell + (span - 1) * GAP, h = p.kind === 'control' ? controlH : cell;
            tile.set_size(w, h);
            tile.set_position(PAD + col * (cell + GAP), PAD + row * (Math.max(cell, controlH) + GAP));
            this._grid.add_child(tile);
            col += span; rowH = Math.max(cell, controlH);
        }
        this._grid.set_size(W, PAD * 2 + (row + 1) * (rowH + GAP) - GAP);
    }

    _controlTile(id, p) {
        const b = new St.Button({style_class: 'neo-dash-control', reactive: true, track_hover: true});
        const box = new St.BoxLayout({style_class: 'neo-dash-control-box', x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Icon({icon_name: p.icon, icon_size: 24, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: p.label, style_class: 'neo-dash-label', y_align: Clutter.ActorAlign.CENTER, x_expand: true}));
        b.set_child(box);
        let on = false; try { on = !!p.get(); } catch (_) {}
        if (on) b.add_style_class_name('on');
        b.connect('clicked', () => {
            try { const v = !b.has_style_class_name('on'); p.set(v); if (v) b.add_style_class_name('on'); else b.remove_style_class_name('on'); haptic('button-pressed'); }
            catch (e) { Main.notify('Neo Launcher', e.message); }
        });
        return b;
    }
    _actionTile(id, p) {
        const b = new St.Button({style_class: 'neo-dash-action', reactive: true, track_hover: true, child: new St.Icon({icon_name: p.icon, icon_size: 26, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true})});
        b.connect('clicked', () => { this.close(); try { p.run(this); } catch (e) { logError(e, '[neolauncher] dash'); Main.notify('Neo Launcher', e.message); } });
        return b;
    }
});
