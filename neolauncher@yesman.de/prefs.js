// Preferences (NEO-SPEC §1.9), laid out like Android's One UI settings for a finger, not a mouse: a start page
// of categories (coloured round icons, "Item • Item" subtitles), sub-pages with a big title, rounded cards on
// black, tall rows with bold titles, the chosen value in accent blue under its row (tap = a page of big radio
// rows, no dropdowns or spin buttons), sliders under their title, blue switches.
// Rows whose key the installed schema does not have are left out, so one prefs.js serves older builds too.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {listPacks, SHAPES} from './launcher/packs.js';

const GESTURES = [['open_drawer', 'Open app drawer'], ['global_search', 'Launch global search'], ['open_notifications', 'Open notifications'], ['open_dash', 'Open Dash'], ['quick_settings', 'Open quick settings'], ['edit_mode', 'Edit Home Screen'], ['options_popup', 'Home options'], ['lock', 'Lock the phone'], ['none', 'Nothing']];
const ENGINES = [['https://duckduckgo.com/?q=%s', 'DuckDuckGo'], ['https://www.google.com/search?q=%s', 'Google'], ['https://www.bing.com/search?q=%s', 'Bing'], ['https://search.brave.com/search?q=%s', 'Brave'], ['https://www.ecosia.org/search?q=%s', 'Ecosia'], ['https://www.startpage.com/do/search?q=%s', 'Startpage'], ['https://www.qwant.com/?q=%s', 'Qwant'], ['https://metager.org/meta/meta.ger3?eingabe=%s', 'MetaGer'], ['https://yandex.com/search/?text=%s', 'Yandex'], ['https://www.baidu.com/s?wd=%s', 'Baidu'], ['https://en.wikipedia.org/w/index.php?search=%s', 'Wikipedia'], ['https://alternativeto.net/browse/search/?q=%s', 'AlternativeTo']];
const DASH = [['wifi', 'Wi-Fi', 'Control'], ['bluetooth', 'Bluetooth', 'Control'], ['airplane', 'Airplane mode', 'Control'], ['location', 'Location', 'Control'], ['rotation', 'Auto rotation', 'Control'], ['edit_dash', 'Edit Dash', 'Action'], ['wallpaper', 'Pick wallpaper', 'Action'], ['home_settings', 'Home settings', 'Action'], ['volume', 'Volume', 'Action'], ['settings', 'Device settings', 'Action'], ['apps', 'Manage apps', 'Action'], ['all_apps', 'All apps', 'Action'], ['sleep', 'Sleep', 'Action'], ['audio_player', 'Audio player', 'Action']];
const range = (lo, hi, step = 1, fmt = v => String(v)) => { const r = []; for (let v = lo; v <= hi; v += step) r.push([v, fmt(v)]); return r; };

// One UI's look. Sizes are logical px at the phone's scale; colours follow the light/dark style.
const CSS = `
window.oneui, window.oneui .oneui-page { background-color: #f6f6f6; }
window.oneui headerbar { background: transparent; box-shadow: none; min-height: 56px; }
window.oneui headerbar .title, window.oneui headerbar .oneui-title { font-size: 17px; font-weight: 800; }
window.oneui preferencespage > scrolledwindow > viewport > clamp > box { margin: 0 12px; }
window.oneui .oneui-hero .heading { font-size: 22px; font-weight: 800; margin: 18px 0 10px 8px; color: @window_fg_color; opacity: 1; }
window.oneui .oneui-hero .dim-label, window.oneui .oneui-lead { font-size: 14px; font-weight: 600; margin: 0 8px 6px 8px; }
window.oneui preferencesgroup .heading { font-size: 14px; font-weight: 700; color: alpha(currentColor, .55); margin-left: 18px; }
window.oneui .boxed-list { background-color: #ffffff; border-radius: 26px; box-shadow: none; border: none; }
window.oneui .boxed-list > row { min-height: 62px; padding: 4px 14px; border-bottom: 1px solid alpha(currentColor, .08); background: transparent; }
window.oneui .boxed-list > row:last-child { border-bottom: none; }
window.oneui .boxed-list > row:first-child { border-top-left-radius: 26px; border-top-right-radius: 26px; }
window.oneui .boxed-list > row:last-child { border-bottom-left-radius: 26px; border-bottom-right-radius: 26px; }
window.oneui row .title { font-size: 17px; font-weight: 700; }
window.oneui row .subtitle { font-size: 14px; font-weight: 500; }
window.oneui row.oneui-value .subtitle { color: #0381fe; opacity: 1; font-weight: 600; }
window.oneui .oneui-cat-icon { border-radius: 999px; min-width: 36px; min-height: 36px; color: white; margin-right: 6px; }
window.oneui switch:checked { background-color: #0381fe; }
window.oneui checkbutton check:checked, window.oneui checkbutton radio:checked { background-color: #0381fe; color: white; }
window.oneui checkbutton radio { min-width: 26px; min-height: 26px; }
window.oneui .oneui-slider scale { padding: 6px 4px 10px 4px; }
window.oneui .oneui-slider scale trough { min-height: 6px; border-radius: 3px; }
window.oneui .oneui-slider scale highlight { background-color: #0381fe; border-radius: 3px; }
window.oneui .oneui-slider scale slider { min-width: 26px; min-height: 26px; background-color: white; box-shadow: 0 1px 3px alpha(black, .35); }
`;

