// Preferences (NEO-SPEC §1.9): Home screen · Dock · Drawer · Search · Gestures · Theme.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {listPacks, SHAPES} from './launcher/packs.js';

const GESTURES = [['open_drawer', 'Open app drawer'], ['global_search', 'Launch global search'], ['open_notifications', 'Open notifications'], ['open_dash', 'Open Dash'], ['quick_settings', 'Open quick settings'], ['edit_mode', 'Edit Home Screen'], ['options_popup', 'Home options'], ['lock', 'Lock the phone'], ['none', 'Nothing']];

export default class NeoLauncherPrefs extends ExtensionPreferences {
    fillPreferencesWindow(win) {
        const s = this.getSettings();
        // settings handlers and timeouts that must not outlive the window (they touch its rows)
        const settingIds = [], timeouts = new Set();
        const follow = (key, fn) => settingIds.push(s.connect(`changed::${key}`, fn));
        win.connect('close-request', () => {
            for (const id of settingIds.splice(0)) s.disconnect(id);
            for (const id of timeouts) GLib.source_remove(id); timeouts.clear();
            return false;
        });
        // the first spin row would take focus and raise the on-screen keyboard over the page
        win.connect('map', () => {
            for (const ms of [0, 250, 600]) {
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { timeouts.delete(id); if (win.get_focus() instanceof Gtk.Text) win.set_focus(null); return GLib.SOURCE_REMOVE; });
                timeouts.add(id);
            }
        });
        const page = (title, icon) => { const p = new Adw.PreferencesPage({title, icon_name: icon}); win.add(p); return p; };
        const group = (p, title, desc) => { const g = new Adw.PreferencesGroup({title, description: desc ?? null}); p.add(g); return g; };
        const sw = (g, key, title, sub) => { const r = new Adw.SwitchRow({title, subtitle: sub ?? null}); s.bind(key, r, 'active', Gio.SettingsBindFlags.DEFAULT); g.add(r); };
        const spin = (g, key, title, lo, hi, step = 1, digits = 0) => { const r = new Adw.SpinRow({title, adjustment: new Gtk.Adjustment({lower: lo, upper: hi, step_increment: step}), digits}); s.bind(key, r, 'value', Gio.SettingsBindFlags.DEFAULT); g.add(r); };
        const scale = (g, key, title, lo, hi, step = 0.05) => { const r = new Adw.ActionRow({title}); const sc = new Gtk.Scale({orientation: Gtk.Orientation.HORIZONTAL, adjustment: new Gtk.Adjustment({lower: lo, upper: hi, step_increment: step}), draw_value: true, digits: 2, hexpand: true, width_request: 160}); s.bind(key, sc.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT); r.add_suffix(sc); g.add(r); };
        // combos follow the setting when it changes elsewhere (a restored backup, another prefs window, the Dash);
        // a value that is no longer offered shows the first entry without being written back
        const comboRow = (g, title, pairs, get, set, key) => {
            const r = new Adw.ComboRow({title, model: Gtk.StringList.new(pairs.map(p => p[1]))});
            const sync = () => { r.selected = Math.max(0, pairs.findIndex(p => p[0] === get())); };
            sync();
            r.connect('notify::selected', () => { const v = pairs[r.selected]?.[0]; if (v !== undefined && v !== get()) set(v); });
            follow(key, sync); g.add(r);
        };
        const combo = (g, key, title, pairs) => comboRow(g, title, pairs, () => s.get_string(key), v => s.set_string(key, v), key);
        /** `pairs` = [[int value, label]]: an entry can be left out without shifting the stored values. */
        const comboInt = (g, key, title, pairs) => comboRow(g, title, pairs, () => s.get_int(key), v => s.set_int(key, v), key);

