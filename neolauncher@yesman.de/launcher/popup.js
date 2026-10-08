// Long-press popups (NEO-SPEC §2.6/§3.4): PopupContainerWithArrow look — 216 dp wide,
// 52 dp rows, 16 dp radius, opened 200 ms from the icon with an overshoot, closed in
// 233 ms. Non-modal on purpose: Launcher3 keeps tracking the finger that opened the
// popup, so holding on and moving 16 dp turns into a drag (drag.js owns that).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';

const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const P = {width: 216, rowH: 52, radius: 16, openMs: 200, closeMs: 233, gap: 8};
const WATCH_S = 8, RAISE_MS = 150;   // launchAndLeave: how long to wait for the app's window, and the delay before raising it

export const NeoPopup = GObject.registerClass({GTypeName: `NeoPopup_${gen}`},
class NeoPopup extends St.BoxLayout {
    /** `anchor` = {x, y, w, h} stage rect of the pressed icon; `items` = [{label, icon, run}]. Open popups are kept in
     *  home._popups: one still open (or closing) when the launcher goes away is destroyed with it (home._onDestroy). */
    _init(home, anchor, items) {
        super._init({style_class: 'neo-popup', orientation: Clutter.Orientation.VERTICAL, reactive: true, width: P.width});
        for (const it of items) {
            const b = new St.Button({style_class: 'neo-popup-item', x_expand: true, height: P.rowH, reactive: true, can_focus: true});
            const row = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 14px; padding: 0 16px;'});
            row.add_child(new St.Icon({icon_name: it.icon ?? 'go-next-symbolic', icon_size: 20, y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(new St.Label({text: it.label, y_align: Clutter.ActorAlign.CENTER, x_expand: true}));
            b.set_child(row);
            b.connect('clicked', () => { this.close(); try { it.run(); } catch (e) { logError(e); } });
            this.add_child(b);
        }
        this.opacity = 0; this.scale_x = this.scale_y = 0.5;        // before it is ever painted
        Main.layoutManager.addTopChrome(this);
        (home._popups ??= new Set()).add(this);
        home.log?.(`popup open ${items.length} items at ${Math.round(anchor.x)},${Math.round(anchor.y)}`);
        const mon = Main.layoutManager.primaryMonitor;
        const h = items.length * P.rowH;
        let x = Math.round(anchor.x + anchor.w / 2 - P.width / 2); x = Math.max(mon.x + 8, Math.min(mon.x + mon.width - P.width - 8, x));
        const above = anchor.y - P.gap - h >= mon.y + Main.panel.height + 8;
        const y = above ? Math.round(anchor.y - P.gap - h) : Math.round(anchor.y + anchor.h + P.gap);
        this.set_position(x, y);
        this.set_pivot_point(Math.max(0, Math.min(1, (anchor.x + anchor.w / 2 - x) / P.width)), above ? 1 : 0);
        // ArrowPopup (Android U): container fade 83 ms, reveal/scale 200 ms with a slight overshoot
        this.ease({opacity: 255, duration: 83, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.ease({scale_x: 1, scale_y: 1, duration: P.openMs, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        this._pressId = global.stage.connect('captured-event', (s, ev) => {
            const t = ev.type();
            if (t !== Clutter.EventType.BUTTON_PRESS && t !== Clutter.EventType.TOUCH_BEGIN) return Clutter.EVENT_PROPAGATE;
            const [ex, ey] = ev.get_coords();
            const inside = ex >= this.x && ex <= this.x + this.width && ey >= this.y && ey <= this.y + this.height;
            if (!inside) { this.close(); return Clutter.EVENT_STOP; }      // the tap that dismisses the popup is consumed (Launcher3)
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', () => { if (this._pressId) { global.stage.disconnect(this._pressId); this._pressId = 0; } home._popups?.delete(this); });
    }
    close() {
        if (this._closing) return; this._closing = true;
        if (this._pressId) { global.stage.disconnect(this._pressId); this._pressId = 0; }
        this.ease({opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: P.closeMs, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => this.destroy()});
    }
});

/** Launch something from the home: the home (overview) must get out of the way, like AppCell.activate. */
function launchAndLeave(home, fn, wmClass = null) {
    try { fn(); } catch (e) { logError(e, '[neolauncher] launch'); Main.notify?.('Neo Launcher', e.message); return; }
    Main.overview.hide();
    if (!wmClass) return;
    // One app per workspace on the mobile shell: leaving the overview lands on the previous app's workspace, so the
    // window that opens (or the one already open) is activated explicitly, as Launcher3's startActivity brings it up.
    const existing = global.display.get_tab_list(0, null).find(w => (w.get_wm_class() ?? '').includes(wmClass));
    if (existing) { Main.activateWindow(existing); }
    // The watch is home's (home._cancelLaunchWatch): cleared when the window shows up, after WATCH_S, by a newer
    // launch, or when the launcher goes away — the popup that started it is long gone by then.
    home._cancelLaunchWatch?.();
    let id = 0, timeout = 0, raise = 0;
    const cancel = () => {
        if (id) global.display.disconnect(id); if (timeout) GLib.source_remove(timeout); if (raise) GLib.source_remove(raise);
        id = timeout = raise = 0;
        if (home._cancelLaunchWatch === cancel) home._cancelLaunchWatch = null;
    };
    id = global.display.connect('window-created', (d, w) => {
        if (!(w.get_wm_class() ?? '').includes(wmClass)) return;
        global.display.disconnect(id); id = 0; GLib.source_remove(timeout); timeout = 0;
        raise = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RAISE_MS, () => { raise = 0; cancel(); Main.activateWindow(w); return GLib.SOURCE_REMOVE; });
    });
    timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WATCH_S, () => { timeout = 0; cancel(); return GLib.SOURCE_REMOVE; });
    home._cancelLaunchWatch = cancel;
}

/**
 * Where an app came from, for App info and Uninstall: a Flatpak (its .desktop file is exported by flatpak) or the
 * Alpine package that owns its .desktop file. null when neither can be told.
 */
function appSource(app) {
    const file = app.get_app_info()?.get_filename?.() ?? '';
    const id = app.get_id().replace(/\.desktop$/, '');
    if (file.includes('/flatpak/exports/')) return Promise.resolve({kind: 'flatpak', id, user: file.startsWith(GLib.get_home_dir())});
    if (!file) return Promise.resolve(null);
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(['apk', 'info', '--who-owns', file], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (pr, res) => {
                try {
                    const [, out] = pr.communicate_utf8_finish(res);
                    const m = out?.match(/is owned by (\S+)/);
                    resolve(m ? {kind: 'apk', pkg: m[1].replace(/-[0-9][^-]*-r[0-9]+$/, '')} : null);   // name-1.2.3-r0 -> name
                } catch (_) { resolve(null); }
            });
        } catch (_) { resolve(null); }
    });
}

/** App info: the app's page in GNOME Software, looked up the way it was installed (package or Flatpak). */
async function openInSoftware(home, app) {
    const src = await appSource(app);
    const arg = src?.kind === 'flatpak' ? `--details=${src.id}` : src?.kind === 'apk' ? `--details-pkg=${src.pkg}` : `--details=${app.get_id()}`;
    launchAndLeave(home, () => Gio.Subprocess.new(['gnome-software', arg], Gio.SubprocessFlags.NONE), 'org.gnome.Software');
}

/** Uninstall straight from the menu: confirm, then apk-polkit (asks for the admin password) or flatpak. */
async function uninstallApp(app) {
    const name = app.get_name();
    const src = await appSource(app);
    if (!src) { Main.notify(name, 'Cannot tell how this app was installed'); return; }
    const what = src.kind === 'apk' ? `the package "${src.pkg}"` : `the Flatpak "${src.id}"`;
    const dlg = new ModalDialog.ModalDialog();
    dlg.contentLayout.add_child(new Dialog.MessageDialogContent({title: `Uninstall ${name}?`, description: `This removes ${what} and its data from the phone.`}));
    const done = err => Main.notify(name, err ? `Uninstall failed: ${err.message}` : 'Uninstalled');
    dlg.setButtons([
        {label: 'Cancel', action: () => dlg.close(), key: Clutter.KEY_Escape},
        {label: 'Uninstall', destructive_action: true, action: () => {
            dlg.close();
            if (src.kind === 'apk') {
                Gio.DBus.system.call('dev.Cogitri.apkPolkit2', '/dev/Cogitri/apkPolkit2', 'dev.Cogitri.apkPolkit2', 'DeletePackages',
                    new GLib.Variant('(as)', [[src.pkg]]), null, Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, -1, null,
                    (conn, res) => { try { conn.call_finish(res); done(null); } catch (e) { done(e); } });
            } else {
                const proc = Gio.Subprocess.new(['flatpak', 'uninstall', '-y', src.user ? '--user' : '--system', src.id], Gio.SubprocessFlags.STDERR_PIPE);
                proc.communicate_utf8_async(null, null, (pr, res) => {
                    try { const [, , errOut] = pr.communicate_utf8_finish(res); done(pr.get_successful() ? null : new Error((errOut ?? '').trim().split('\n').pop() || 'flatpak failed')); }
                    catch (e) { done(e); }
                });
            }
        }},
    ]);
    dlg.open();
}

function iconRect(cell) {
    const bin = cell._iconBin ?? cell; const [x, y] = bin.get_transformed_position();
    return {x, y, w: bin.width * (bin.scale_x || 1), h: bin.height * (bin.scale_y || 1)};
}

export function showIconPopup(home, cell) {
    const item = cell.item, app = cell.app, items = [];
    if (app) {
        const info = app.get_app_info();
        if (info?.list_actions) for (const a of info.list_actions()) items.push({label: info.get_action_name(a), icon: 'media-playback-start-symbolic', run: () => { info.launch_action(a, global.create_app_launch_context(global.get_current_time(), -1)); Main.overview.hide(); }});
    }
    if (item.type === 'folder') items.push({label: 'Customize', icon: 'document-edit-symbolic', run: () => home.openFolder(cell)});
    else items.push({label: 'Customize', icon: 'document-edit-symbolic', run: () => home.customizeApp(cell)});
    if (cell.pageIndex >= 0) items.push({label: 'Remove', icon: 'user-trash-symbolic', run: () => home.model.removeItem(cell.pageIndex, item)});
    else if (cell.pageIndex === -1) items.push({label: 'Remove', icon: 'user-trash-symbolic', run: () => home.model.removeFromDock(item)});
    else if (cell.pageIndex === undefined || cell.pageIndex === null) items.push({label: 'Hide', icon: 'view-conceal-symbolic', run: () => { const h = home.model.hidden(); h.add(item.id); home.model.setHidden(h); }});
    if (app) {
        items.push({label: 'App info', icon: 'dialog-information-symbolic', run: () => openInSoftware(home, app)});
        items.push({label: 'Uninstall', icon: 'edit-delete-symbolic', run: () => uninstallApp(app)});
    }
    return new NeoPopup(home, iconRect(cell), items);
}

/** The empty-space popup: Wallpaper & style and Home settings. */
export function showOptionsPopup(home, x, y) {
    return new NeoPopup(home, {x: x - 1, y: y - 1, w: 2, h: 2}, [
        {label: 'Wallpaper & style', icon: 'preferences-desktop-wallpaper-symbolic', run: () => launchAndLeave(home, () => {
            // gnome-control-center refuses to run unless XDG_CURRENT_DESKTOP says GNOME
            const ctx = global.create_app_launch_context(global.get_current_time(), -1);
            ctx.setenv('XDG_CURRENT_DESKTOP', 'GNOME');
            (Gio.DesktopAppInfo.new('gnome-background-panel.desktop') ?? Gio.DesktopAppInfo.new('org.gnome.Settings.desktop')).launch([], ctx);
        }, 'org.gnome.Settings')},
        {label: 'Home settings', icon: 'preferences-system-symbolic', run: () => launchAndLeave(home, () => {
            // a prefs window that is already open just needs to come forward
            const w = global.display.get_tab_list(0, null).find(x => /Extensions|Neo Launcher|neolauncher/i.test(`${x.get_wm_class()} ${x.get_title()}`));
            if (w) { Main.activateWindow(w); return; }
            const p = Main.extensionManager.openExtensionPrefs(home.ext.uuid, '', {});
            if (p?.catch) p.catch(e => { if (!/Already showing/.test(e.message)) logError(e, '[neolauncher] prefs'); });
        })},
    ]);
}