// applied on top of CSS while libadwaita's style is dark (GTK here does not evaluate prefers-color-scheme)
const CSS_DARK = `window.oneui, window.oneui .oneui-page { background-color: #000000; }
  window.oneui .boxed-list { background-color: #1c1c1e; }
  window.oneui row.oneui-value .subtitle { color: #3e91ff; }
  window.oneui switch:checked, window.oneui checkbutton radio:checked, window.oneui .oneui-slider scale highlight { background-color: #3e91ff; }
`;

export default class NeoLauncherPrefs extends ExtensionPreferences {
    fillPreferencesWindow(win) {
        const s = this.getSettings();
        const has = k => s.settings_schema.has_key(k);
        const display = Gdk.Display.get_default();
        const css = new Gtk.CssProvider(); css.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        const cssDark = new Gtk.CssProvider(); cssDark.load_from_string(CSS_DARK);
        const styles = Adw.StyleManager.get_default();
        let darkOn = false;
        const applyDark = () => {
            if (styles.dark === darkOn) return;
            darkOn = styles.dark;
            if (darkOn) Gtk.StyleContext.add_provider_for_display(display, cssDark, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
            else Gtk.StyleContext.remove_provider_for_display(display, cssDark);
        };
        applyDark();
        const darkId = styles.connect('notify::dark', applyDark);
        win.connect('close-request', () => { styles.disconnect(darkId); return false; });
        // The start page's title goes in the window's own header bar, left-aligned next to the close button like
        // the sub-pages' "< Title" (the window does not expose its header bar: find it in the widget tree).
        win.set_title('Neo Launcher');
        win.connect('map', () => {
            const find = w => { for (let c = w?.get_first_child(); c; c = c.get_next_sibling()) { if (c instanceof Adw.HeaderBar) return c; const r = find(c); if (r) return r; } return null; };
            const hb = find(win);
            if (!hb || hb._oneui) return;
            hb._oneui = true;
            hb.centering_policy = Adw.CenteringPolicy.LOOSE;
            const tl = new Gtk.Label({label: 'Neo Launcher', halign: Gtk.Align.START, hexpand: true, margin_start: 8});
            tl.add_css_class('oneui-title');
            hb.set_title_widget(tl);
        });
        win.add_css_class('oneui');
        win.set_search_enabled(false);
        win.set_default_size(420, 860);

        // settings handlers and timeouts that must not outlive the window (they touch its rows)
        const settingIds = [], timeouts = new Set();
        const follow = (key, fn) => { if (has(key)) settingIds.push(s.connect(`changed::${key}`, fn)); };
        win.connect('close-request', () => {
            for (const id of settingIds.splice(0)) s.disconnect(id);
            for (const id of timeouts) GLib.source_remove(id); timeouts.clear();
            return false;
        });
        // a focused text field would raise the on-screen keyboard over the page
        win.connect('map', () => {
            for (const ms of [0, 250, 600]) {
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { timeouts.delete(id); if (win.get_focus() instanceof Gtk.Text) win.set_focus(null); return GLib.SOURCE_REMOVE; });
                timeouts.add(id);
            }
        });

        // ---- building blocks -------------------------------------------------------------------------
        const newPage = (hero, lead) => {
            const p = new Adw.PreferencesPage(); p.add_css_class('oneui-page');
            if (hero) { const h = new Adw.PreferencesGroup({title: hero, description: lead ?? null}); h.add_css_class('oneui-hero'); p.add(h); }
            return p;
        };
        const group = (p, title, desc) => { const g = new Adw.PreferencesGroup({title: title ?? '', description: desc ?? null}); p.add(g); return g; };
        /** A sub-page with the One UI header: back arrow and a big title. */
        const subpage = (title, build) => {
            const p = newPage(null);
            build(p);
            const tv = new Adw.ToolbarView();
            // One UI: the title sits left, right after the back arrow
            const hb = new Adw.HeaderBar({centering_policy: Adw.CenteringPolicy.LOOSE});
            const tl = new Gtk.Label({label: title, halign: Gtk.Align.START, hexpand: true, ellipsize: 3});
            tl.add_css_class('oneui-title');
            hb.set_title_widget(tl);
            tv.add_top_bar(hb); tv.set_content(p);
            win.push_subpage(new Adw.NavigationPage({title, child: tv}));
        };
        const sw = (g, key, title, sub) => {
            if (!has(key)) return;
            const r = new Adw.SwitchRow({title, subtitle: sub ?? null});
            s.bind(key, r, 'active', Gio.SettingsBindFlags.DEFAULT); g.add(r);
        };
        /**
         * A choice: the current value in blue under the title; a tap opens a page of big radio rows.
         * `pairs` = [[value, label]], get/set read and write the setting.
         */
        const choiceRow = (g, key, title, pairs, get, set) => {
            if (!has(key)) return;
            const r = new Adw.ActionRow({title, activatable: true}); r.add_css_class('oneui-value');
            const label = () => pairs.find(p => p[0] === get())?.[1] ?? String(get());
            const sync = () => { r.subtitle = label(); };
            sync(); follow(key, sync);
            r.connect('activated', () => subpage(title, p => {
                const cg = group(p);
                let first = null;
                for (const [v, l] of pairs) {
                    const row = new Adw.ActionRow({title: l, activatable: true});
                    const radio = new Gtk.CheckButton({active: v === get(), valign: Gtk.Align.CENTER, can_focus: false});
                    if (first) radio.set_group(first); else first = radio;
                    row.add_prefix(radio); row.set_activatable_widget(radio);
                    radio.connect('toggled', () => { if (radio.active && get() !== v) { set(v); GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => { win.pop_subpage(); return GLib.SOURCE_REMOVE; }); } });
                    cg.add(row);
                }
            }));
            g.add(r);
        };
        const choice = (g, key, title, pairs) => choiceRow(g, key, title, pairs, () => s.get_string(key), v => s.set_string(key, v));
        const choiceInt = (g, key, title, pairs) => choiceRow(g, key, title, pairs, () => s.get_int(key), v => s.set_int(key, v));
        /** A slider under its title, the value at the right of the title. */
        const slider = (g, key, title, lo, hi, step = 0.05, fmt = v => `${Math.round(v * 100)} %`) => {
            if (!has(key)) return;
            const row = new Adw.PreferencesRow({activatable: false}); row.add_css_class('oneui-slider');
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, margin_top: 10, margin_start: 14, margin_end: 14});
            const head = new Gtk.Box({spacing: 8});
            const t = new Gtk.Label({label: title, xalign: 0, hexpand: true}); t.add_css_class('title');
            const v = new Gtk.Label({xalign: 1}); v.add_css_class('subtitle'); v.add_css_class('dim-label');
            head.append(t); head.append(v); box.append(head);
            const adj = new Gtk.Adjustment({lower: lo, upper: hi, step_increment: step});
            const sc = new Gtk.Scale({orientation: Gtk.Orientation.HORIZONTAL, adjustment: adj, draw_value: false, hexpand: true});
            s.bind(key, adj, 'value', Gio.SettingsBindFlags.DEFAULT);
            const upd = () => { v.label = fmt(adj.value); }; adj.connect('value-changed', upd); upd();
            box.append(sc); row.set_child(box); g.add(row);
        };
        const action = (g, title, sub, icon, cb) => {
            const r = new Adw.ActionRow({title, subtitle: sub ?? null, activatable: true});
            if (icon) r.add_suffix(new Gtk.Image({icon_name: icon}));
            r.connect('activated', cb); g.add(r); return r;
        };
        /** A start-page category: coloured round icon, title, "a • b" subtitle; tap = its sub-page. */
        const category = (g, title, items, icon, colour, build) => {
            const r = new Adw.ActionRow({title, subtitle: items.join('  •  '), activatable: true});
            const ic = new Gtk.Image({icon_name: icon, pixel_size: 19, valign: Gtk.Align.CENTER});
            ic.add_css_class('oneui-cat-icon');
            const p = new Gtk.CssProvider(); p.load_from_string(`image { background-color: ${colour}; }`);
            ic.get_style_context().add_provider(p, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
            r.add_prefix(ic);
            r.connect('activated', () => subpage(title, build));
            g.add(r);
        };

        // ---- the sub-pages -------------------------------------------------------------------------
        const homeScreen = p => {
            let g = group(p, 'Icons');
            slider(g, 'desktop-icon-scale', 'Icon size', 0.5, 2); slider(g, 'desktop-label-scale', 'Label size', 0.5, 2);
            sw(g, 'desktop-hide-app-labels', 'Hide app labels'); sw(g, 'desktop-multiline-label', 'Multi-line labels');
            g = group(p, 'Grid');
            choiceInt(g, 'desktop-grid-rows', 'Rows', range(3, 8)); choiceInt(g, 'desktop-grid-columns', 'Columns', range(3, 8));
            g = group(p, 'Behaviour');
            sw(g, 'desktop-lock', 'Lock home screen', 'Icons cannot be moved or removed');
            sw(g, 'desktop-cycle-scrolling', 'Cycle scrolling', 'Swipe past the last page to the first');
            sw(g, 'desktop-icon-add-installed', 'Add new apps to the home screen'); sw(g, 'desktop-allow-empty-pages', 'Allow empty pages');
            g = group(p, 'Folders');
            choiceInt(g, 'desktop-folder-columns', 'Columns', range(2, 5)); choiceInt(g, 'desktop-folder-rows', 'Rows', range(2, 5));
        };
        const dock = p => {
            const g = group(p);
            sw(g, 'dock-enabled', 'Dock'); choiceInt(g, 'dock-num-icons', 'Icons', range(2, 16));
            sw(g, 'dock-custom-background', 'Custom background'); slider(g, 'dock-bottom-padding', 'Bottom padding', 0.1, 1.6);
        };
        const drawer = p => {
            let g = group(p, 'Layout');
            choiceInt(g, 'drawer-layout', 'Layout', [[0, 'Vertical'], [1, 'Horizontal'], [2, 'Vertical categories'], [3, 'Horizontal tabs']]);
            choiceInt(g, 'drawer-grid-columns', 'Columns', range(2, 8));
            choiceInt(g, 'drawer-sort-mode', 'Sort', [[0, 'A → Z'], [1, 'Z → A'], [2, 'Most used'], [4, 'Last installed']]);   // 3 "by colour" is not implemented
            sw(g, 'drawer-app-suggestions', 'App suggestions');
            g = group(p, 'Icons');
            slider(g, 'drawer-icon-scale', 'Icon size', 0.5, 2); slider(g, 'drawer-label-scale', 'Label size', 0.3, 1.8);
            sw(g, 'drawer-hide-labels', 'Hide labels'); sw(g, 'drawer-multiline-label', 'Multi-line labels');
            g = group(p, 'Behaviour');
            sw(g, 'drawer-save-scroll-position', 'Remember position'); sw(g, 'drawer-hide-scrollbar', 'Hide scrollbar');
            if (has('drawer-hidden-apps')) {
                g = group(p, 'Hidden apps');
                const count = () => s.get_strv('drawer-hidden-apps').length;
                const r = action(g, 'Hide apps', '', 'go-next-symbolic', () => subpage('Hide apps', hp => {
                    const hg = group(hp, null, 'Hidden apps leave the drawer; search still finds them when "Search hidden apps" is on');
                    const apps = Gio.AppInfo.get_all().filter(a => a.should_show()).sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
                    for (const a of apps) {
                        const sr = new Adw.SwitchRow({title: a.get_display_name(), active: s.get_strv('drawer-hidden-apps').includes(a.get_id())});
                        sr.connect('notify::active', () => {
                            const set = new Set(s.get_strv('drawer-hidden-apps'));
                            if (sr.active) set.add(a.get_id()); else set.delete(a.get_id());
                            s.set_strv('drawer-hidden-apps', [...set]);
                        });
                        hg.add(sr);
                    }
                }));
                r.add_css_class('oneui-value');
                const sync = () => { r.subtitle = `${count()} hidden`; }; sync(); follow('drawer-hidden-apps', sync);
            }
            g = group(p, 'Background');
            sw(g, 'drawer-custom-background', 'Custom background'); slider(g, 'drawer-background-opacity', 'Opacity', 0, 1);
        };
        const search = p => {
            const g = group(p);
            sw(g, 'search-drawer-enabled', 'Search bar in the drawer'); sw(g, 'search-fuzzy', 'Fuzzy search');
            sw(g, 'search-hidden-apps', 'Search hidden apps'); sw(g, 'search-global', 'Search the web');
            if (has('search-provider')) {
                const g2 = group(p, 'Search engine');
                choice(g2, 'search-provider', 'Search engine', [...ENGINES.map(e => [e[0], e[1]])]);
                const prov = new Adw.EntryRow({title: 'Custom search URL (%s = query)'});
                s.bind('search-provider', prov, 'text', Gio.SettingsBindFlags.DEFAULT);
                g2.add(prov);
            }
        };
        const gestures = p => {
            let g = group(p, 'Navigation');
            sw(g, 'gesture-back-edges', 'Back from the screen edges', 'Drag in from the left or right edge, as on Android');
            sw(g, 'keyboard-on-tap-only', 'Keyboard only after a tap', 'Apps that focus a text field while opening no longer raise the keyboard');
            choiceInt(g, 'power-hold-ms', 'Power menu after holding', [300, 500, 800, 1000, 1500, 2000, 3000, 5000].map(v => [v, `${v / 1000} s`]));
            g = group(p, 'Home screen gestures');
            for (const [k, t] of [['gesture-swipe-up', 'Swipe up'], ['gesture-swipe-down', 'Swipe down'], ['gesture-double-tap', 'Double tap'], ['gesture-long-press', 'Touch and hold'], ['gesture-dock-swipe-up', 'Swipe up on the dock'], ['gesture-pinch-in', 'Pinch in'], ['gesture-pinch-out', 'Pinch out']]) choice(g, k, t, GESTURES);
            if (has('dash-items')) {
                g = group(p, 'Dash', 'The sheet that double tap opens');
                choiceInt(g, 'dash-line-size', 'Items per line', range(4, 6));
                for (const [id, title, kind] of DASH) {
                    const r = new Adw.SwitchRow({title, subtitle: kind, active: s.get_strv('dash-items').includes(id)});
                    r.connect('notify::active', () => { const cur = s.get_strv('dash-items').filter(x => x !== id); s.set_strv('dash-items', r.active ? [...cur, id] : cur); });
                    g.add(r);
                }
            }
        };
        const theme = p => {
            let g = group(p, 'Theme');
            choice(g, 'theme-mode', 'Theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark'], ['black', 'Black']]);
            choice(g, 'shade-style', 'Notifications shade', [['miui', 'MIUI'], ['default', 'Default']]);
            g = group(p, 'Icons', 'Packs are folders under ~/.local/share/neolauncher/iconpacks');
            choice(g, 'icon-pack', 'Icon pack', [['', 'None (icon theme)'], ...listPacks().map(x => [x.id, x.title])]);
            choice(g, 'icon-shape', 'Icon shape', SHAPES);
            sw(g, 'icon-legacy-treatment', 'Shape legacy icons', 'A tinted shaped background behind icons the pack does not cover');
            sw(g, 'icon-pack-wrap', 'Wrap unthemed icons', 'The pack\'s own back, mask and overlay around icons it has no art for');
            g = group(p, 'Notifications');
            sw(g, 'notification-dots', 'Notification dots'); sw(g, 'notification-count', 'Notification count');
        };
        const backups = p => {
            let g = group(p, 'Backups', 'Settings and the home screen layout as a JSON file');
            action(g, 'Create backup', 'Save a .neobackup.json file', 'document-save-symbolic', () => {
                const d = new Gtk.FileDialog({initial_name: `neolauncher-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M')}.neobackup.json`});
                d.save(win, null, (dlg, res) => {
                    try {
                        const f = dlg.save_finish(res); if (!f) return;
                        const data = {}; for (const k of s.settings_schema.list_keys()) data[k] = s.get_value(k).deep_unpack();
                        f.replace_contents(JSON.stringify({version: 1, uuid: this.metadata.uuid, settings: data}, null, 1), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    } catch (e) { if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) logError(e); }
                });
            });
            action(g, 'Restore backup', 'Replaces the current settings and layout', 'document-revert-symbolic', () => {
                const d = new Gtk.FileDialog();
                d.open(win, null, (dlg, res) => {
                    try {
                        const f = dlg.open_finish(res); if (!f) return;
                        const [, bytes] = f.load_contents(null); const b = JSON.parse(new TextDecoder().decode(bytes));
                        if (!b?.settings) throw new Error('not a Neo Launcher backup');
                        for (const [k, v] of Object.entries(b.settings)) { if (!has(k)) continue; const cur = s.get_value(k); s.set_value(k, new GLib.Variant(cur.get_type_string(), v)); }
                    } catch (e) { if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) logError(e); }
                });
            });
            g = group(p, 'Developer');
            sw(g, 'debug-logging', 'Debug logging');
            // disable + enable through the shell's own extensions interface
            const ext = (method, then) => Gio.DBus.session.call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions', method,
                new GLib.Variant('(s)', [this.metadata.uuid]), null, Gio.DBusCallFlags.NONE, -1, null, (c, res) => { try { c.call_finish(res); then?.(); } catch (e) { logError(e); } });
            action(g, 'Restart the launcher', 'Can help if a setting did not apply', 'view-refresh-symbolic', () => ext('DisableExtension', () => ext('EnableExtension')));
        };

        // ---- the start page ------------------------------------------------------------------------
        const start = newPage(null);
        start.set_title('Settings'); start.set_icon_name('emblem-system-symbolic');
        let g = group(start);
        category(g, 'Home screen', ['Icons', 'Grid', 'Folders'], 'user-home-symbolic', '#3e7bfa', homeScreen);
        category(g, 'Dock', ['Icons', 'Background'], 'view-grid-symbolic', '#22a3a8', dock);
        category(g, 'App drawer', ['Layout', 'Sort', 'Hidden apps'], 'view-app-grid-symbolic', '#4caf50', drawer);
        g = group(start);
        category(g, 'Search', ['Search bar', 'Search engine'], 'edit-find-symbolic', '#ff8f1f', search);
        category(g, 'Gestures', ['Back', 'Swipes', 'Dash'], 'input-touchpad-symbolic', '#7c5cff', gestures);
        g = group(start);
        category(g, 'Theme and icons', ['Theme', 'Icon pack', 'Icon shape', 'Shade'], 'preferences-color-symbolic', '#e2557a', theme);
        category(g, 'Backup and developer', ['Backups', 'Debug logging', 'Restart'], 'document-save-symbolic', '#8e8e93', backups);
        win.add(start);
    }
}