        let p = page('Home screen', 'user-home-symbolic');
        let g = group(p, 'Icons');
        scale(g, 'desktop-icon-scale', 'Icon size', 0.5, 2); scale(g, 'desktop-label-scale', 'Label size', 0.5, 2);
        sw(g, 'desktop-hide-app-labels', 'Hide app labels'); sw(g, 'desktop-multiline-label', 'Multi-line labels');
        g = group(p, 'Grid');
        spin(g, 'desktop-grid-rows', 'Rows', 3, 8); spin(g, 'desktop-grid-columns', 'Columns', 3, 8);
        g = group(p, 'Behaviour');
        sw(g, 'desktop-lock', 'Lock desktop', 'Prevent moving and removing icons'); sw(g, 'desktop-cycle-scrolling', 'Cycle scrolling', 'Swipe past the last page to the first');
        sw(g, 'desktop-icon-add-installed', 'Add icons of new apps'); sw(g, 'desktop-allow-empty-pages', 'Allow empty pages');
        g = group(p, 'Folders'); spin(g, 'desktop-folder-columns', 'Columns', 2, 5); spin(g, 'desktop-folder-rows', 'Rows', 2, 5);

        p = page('Dock', 'view-grid-symbolic'); g = group(p, 'Dock');
        sw(g, 'dock-enabled', 'Dock enabled'); spin(g, 'dock-num-icons', 'Icons', 2, 16);
        sw(g, 'dock-custom-background', 'Custom background'); scale(g, 'dock-bottom-padding', 'Bottom padding', 0.1, 1.6);

        p = page('Drawer', 'view-app-grid-symbolic'); g = group(p, 'Layout');
        comboInt(g, 'drawer-layout', 'Layout', [[0, 'Vertical'], [1, 'Horizontal'], [2, 'Vertical categories'], [3, 'Horizontal tabs']]);
        spin(g, 'drawer-grid-columns', 'Columns', 2, 16);
        comboInt(g, 'drawer-sort-mode', 'Sort', [[0, 'A → Z'], [1, 'Z → A'], [2, 'Most used'], [4, 'Last installed']]);   // 3 "by colour" is not implemented
        sw(g, 'drawer-app-suggestions', 'App suggestions');
        g = group(p, 'Icons'); scale(g, 'drawer-icon-scale', 'Icon size', 0.5, 2); scale(g, 'drawer-label-scale', 'Label size', 0.3, 1.8);
        sw(g, 'drawer-hide-labels', 'Hide labels'); sw(g, 'drawer-multiline-label', 'Multi-line labels');
        g = group(p, 'Behaviour'); sw(g, 'drawer-save-scroll-position', 'Remember position'); sw(g, 'drawer-hide-scrollbar', 'Hide scrollbar');
        // Hidden apps (HiddenAppsPage): every launchable app with a switch; the title counts the selection
        g = group(p, 'Hidden apps');
        const hidden = new Adw.ExpanderRow({title: 'Hidden app shortcuts', subtitle: 'Hidden apps leave the drawer; search still finds them when "Search hidden apps" is on'});
        const apps = Gio.AppInfo.get_all().filter(a => a.should_show()).sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
        const current = () => new Set(s.get_strv('drawer-hidden-apps'));
        const title = () => { hidden.title = `Hidden app shortcuts (${current().size} selected)`; };
        for (const a of apps) {
            const r = new Adw.SwitchRow({title: a.get_display_name(), active: current().has(a.get_id())});
            r.connect('notify::active', () => { const set = current(); if (r.active) set.add(a.get_id()); else set.delete(a.get_id()); s.set_strv('drawer-hidden-apps', [...set]); title(); });
            hidden.add_row(r);
        }
        title(); g.add(hidden);
        g = group(p, 'Background'); sw(g, 'drawer-custom-background', 'Custom background'); scale(g, 'drawer-background-opacity', 'Opacity', 0, 1);

        p = page('Search', 'edit-find-symbolic'); g = group(p, 'Search');
        sw(g, 'search-drawer-enabled', 'Search bar in the drawer'); sw(g, 'search-fuzzy', 'Fuzzy search'); sw(g, 'search-hidden-apps', 'Search hidden apps'); sw(g, 'search-global', 'Search the web');
        // Search providers (SearchProvidersPage): the built-in engines, or a custom URL with %s for the query
        const ENGINES = [['https://duckduckgo.com/?q=%s', 'DuckDuckGo'], ['https://www.google.com/search?q=%s', 'Google'], ['https://www.bing.com/search?q=%s', 'Bing'], ['https://search.brave.com/search?q=%s', 'Brave'], ['https://www.ecosia.org/search?q=%s', 'Ecosia'], ['https://www.startpage.com/do/search?q=%s', 'Startpage'], ['https://www.qwant.com/?q=%s', 'Qwant'], ['https://metager.org/meta/meta.ger3?eingabe=%s', 'MetaGer'], ['https://yandex.com/search/?text=%s', 'Yandex'], ['https://www.baidu.com/s?wd=%s', 'Baidu'], ['https://en.wikipedia.org/w/index.php?search=%s', 'Wikipedia'], ['https://alternativeto.net/browse/search/?q=%s', 'AlternativeTo']];
        const engine = new Adw.ComboRow({title: 'Search engine', model: Gtk.StringList.new([...ENGINES.map(e => e[1]), 'Custom URL'])});
        const prov = new Adw.EntryRow({title: 'Custom search URL (%s = query)'}); s.bind('search-provider', prov, 'text', Gio.SettingsBindFlags.DEFAULT);
        const syncEngine = () => { const i = ENGINES.findIndex(e => e[0] === s.get_string('search-provider')); engine.selected = i < 0 ? ENGINES.length : i; prov.visible = i < 0; };
        syncEngine(); follow('search-provider', syncEngine);
        engine.connect('notify::selected', () => { if (engine.selected < ENGINES.length && s.get_string('search-provider') !== ENGINES[engine.selected][0]) s.set_string('search-provider', ENGINES[engine.selected][0]); prov.visible = engine.selected >= ENGINES.length; });
        g.add(engine); g.add(prov);

        p = page('Gestures', 'input-touchpad-symbolic'); g = group(p, 'Gestures');
        sw(g, 'gesture-back-edges', 'Back from the screen edges', 'Drag in from the left or right edge, as on Android');
        sw(g, 'keyboard-on-tap-only', 'Keyboard only after a tap', 'Apps that focus a text field while opening no longer raise the on-screen keyboard');
        spin(g, 'power-hold-ms', 'Power menu hold (ms)', 300, 5000, 100);
        // Dash (EditDashPage): grid width and which providers are on, in this order
        g = group(p, 'Dash', 'The sheet that double tap opens');
        spin(g, 'dash-line-size', 'Dash line size', 4, 6);
        const DASH = [['wifi', 'Wi-Fi', 'Control'], ['bluetooth', 'Bluetooth', 'Control'], ['airplane', 'Airplane mode', 'Control'], ['location', 'Location', 'Control'], ['rotation', 'Auto rotation', 'Control'], ['edit_dash', 'Edit Dash', 'Action'], ['wallpaper', 'Pick wallpaper', 'Action'], ['home_settings', 'Home settings', 'Action'], ['volume', 'Volume', 'Action'], ['settings', 'Device settings', 'Action'], ['apps', 'Manage apps', 'Action'], ['all_apps', 'All apps', 'Action'], ['sleep', 'Sleep', 'Action'], ['audio_player', 'Audio player', 'Action']];
        for (const [id, title, kind] of DASH) {
            const r = new Adw.SwitchRow({title, subtitle: kind, active: s.get_strv('dash-items').includes(id)});
            r.connect('notify::active', () => { const cur = s.get_strv('dash-items').filter(x => x !== id); s.set_strv('dash-items', r.active ? [...cur, id] : cur); });
            g.add(r);
        }
        for (const [k, t] of [['gesture-swipe-up', 'Swipe up'], ['gesture-swipe-down', 'Swipe down'], ['gesture-double-tap', 'Double tap'], ['gesture-long-press', 'Touch and hold'], ['gesture-dock-swipe-up', 'Swipe up on the dock'], ['gesture-pinch-in', 'Pinch in'], ['gesture-pinch-out', 'Pinch out']]) combo(g, k, t, GESTURES);

        p = page('Theme', 'preferences-color-symbolic'); g = group(p, 'Theme');
        combo(g, 'theme-mode', 'Theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark'], ['black', 'Black']]);
        g = group(p, 'Icons', 'Packs are folders under ~/.local/share/neolauncher/iconpacks (tools/import-iconpack.py turns an Android icon-pack APK into one)');
        combo(g, 'icon-pack', 'Icon pack', [['', 'None (icon theme)'], ...listPacks().map(x => [x.id, x.title])]);
        combo(g, 'icon-shape', 'Icon shape', SHAPES);
        sw(g, 'icon-legacy-treatment', 'Shape legacy icons', 'Put a tinted shaped background behind icons the pack does not cover');
        sw(g, 'icon-pack-wrap', 'Wrap unthemed icons', 'Draw the pack\'s own back, mask and overlay around icons it has no art for');
        sw(g, 'notification-dots', 'Notification dots'); sw(g, 'notification-count', 'Notification count');
        // Backups: every key of the schema as JSON (settings + home screen layout), restore replaces them
        g = group(p, 'Backups', 'Settings and the home screen layout as a JSON file');
        const backupRow = (title, subtitle, icon, cb) => { const r = new Adw.ActionRow({title, subtitle, activatable: true}); r.add_suffix(new Gtk.Image({icon_name: icon})); r.connect('activated', cb); g.add(r); };
        backupRow('Create backup', 'Save a .neobackup.json file', 'document-save-symbolic', () => {
            const d = new Gtk.FileDialog({initial_name: `neolauncher-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M')}.neobackup.json`});
            d.save(win, null, (dlg, res) => {
                try {
                    const f = dlg.save_finish(res); if (!f) return;
                    const data = {}; for (const k of s.settings_schema.list_keys()) data[k] = s.get_value(k).deep_unpack();
                    f.replace_contents(JSON.stringify({version: 1, uuid: this.metadata.uuid, settings: data}, null, 1), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                } catch (e) { if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) logError(e); }
            });
        });
        backupRow('Restore backup', 'Replaces the current settings and layout', 'document-revert-symbolic', () => {
            const d = new Gtk.FileDialog();
            d.open(win, null, (dlg, res) => {
                try {
                    const f = dlg.open_finish(res); if (!f) return;
                    const [, bytes] = f.load_contents(null); const b = JSON.parse(new TextDecoder().decode(bytes));
                    if (!b?.settings) throw new Error('not a Neo Launcher backup');
                    for (const [k, v] of Object.entries(b.settings)) { if (!s.settings_schema.has_key(k)) continue; const cur = s.get_value(k); s.set_value(k, new GLib.Variant(cur.get_type_string(), v)); }
                } catch (e) { if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) logError(e); }
            });
        });
        g = group(p, 'Developer'); sw(g, 'debug-logging', 'Debug logging');
        const restart = new Adw.ActionRow({title: 'Restart the launcher', subtitle: 'Can be helpful if some settings are not properly applied', activatable: true});
        restart.add_suffix(new Gtk.Image({icon_name: 'view-refresh-symbolic'}));
        // disable + enable through the shell's own extensions interface (the launcher's Reload is developer-only)
        const ext = (method, then) => Gio.DBus.session.call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions', method,
            new GLib.Variant('(s)', [this.metadata.uuid]), null, Gio.DBusCallFlags.NONE, -1, null, (c, res) => { try { c.call_finish(res); then?.(); } catch (e) { logError(e); } });
        restart.connect('activated', () => ext('DisableExtension', () => ext('EnableExtension')));
        g.add(restart);
    }
}
