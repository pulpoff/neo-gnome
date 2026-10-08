// NeoHome: the launcher UI (workspace pages + dock + page indicator + drawer),
// laid out with Launcher3's "Large Phone" 5×5 profile metrics (NEO-SPEC §2).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const here = import.meta.url.replace(/\/[^/]*$/, '');
const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const {LauncherModel} = await import(`${here}/model.js?gen=${gen}`);
const {AppCell, ICON_SIZE} = await import(`${here}/icons.js?gen=${gen}`);
const {Drawer} = await import(`${here}/drawer.js?gen=${gen}`);
const {FolderView} = await import(`${here}/folder.js?gen=${gen}`);
const {showIconPopup, showOptionsPopup} = await import(`${here}/popup.js?gen=${gen}`);
const {Recents} = await import(`${here}/recents.js?gen=${gen}`);
const {DragController, haptic} = await import(`${here}/drag.js?gen=${gen}`);
const {NotificationDots, NotificationSounds} = await import(`${here}/notifications.js?gen=${gen}`);
const {BackGesture} = await import(`${here}/backgesture.js?gen=${gen}`);
const {Dash} = await import(`${here}/dash.js?gen=${gen}`);
const {OskPolicy} = await import(`${here}/oskpolicy.js?gen=${gen}`);
const {PowerTweaks, closePowerDialog} = await import(`${here}/power.js?gen=${gen}`);
const {KeyboardRotation, RotationAnimation} = await import(`${here}/rotation.js?gen=${gen}`);
const {UsbMode} = await import(`${here}/usbmode.js?gen=${gen}`);
const {FullscreenGuard} = await import(`${here}/fullscreen.js?gen=${gen}`);
const {CursorGuard} = await import(`${here}/cursor.js?gen=${gen}`);
const {ControlCenter} = await import(`${here}/controlcenter.js?gen=${gen}`);
const {CallProximity} = await import(`${here}/proximity.js?gen=${gen}`);
const {LockScreen} = await import(`${here}/lockscreen.js?gen=${gen}`);
const {firstDelta, firstBegin} = await import(`${here}/gesture.js?gen=${gen}`);
const {iconActor, initIconPacks} = await import(`${here}/iconpack.js?gen=${gen}`);

// NEO-SPEC §2.2/§2.3 (dp == logical px)
const M = {
    statusBar: 24, workspaceSide: 8, edgeMargin: 10.77, cellPadding: 10.77,
    pageIndicator: 24, hotseatBar: 104, hotseatIconCell: 63, hotseatBottom: 18,   // dock icons near the bottom edge (Neo: 48)
    hotseatIconLift: 7,     // the dock row's offset inside the bar, tuned by eye
    pinchIn: 0.85, pinchOut: 1.15, swipeMin: 60, flickVel: 0.5,
    dotSize: 6, dotGap: 4, cellTextPadX: 8, wallpaperZoom: 1.12,
    pageSnapMs: 750, flingMinVel: 500, significantMove: 0.4, returnThreshold: 0.33, overscrollDamp: 0.07,
};

export const NeoHome = GObject.registerClass({GTypeName: `NeoHome_${gen}`},
class NeoHome extends St.Widget {
    _init(ext, settings, generation) {
        super._init({name: 'neoLauncherHome', style_class: 'neo-home', reactive: true, can_focus: true, layout_manager: new Clutter.BinLayout()});
        this.add_constraint(new Layout.MonitorConstraint({primary: true}));
        // Connected before anything is set up: a throw half-way through still undoes what was built so far
        // (settings handlers, the icon worker, the wallpaper, the stage's back gesture, the services).
        this.connect('destroy', () => this._onDestroy());
        try { this._setup(ext, settings, generation); } catch (e) { this.destroy(); throw e; }
    }

    _setup(ext, settings, generation) {
        this.ext = ext; this.generation = generation;
        // The shell's single-finger overview and workspace swipes: the drawer and recents switch them while the
        // launcher runs; home alone puts back what they were before it took them over (_onDestroy).
        this._shellGestures = [Main.overview._singleFingerOverviewGesture, Main.overview._singleFingerWorkspacesGesture]
            .filter(Boolean).map(g => ({g, enabled: g.enabled}));
        // A fresh Gio.Settings per generation: keys added to the schema since enable()
        // are invisible to the extension's own object until the next login.
        // (A system-wide install ships the schema compiled into /usr/share/glib-2.0/schemas and has no
        // schemas/ directory in the extension: the extension's own object is the right one then.)
        const schemasDir = ext.dir.get_child('schemas');
        if (schemasDir.query_exists(null)) try {
            const src = Gio.SettingsSchemaSource.new_from_directory(schemasDir.get_path(), Gio.SettingsSchemaSource.get_default(), false);
            settings = new Gio.Settings({settings_schema: src.lookup('org.gnome.shell.extensions.neolauncher', true)});
        } catch (e) { console.warn(`[neolauncher] schema reload: ${e.message}`); }
        this.settings = settings;
        this._applyTheme();
        this._themeId = settings.connect('changed::theme-mode', () => this._applyTheme());
        // grid, dock and label prefs apply live (Neo rebuilds the workspace on change); items that no longer fit are moved
        const GRID_KEYS = ['desktop-grid-rows', 'desktop-grid-columns', 'dock-num-icons', 'dock-enabled', 'desktop-icon-scale', 'desktop-label-scale', 'desktop-hide-app-labels', 'desktop-multiline-label', 'desktop-folder-columns', 'desktop-folder-rows', 'dock-custom-background', 'dock-background-color', 'dock-bottom-padding'];
        const DRAWER_KEYS = ['drawer-layout', 'drawer-grid-columns', 'drawer-sort-mode', 'drawer-app-suggestions', 'drawer-icon-scale', 'drawer-label-scale', 'drawer-hide-labels', 'drawer-multiline-label', 'drawer-hidden-apps', 'drawer-hide-scrollbar', 'drawer-custom-background', 'drawer-background-color', 'drawer-background-opacity', 'search-drawer-enabled'];
        this._prefIds = [
            ...GRID_KEYS.map(k => settings.connect(`changed::${k}`, () => { if (!this.model || this._destroyed) return; this.model.applyGrid(); this.rows = this.model.rows; this.cols = this.model.cols; this.rebuild(); this._relayout(); })),
            ...DRAWER_KEYS.map(k => settings.connect(`changed::${k}`, () => { if (!this.model || this._destroyed) return; this.drawer?.refresh?.(); })),
        ];
        // icon pack / shape / treatment: re-render every icon (the renders are cached per setting combination)
        this._iconPacks = initIconPacks(settings);
        this._iconIds = ['icon-pack', 'icon-shape', 'icon-legacy-treatment', 'icon-pack-wrap'].map(k => settings.connect(`changed::${k}`, () => {
            // no rebuild: every cell keeps its icon until the worker delivers the new one (pages + dock + drawer)
            this._iconPacks.reload();
            const cells = [...this._pages.flatMap(p => p.get_children()), ...(this._hotseatRow?.get_children() ?? []), ...(this.drawer?._cells ?? [])];
            for (const c of cells) c.swapIcon?.();
            GLib.idle_add(GLib.PRIORITY_LOW, () => { this._prewarmIcons(); return GLib.SOURCE_REMOVE; });
        }));
        // the shell reads an extension's stylesheet once at enable(); re-read it on every hot reload
        try { const theme = St.ThemeContext.get_for_stage(global.stage).get_theme(); const css = ext.dir.get_child('stylesheet.css'); theme.unload_stylesheet(css); theme.load_stylesheet(css); } catch (e) { console.warn(`[neolauncher] stylesheet reload: ${e.message}`); }
        this.log = m => { if (settings.get_boolean('debug-logging')) console.log(`[neolauncher] ${m}`); };
        this.model = new LauncherModel(settings, this.log);
        this.rows = this.model.rows; this.cols = this.model.cols;
        this.currentPage = settings.get_int('default-page');

        // wallpaper (the overview's own background is behind us; we draw ours so parallax works)
        this._content = new St.Widget({style_class: 'neo-home-content', x_expand: true, y_expand: true, layout_manager: new Clutter.BinLayout()});
        this.add_child(this._content);
        this._bgGroup = new St.Widget({style_class: 'neo-wallpaper', x_expand: true, y_expand: true});
        this._content.add_child(this._bgGroup);
        this._bgManager = new Background.BackgroundManager({container: this._bgGroup, monitorIndex: Main.layoutManager.primaryIndex, controlPosition: false});
        // WallpaperOffsetInterpolator: the wallpaper is wider than the screen and slides with the pages
        this._bgGroup.set_pivot_point(0.5, 0.5); this._bgGroup.set_scale(M.wallpaperZoom, M.wallpaperZoom);

        // vertical structure: status bar inset · workspace (pages) · page dots · hotseat
        this._column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true});
        // _main lays the column out next to the dock when the dock moves to the right edge (phone landscape)
        this._main = new St.BoxLayout({x_expand: true, y_expand: true});
        this._content.add_child(this._main);
        this._main.add_child(this._column);
        this._top = new St.Widget({height: Main.panel?.height || M.statusBar, x_expand: true, y_expand: false});
        this._column.add_child(this._top);
        this._workspace = new St.Widget({style_class: 'neo-workspace', x_expand: true, y_expand: true, reactive: true, clip_to_allocation: true, layout_manager: new Clutter.FixedLayout()});
        this._column.add_child(this._workspace);
        this._dots = new St.BoxLayout({style_class: 'neo-page-dots', height: M.pageIndicator, x_align: Clutter.ActorAlign.CENTER, y_expand: false});
        // The dots sit in a full-width, reactive strip so a swipe up that starts
        // on them (between the pages and the dock) opens the drawer too; on its
        // own the dot row is only as wide as the dots and takes no input.
        this._dotsBar = new St.Widget({style_class: 'neo-page-dots-bar', reactive: true, x_expand: true, y_expand: false, height: M.pageIndicator, layout_manager: new Clutter.BinLayout()});
        this._dotsBar.add_child(this._dots);
        this._column.add_child(this._dotsBar);
        this._hotseat = new St.Widget({style_class: 'neo-hotseat', x_expand: true, height: settings.get_boolean('dock-enabled') ? M.hotseatBar : 0, y_expand: false, layout_manager: new Clutter.BinLayout()});
        this._column.add_child(this._hotseat);

        this._pagesContainer = new St.Widget({layout_manager: new Clutter.FixedLayout(), reactive: true});
        this._workspace.add_child(this._pagesContainer);
        this._pagesContainer.connect('notify::x', () => this._updateParallax());
        this._pages = [];
        // the edge back gesture exists before the first cells: every cell's own gestures must let it win (icons.js)
        this.backGesture = new BackGesture(this);
        this.backGesture.closePowerDialog = closePowerDialog;
        this._applyOrientation(false);
        this._buildPages();
        this._buildHotseat();
        this._buildDots();
        const log = m => this.log?.(m);   // follows the debug-logging setting
        this.oskPolicy = new OskPolicy(settings, log);
        this.callProximity = new CallProximity(log);
        try { this.lockScreen = new LockScreen(this); } catch (e) { console.warn(`[neolauncher] lock screen: ${e.message}`); }
        try { this.power = new PowerTweaks(settings, log); } catch (e) { console.warn(`[neolauncher] power tweaks: ${e.message}`); }
        // keep auto-rotation working with a (Bluetooth) keyboard attached, where mutter stops managing it
        try { this.keyboardRotation = new KeyboardRotation(log); } catch (e) { console.warn(`[neolauncher] keyboard rotation: ${e.message}`); }
        // Android-style turn of the UI when the screen rotates
        try { this.rotationAnim = new RotationAnimation(log); } catch (e) { console.warn(`[neolauncher] rotation animation: ${e.message}`); }
        // the status bar hides for real fullscreen windows only
        try { this.fullscreenGuard = new FullscreenGuard(log); } catch (e) { console.warn(`[neolauncher] fullscreen guard: ${e.message}`); }
        // no mouse arrow on a touch phone unless a mouse is really used
        try { this.cursorGuard = new CursorGuard(log); } catch (e) { console.warn(`[neolauncher] cursor guard: ${e.message}`); }
        // "Use USB for" when a computer is connected
        try { this.usbMode = new UsbMode(log); } catch (e) { console.warn(`[neolauncher] usb mode: ${e.message}`); }
        // the pull-down: a MIUI-style Control Center in the shell's quick settings menu
        // MIUI-style Control Center or GNOME's own quick settings, as the Theme setting says; switched live
        this._applyShade();
        this._shadeId = settings.connect('changed::shade-style', () => { if (!this._destroyed) this._applyShade(); });
        this._bringForwardOpenedApps();
        this._setupGestures();
        // The mobile shell's bottom bar (the home handle) reserves 18 px as a strut. That reservation stays: the
        // on-screen keyboard sits above the bar and the work area is cut by the keyboard alone, so with the strut
        // off (2026-10-06 to 10-08) every app ran 18 px under the keyboard's top edge (half-covered text fields
        // in Telegram, Chats, Yesman). Only the bar's look changes: see-through on the home (just the handle line,
        // Android's gesture bar), the window colour under Yesman, the shell's own opaque bar under other apps.
        this._barTracker = Shell.WindowTracker.get_default();
        this._barIface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._updateBar = () => {
            const bar = Main.layoutManager.bottomPanelBox; if (!bar) return;
            const win = global.display.focus_window;
            const app = win ? this._barTracker.get_window_app(win)?.get_id() : null;
            const home = Main.overview.visible || !win;
            bar.remove_style_class_name('neo-clear-bottom-bar');
            bar.set_style(null);
            if (home) bar.add_style_class_name('neo-clear-bottom-bar');
            else if (app === 'de.yesman.app.desktop') {
                const dark = this._barIface.get_string('color-scheme') === 'prefer-dark';
                bar.set_style(`background-color: ${dark ? '#16202F' : '#F7F5F0'}; box-shadow: none;`);   // Yesman's y_surface
            }
        };
        this._barIds = [
            [Main.overview, Main.overview.connect('showing', this._updateBar)],
            [Main.overview, Main.overview.connect('hidden', this._updateBar)],
            [global.display, global.display.connect('notify::focus-window', this._updateBar)],
            [this._barIface, this._barIface.connect('changed::color-scheme', this._updateBar)],
        ];
        this._updateBar();

        this.drawer = new Drawer(this);
        this._content.add_child(this.drawer);

        // Android's bottom nav zone (the 48 dp under the hotseat): swipe up = recent tasks
        this._navZone = new St.Widget({style_class: 'neo-nav-zone', reactive: true, height: M.hotseatBottom, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.END});
        this.add_child(this._navZone);
        this.recents = new Recents(this);
        this.dash = new Dash(this);
        this.add_child(this.dash);
        this._prewarmIcons();
        this.add_child(this.recents);
        this._setupNavZone();
        this.drag = new DragController(this);
        this.dots = new NotificationDots(() => this.updateDots());
        try { this.notificationSounds = new NotificationSounds(); } catch (e) { console.warn(`[neolauncher] notification sounds: ${e.message}`); }
        this.updateDots();
        this._dropBar = new St.BoxLayout({style_class: 'neo-drop-bar', x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.START, x_align: Clutter.ActorAlign.CENTER, visible: false, opacity: 0});
        this._dropBar.add_child(new St.Icon({icon_name: 'user-trash-symbolic', icon_size: 20, y_align: Clutter.ActorAlign.CENTER}));
        this._dropBar.add_child(new St.Label({text: 'Remove', y_align: Clutter.ActorAlign.CENTER}));
        this._content.add_child(this._dropBar);
        this._dropHighlight = new St.Widget({style_class: 'neo-drop-highlight', visible: false});
        this._workspace.add_child(this._dropHighlight);

        this._unsub = this.model.onChange(what => { if (what === 'layout' || what === 'apps' || what === 'orientation') this.rebuild(); });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => { if (!this._applyOrientation(true)) this._relayout(); });
        this._wsGesture = Main.overview._singleFingerWorkspacesGesture ?? null;
        if (this._wsGesture) this._wsGesture.enabled = false;        // the shell's horizontal app-switch gesture would track our page drag too
        this._workspace.connect('notify::allocation', () => this._relayoutIfNeeded());
    }

    setContentOpacity(o) { this._content.opacity = o; }
    /** Neo themes: light (#FAFAFA drawer), dark (#424242), black (#000), or follow the system colour scheme. */
    _applyTheme() {
        let mode = this.settings.get_string('theme-mode');
        if (mode === 'system' || !mode) { try { mode = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light'; } catch (_) { mode = 'dark'; } }
        for (const m of ['light', 'dark', 'black']) this.remove_style_class_name(`theme-${m}`);
        this.add_style_class_name(`theme-${mode}`);
        this._theme = mode;
        this.drawer?.applyBackground();      // a see-through drawer background is tinted from the theme's colour
    }
    _setupNavZone() {
        const pan = new Clutter.PanGesture();
        let y0 = 0;
        pan.connect('may-recognize', () => !this.drawer.isOpen && !this._editing);
        pan.connect('recognize', g => { y0 = firstBegin(g)[1]; if (!this.recents.homeDragBegin()) y0 = NaN; });
        pan.connect('pan-update', g => { if (Number.isNaN(y0)) return; this.recents.homeDragUpdate(-firstDelta(g)[1]); });
        pan.connect('end', g => { if (Number.isNaN(y0)) return; this.recents.homeDragEnd(-firstDelta(g)[1], -g.get_velocity().get_y()); });
        pan.connect('cancel', () => { if (!Number.isNaN(y0)) this.recents.homeDragEnd(0, 0); });
        this.guardBack(pan); this._navZone.add_action(pan);
    }

    _prewarmIcons() {
        const sizes = new Set([Math.round(ICON_SIZE * this.settings.get_double('desktop-icon-scale')), Math.round(ICON_SIZE * this.settings.get_double('drawer-icon-scale')), 48, 24]);
        this._iconPacks.prewarm([...sizes]);
    }
    /** Also runs for a constructor that threw half-way: any member may be missing. */
    _onDestroy() {
        this._destroyed = true;
        this._iconPacks?.stopPrewarm();
        this.drag?.destroy(); this.drag = null;
        for (const p of [...this._popups ?? []]) p.destroy();
        this._cancelLaunchWatch?.();
        this._customizeDialog?.close(); this._customizeDialog = null;
        if (this._themeId) { this.settings.disconnect(this._themeId); this._themeId = 0; }
        for (const id of this._iconIds ?? []) this.settings.disconnect(id); this._iconIds = [];
        for (const id of this._prefIds ?? []) this.settings.disconnect(id); this._prefIds = [];
        this.dots?.destroy(); this.dots = null;
        this.notificationSounds?.destroy(); this.notificationSounds = null;
        this.backGesture?.destroy(); this.backGesture = null;
        this.oskPolicy?.destroy(); this.oskPolicy = null;
        this.power?.destroy(); this.power = null;
        this.keyboardRotation?.destroy(); this.keyboardRotation = null;
        this.rotationAnim?.destroy(); this.rotationAnim = null;
        if (this._shadeId) { this.settings?.disconnect?.(this._shadeId); this._shadeId = 0; }
        for (const id of this._fwdIds ?? []) global.display.disconnect(id);
        this._fwdIds = null;
        if (this._fwdSeqId) { this._fwdTracker.disconnect(this._fwdSeqId); this._fwdSeqId = 0; }
        if (this._fwdOrig) { Object.assign(Shell.App.prototype, this._fwdOrig); this._fwdOrig = null; }
        for (const src of this._fwdSources ?? []) GLib.source_remove(src);
        this._fwdSources = null;
        this.controlCenter?.destroy(); this.controlCenter = null;
        this.usbMode?.destroy(); this.usbMode = null;
        this.fullscreenGuard?.destroy(); this.fullscreenGuard = null;
        this.cursorGuard?.destroy(); this.cursorGuard = null;
        if (this._drawerTimer) { GLib.source_remove(this._drawerTimer); this._drawerTimer = 0; }
        for (const [obj, id] of this._barIds ?? []) obj.disconnect(id);
        this._barIds = null;
        Main.layoutManager.bottomPanelBox?.remove_style_class_name('neo-clear-bottom-bar');
        Main.layoutManager.bottomPanelBox?.set_style(null);
        this.callProximity?.destroy(); this.callProximity = null;
        this.lockScreen?.destroy(); this.lockScreen = null;
        this._unsub?.(); this._unsub = null; this.model?.destroy();
        if (this._monitorsId) { Main.layoutManager.disconnect(this._monitorsId); this._monitorsId = 0; }
        this._bgManager?.destroy(); this._bgManager = null;
        // the one place the shell's swipes are given back (the drawer and recents only switch them while running)
        for (const {g, enabled} of this._shellGestures ?? []) g.enabled = enabled;
        this._shellGestures = null;
    }

    // ---------------- orientation ----------------
    /**
     * Portrait uses the settings grid. Landscape gets a grid sized from the screen: on a phone the dock moves
     * to the right edge and the workspace keeps at least 8 columns and 3 rows; a tablet keeps the dock
     * at the bottom and fits as many cells of the portrait size as the screen holds (at least 8 columns).
     */
    _orientation() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || mon.width <= mon.height) return {landscape: false, side: false};
        const side = mon.height < 600 && this.settings.get_boolean('dock-enabled');
        const sideW = side ? M.hotseatIconCell + 2 * M.workspaceSide + 8 : 0;
        const dots = 16;
        const W = mon.width - sideW - 2 * (M.workspaceSide + M.cellPadding);
        const H = mon.height - this._top.height - dots - (side ? 0 : (this.settings.get_boolean('dock-enabled') ? M.hotseatBar : 0)) - M.edgeMargin - 2 * M.cellPadding;
        let cols, rows;
        if (mon.height < 600) {        // phone
            cols = Math.max(8, Math.floor(W / 88));
            rows = 3;                  // three rows: full-size icons and labels, the spacing portrait has
        } else {                       // tablet
            cols = Math.max(8, Math.floor(W / 96));
            rows = Math.max(3, Math.floor(H / 110));
        }
        return {landscape: true, side, sideW, dots, dims: {cols, rows}};
    }
    /** Apply the current screen orientation. Returns true when the home screen was rebuilt. */
    _applyOrientation(rebuild) {
        const o = this._orientation();
        const key = o.landscape ? `L${o.side ? 's' : 'b'}${o.dims.cols}x${o.dims.rows}` : 'P';
        if (key === this._orientationKey) return false;
        this._orientationKey = key;
        this._sideDock = o.side; this._sideDockW = o.sideW ?? 0;
        this._dotsBar.height = o.landscape ? o.dots : M.pageIndicator;
        // the dock: a bar under the dots, or a column at the right edge
        this._hotseat.get_parent()?.remove_child(this._hotseat);
        // The column's natural width is all pages side by side (n × W): next to the dock in a horizontal box it
        // must be held at the screen width minus the dock, or it pushes the dock off the screen.
        const mon = Main.layoutManager.primaryMonitor;
        if (this._sideDock) {
            this._main.add_child(this._hotseat);
            this._hotseat.set({width: this._sideDockW, height: -1, x_expand: false, y_expand: true});
            this._column.set({width: mon.width - this._sideDockW, x_expand: false});
        } else {
            this._column.add_child(this._hotseat);
            this._hotseat.set({width: -1, height: this.settings.get_boolean('dock-enabled') ? M.hotseatBar : 0, x_expand: true, y_expand: false});
            this._column.set({width: mon.width, x_expand: false});    // never its natural (all pages) width
        }
        // the grid size first: setOrientation() emits a layout change that rebuilds the pages right away
        if (o.landscape) { this.cols = o.dims.cols; this.rows = o.dims.rows; }
        else { this.cols = this.settings.get_int('desktop-grid-columns'); this.rows = this.settings.get_int('desktop-grid-rows'); }
        const changed = this.model.setOrientation(o.landscape ? 'landscape' : 'portrait', o.dims ?? null);
        this.rows = this.model.rows; this.cols = this.model.cols;
        this.log?.(`orientation ${key} (${this.cols}x${this.rows})`);
        if (!rebuild) return true;
        if (!changed) this.rebuild();          // an orientation change already triggered the rebuild through the model
        this._refreshDrawerLater();
        return true;
    }
    /** The drawer's columns follow the orientation, but rebuilding every app cell costs ~60 ms: done while the
     *  rotation animation waits for its first frame, it was most of the stall. Now it waits until the animation
     *  is over, or happens at once when the drawer is the thing on screen. */
    _refreshDrawerLater() {
        if (this._drawerTimer) GLib.source_remove(this._drawerTimer);
        this._drawerTimer = 0;
        if (this.drawer?.visible && this.drawer.opacity > 0 && this.drawer._progress > 0) { this.drawer.refresh(); return; }
        this._drawerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 700, () => { this._drawerTimer = 0; this.drawer?.refresh?.(); return GLib.SOURCE_REMOVE; });
    }

    /** Drawer columns: the setting in portrait; in landscape as many cells of the portrait width as fit. */
    drawerColumns() {
        const cols = this.settings.get_int('drawer-grid-columns');
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || mon.width <= mon.height) return cols;
        return Math.max(cols, Math.round(cols * (mon.width - (this._sideDock ? this._sideDockW : 0)) / mon.height));
    }

    // ---------------- geometry ----------------
    cellGeometry() {
        // Derived from the monitor, never from the workspace's own allocation: the
        // workspace's natural width is the width of its pages (n × W), so reading it
        // back would double the geometry on every relayout.
        const mon = Main.layoutManager.primaryMonitor;
        const W = mon.width - (this._sideDock ? this._sideDockW : 0);
        const H = mon.height - this._top.height - this._dotsBar.height - (this._sideDock ? 0 : this._hotseat.height);
        const padX = M.workspaceSide + M.cellPadding, padTop = M.edgeMargin + M.cellPadding, padBottom = M.cellPadding;
        return {W, H, padX, padTop, cellW: (W - 2 * padX) / this.cols, cellH: (H - padTop - padBottom) / this.rows};
    }
    _relayoutIfNeeded() {
        if (this._applyOrientation(true)) return;
        const g = this.cellGeometry();
        if (g.W !== this._lastW || g.H !== this._lastH) { this._lastW = g.W; this._lastH = g.H; this._relayout(); }
    }
    _relayout() {
        const g = this.cellGeometry();
        this._column.width = g.W;     // the screen (minus a side dock), never the pages' natural width
        this._pages.forEach((page, i) => {
            page.set_size(g.W, g.H); page.set_position(i * g.W, 0);
            for (const cell of page.get_children()) {
                const it = cell.item;
                cell.set_size(Math.round(g.cellW), Math.round(g.cellH));
                cell.set_position(Math.round(g.padX + it.col * g.cellW), Math.round(g.padTop + it.row * g.cellH));
            }
        });
        this._pagesContainer.set_size(g.W * Math.max(1, this._pages.length), g.H);
        this._pagesContainer.set_position(-this.currentPage * g.W, 0);
        if (this._sideDock) this._hotseatRow?.set_size(this._sideDockW, Main.layoutManager.primaryMonitor.height - this._top.height);
        else this._hotseatRow?.set_size(g.W - 2 * M.workspaceSide, M.hotseatIconCell);
    }

    // ---------------- pages ----------------
    _buildPages() {
        // App cells are kept and moved into the new pages: a rotation re-lays the same apps, and a fresh cell
        // re-creates its icon, label and gestures (~45 ms for a full home, all before the first rotated frame)
        const spare = new Map();
        for (const p of this._pages) {
            for (const c of p.get_children()) if (c.item?.type === 'app') { p.remove_child(c); spare.set(c.item.id, c); }
            p.destroy();
        }
        this._pages = [];
        const showLabel = !this.settings.get_boolean('desktop-hide-app-labels');
        // landscape: one-line labels (cropped with an ellipsis), there is no room for two;
        // smaller icons only when a short screen has to hold four rows or more
        const landscape = this.model.orientation === 'landscape';
        const compact = this._sideDock && this.rows >= 4;
        const opts = {showLabel, iconScale: this.settings.get_double('desktop-icon-scale') * (compact ? 0.84 : 1), labelScale: this.settings.get_double('desktop-label-scale') * (compact ? 0.92 : 1), multiline: landscape ? false : this.settings.get_boolean('desktop-multiline-label'), model: this.model, home: this};
        this.model.layout.pages.forEach((items, pi) => {
            const page = new St.Widget({style_class: 'neo-page', layout_manager: new Clutter.FixedLayout(), reactive: true});
            page.pageIndex = pi;
            for (const it of items) {
                let cell = it.type === 'app' ? spare.get(it.id) : null;
                if (cell && cell.reuse(it, opts)) spare.delete(it.id);
                else {
                    cell = new AppCell(it, opts);
                    cell.connect('long-press', c => this._onCellLongPress(c, 'home'));
                    cell.connect('drag-start', (c, g) => this.drag.begin(c, 'home', g));
                    cell.connect('launched', () => { if (cell.item.type === 'folder') this.openFolder(cell); });
                }
                cell.pageIndex = pi;
                page.add_child(cell);
            }
            this._pagesContainer.add_child(page);
            this._pages.push(page);
        });
        for (const c of spare.values()) c.destroy();
        if (this.currentPage >= this._pages.length) this.currentPage = 0;
        this._relayout();
    }
    _buildHotseat() {
        this._hotseat.destroy_all_children();
        if (this.settings.get_boolean('dock-custom-background')) this._hotseat.add_style_class_name('custom-bg');
        else this._hotseat.remove_style_class_name('custom-bg');
        if (!this.settings.get_boolean('dock-enabled')) return;
        if (this._sideDock) {
            // phone landscape: a column at the right edge, icons centred top to bottom (Launcher3's landscape hotseat)
            this._hotseatRow = new St.BoxLayout({style_class: 'neo-hotseat-row', orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, y_expand: true});
            this._hotseatRow.set_y(this._top.height);
        } else {
            this._hotseatRow = new St.BoxLayout({style_class: 'neo-hotseat-row', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START, x_expand: true});
            // icons bottom-aligned above the swipe-up strip; "Bottom padding" scales the gap under them (never out of the bar)
            const bottom = M.hotseatBottom * this.settings.get_double('dock-bottom-padding');
            this._hotseatRow.set_y(Math.round(Math.min(M.hotseatBar - M.hotseatIconCell, M.hotseatBar - bottom - M.hotseatIconCell + M.hotseatIconLift)));
        }
        const opts = {showLabel: false, iconScale: this.settings.get_double('desktop-icon-scale'), model: this.model, home: this};
        for (const it of this.model.layout.dock.slice(0, this.model.dockSize)) {
            const cell = new AppCell(it, opts); cell.pageIndex = -1;
            cell.connect('long-press', c => this._onCellLongPress(c, 'dock'));
            cell.connect('drag-start', (c, g) => this.drag.begin(c, 'dock', g));
            cell.connect('launched', () => { if (it.type === 'folder') this.openFolder(cell); });
            this._hotseatRow.add_child(cell);
        }
        this._hotseat.add_child(this._hotseatRow);
    }
    _buildDots() {
        this._dots.destroy_all_children();
        this._dotActors = this._pages.map((_, i) => {
            const d = new St.Widget({style_class: 'neo-dot', width: M.dotSize, height: M.dotSize, y_align: Clutter.ActorAlign.CENTER, opacity: i === this.currentPage ? 255 : 128});
            d.set_margin_left?.(M.dotGap / 2); d.set_margin_right?.(M.dotGap / 2);
            this._dots.add_child(d); return d;
        });
    }
    /** Android's notification shade: the shell's date menu with only its notification list — the calendar,
     *  events, world clocks and weather column is hidden while it is opened from here. */
    openNotifications() {
        const dm = Main.panel.statusArea?.dateMenu; if (!dm?.menu) return;
        if (dm.menu.isOpen) { dm.menu.close(); return; }
        const find = (a, pred) => { for (const c of a.get_children()) { if (pred(c)) return c; const r = find(c, pred); if (r) return r; } return null; };
        const col = find(dm.menu.box, c => c.has_style_class_name?.('datemenu-calendar-column'));
        const list = find(dm.menu.box, c => c.has_style_class_name?.('message-list'));
        if (col) col.hide();
        let empty = null, oldStyle = null;
        if (list) {
            list.show(); list.x_expand = true;
            oldStyle = list.get_style();
            const mon = Main.layoutManager.primaryMonitor;
            list.set_style(`min-width: ${mon.width - 64}px; min-height: 96px;`);
            const view = list._messageView;
            const hasMessages = view && view.get_children().some(c => c.visible);
            if (!hasMessages) {
                empty = new St.Label({text: 'No notifications', style_class: 'neo-notif-empty', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});
                list.add_child(empty);
            }
        }
        const id = dm.menu.connect('open-state-changed', (_m, open) => {
            if (open) return;
            dm.menu.disconnect(id); col?.show(); empty?.destroy();
            if (list) list.set_style(oldStyle);
        });
        dm.menu.open();
    }
    rebuild() { this._buildPages(); this._buildHotseat(); this._buildDots(); this._relayout(); this.updateDots(); }   // a rebuilt hotseat row needs its width again, or the dock icons pack together at the row's natural size
    updateDots() {
        if (!this.dots || !this.settings.get_boolean('notification-dots')) return;
        const showCount = this.settings.get_boolean('notification-count');
        const cells = [...this._pages.flatMap(p => p.get_children()), ...(this._hotseatRow?.get_children() ?? []), ...(this.drawer?._cells ?? [])];
        for (const c of cells) if (c.setBadge) c.setBadge(this.dots.countFor(c.item), showCount);
    }

    _updateParallax() {
        const n = Math.max(1, this._pages.length - 1); const g = this.cellGeometry();
        const f = Math.max(-0.2, Math.min(1.2, -this._pagesContainer.x / (n * g.W)));      // 0 … 1 across the pages
        const travel = g.W * (M.wallpaperZoom - 1);
        this._bgGroup.translation_x = Math.round(travel / 2 - f * travel);
    }
    // ---------------- paging (PagedView) ----------------
    snapToPage(i, duration = M.pageSnapMs, mode = Clutter.AnimationMode.EASE_OUT_QUINT) {
        const g = this.cellGeometry();
        const n = this._pages.length;
        if (this.settings.get_boolean('desktop-cycle-scrolling')) i = ((i % n) + n) % n; else i = Math.max(0, Math.min(n - 1, i));
        this.currentPage = i;
        this._pagesContainer.ease({x: -i * g.W, duration, mode});
        this._dotActors?.forEach((d, k) => { const o = k === i ? 255 : 128; if (d.opacity !== o) d.ease({opacity: o, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD}); });   // PageIndicatorDots: a plain fade (an overshooting ease blinked)
    }
    /**
     * The home is the overview, and anything that opens an app without going through the home (GNOME's quick
     * settings, a notification, another app, a terminal) left the app open and focused under it, so it seemed
     * dead. Each case is brought forward once, with no rules on focus or stacking, so nothing can loop:
     *  - a new window that has the focus once it shows, i.e. one the user started (an app restoring itself in
     *    the background gets no focus and stays put);
     *  - an app that is already running and is activated through Shell.App (GNOME's own launchers do that and
     *    then hide the overview themselves; the mobile shell left that out);
     *  - a running window that asks for attention right after a launch: GNOME denied it the focus, and showed
     *    "… is ready" instead. Attention on its own (a chat's new-message hint) does not take the screen.
     */
    _bringForwardOpenedApps() {
        this._fwdIds = [
            global.display.connect('window-created', (d, w) => this._forwardWhenShown(w)),
            global.display.connect('window-demands-attention', (d, w) => {
                if (GLib.get_monotonic_time() - (this._lastLaunch ?? 0) < 10 * 1e6) this._forwardSoon(w, false);
            }),
        ];
        this._fwdTracker = Shell.WindowTracker.get_default();
        this._fwdSeqId = this._fwdTracker.connect('startup-sequence-changed', () => { this._lastLaunch = GLib.get_monotonic_time(); });
        const proto = Shell.App.prototype, self = this;
        this._fwdOrig = {activate: proto.activate, activate_full: proto.activate_full};
        for (const name of ['activate', 'activate_full']) {
            const orig = proto[name];
            proto[name] = function (...args) {
                const running = this.state === Shell.AppState.RUNNING;
                self._lastLaunch = GLib.get_monotonic_time();
                const r = orig.apply(this, args);
                if (running) self._forwardSoon(this.get_windows()[0], false);
                return r;
            };
        }
    }
    _forwardWhenShown(w) {
        if (!w || w.get_window_type() !== Meta.WindowType.NORMAL || w.is_skip_taskbar() || w.get_transient_for()) return;
        const go = () => this._forwardSoon(w, true);
        if (w.get_compositor_private()?.visible && w.showing_on_its_workspace?.()) { go(); return; }
        const id = w.connect('shown', () => { w.disconnect(id); go(); });
    }
    _forwardSoon(w, needFocus) {
        if (!w) return;
        this._fwdPending ??= new Set();
        if (this._fwdPending.has(w)) return;
        this._fwdPending.add(w);
        const src = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._fwdSources?.delete(src);
            this._fwdPending.delete(w);
            if (!Main.overview.visible || Main.sessionMode.isLocked || this.lockScreen?.visible) return GLib.SOURCE_REMOVE;
            if (!w.get_workspace() || w.minimized && needFocus) return GLib.SOURCE_REMOVE;
            if (needFocus && global.display.focus_window !== w) return GLib.SOURCE_REMOVE;
            Main.activateWindow(w);
            return GLib.SOURCE_REMOVE;
        });
        (this._fwdSources ??= new Set()).add(src);
    }

    /** The shade: the launcher's Control Center for 'miui', GNOME's quick settings untouched for 'default'. */
    _applyShade() {
        // a settings object made before the key existed (a hot reload) must not be asked for it: that aborts the shell
        const has = !!this.settings?.settings_schema?.has_key?.('shade-style');
        const miui = !(has && this.settings.get_string('shade-style') === 'default');
        if (miui && !this.controlCenter) {
            try { this.controlCenter = new ControlCenter(this); } catch (e) { console.warn(`[neolauncher] control center: ${e.message}\n${e.stack}`); }
        } else if (!miui && this.controlCenter) {
            this.controlCenter.destroy(); this.controlCenter = null;
        }
    }

    _setupGestures() {
        // horizontal pan: page swipe with Launcher3 thresholds; vertical pan up: drawer
        const pan = new Clutter.PanGesture();
        let dir = null, startY = 0;
        pan.connect('may-recognize', () => !this._editing && !this.drawer.isOpen && !this.drag.active);
        pan.connect('recognize', g => { startY = firstBegin(g)[1]; dir = null; this._panContainerX = this._pagesContainer.x; this._pagesContainer.remove_all_transitions(); });
        // The delta of the FIRST contact, not of the centroid: a second contact that flickers in and out (palm,
        // ghost touch) moves the centroid by half its distance on every frame and the pages jittered with it.
        pan.connect('pan-update', g => {
            const [dx, dy] = firstDelta(g);
            if (!dir) {
                if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
                dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : dy < 0 ? 'v' : 'down';
                // swipe up follows the finger only when it opens the drawer; any other action runs on release ('up')
                if (dir === 'v' && this.settings.get_string('gesture-swipe-up') !== 'open_drawer') dir = 'up';
                if (dir === 'v') this.drawer.beginDrag(startY);
                // swipe down = the shell's own top-edge sheet (quick-settings toggles + notifications), under the finger
                this._qsPull = dir === 'down' && this.settings.get_string('gesture-swipe-down') === 'open_notifications' ? Main.panel.statusArea?.quickSettings?.menu : null;
                if (this._qsPull?.panelPanBegin) { try { this._qsPull.panelPanBegin(g); } catch (e) { this.log?.(`qs pull: ${e.message}`); this._qsPull = null; } } else this._qsPull = null;
            }
            if (dir === 'down') { if (this._qsPull) try { const [lat] = g.get_delta(); this._qsPull.panelPanUpdate(g, lat.get_x(), lat.get_y(), 0); } catch (_) {} return; }
            if (dir === 'v') { this.drawer.updateDrag(startY + dy); return; }
            if (dir === 'up') return;
            const geom = this.cellGeometry(); const n = this._pages.length;
            let target = this._panContainerX + dx;
            const min = -(n - 1) * geom.W, max = 0;
            if (target > max) target = max + M.overscrollDamp * (target - max);          // OverScroll damping
            if (target < min) target = min + M.overscrollDamp * (target - min);
            this._pagesContainer.x = target;
        });
        pan.connect('end', g => {
            const [dx, dy] = firstDelta(g);
            const vel = g.get_velocity();                      // px per ms
            if (dir === 'down') {
                if (this._qsPull) { try { this._qsPull.panelPanEnd(g); } catch (_) {} this._qsPull = null; }
                else if (dy > M.swipeMin || vel.get_y() > M.flickVel) this.runGesture(this.settings.get_string('gesture-swipe-down'));
                dir = null; return;
            }
            if (dir === 'up') { dir = null; if (-dy > M.swipeMin || -vel.get_y() > M.flickVel) this.runGesture(this.settings.get_string('gesture-swipe-up')); return; }
            if (dir === 'v') { this.drawer.endDrag(startY + dy, vel.get_y() * 1000); return; }
            const geom = this.cellGeometry(); const frac = Math.abs(dx) / geom.W; const vx = vel.get_x() * 1000;
            let next = this.currentPage;
            if (Math.abs(vx) >= M.flingMinVel) next += vx < 0 ? 1 : -1;
            else if (frac > M.significantMove) next += dx < 0 ? 1 : -1;
            const dist = geom.W / 2 + (geom.W / 2) * Math.sin((Math.min(1, frac) - 0.5) * 0.3 * Math.PI / 2);
            const dur = Math.abs(vx) >= M.flingMinVel ? Math.max(120, Math.min(750, 4 * Math.round(1000 * dist / Math.max(1500, Math.abs(vx))))) : M.pageSnapMs;
            this.snapToPage(next, dur);
        });
        pan.connect('cancel', g => { if (this._qsPull) { try { this._qsPull.panelPanCancel(g); } catch (_) {} this._qsPull = null; } if (dir === 'v') this.drawer.endDrag(startY, 0); else if (dir === 'h') this.snapToPage(this.currentPage, 300); dir = null; });
        this.guardBack(pan); this._workspace.add_action(pan);

        // long press on empty workspace (OptionsPopupView); double tap (gesture pref)
        const lp = new Clutter.LongPressGesture({long_press_duration_ms: 400});
        lp.connect('recognize', g => { const c = g.get_point_coords_abs(0); const [ax, ay] = this.get_transformed_position(); this.runGesture(this.settings.get_string('gesture-long-press'), {x: c.x - ax, y: c.y - ay}); });
        this._workspace.add_action(lp);
        const click = new Clutter.ClickGesture();
        let lastTap = 0;
        click.connect('recognize', () => { const now = GLib.get_monotonic_time(); if (now - lastTap < 300000) { lastTap = 0; this.runGesture(this.settings.get_string('gesture-double-tap')); } else lastTap = now; });
        this._workspace.add_action(click);
        // Pinch (PinchGestureController): two fingers, fires once when the span shrinks to 85 % (in) or grows to 115 % (out).
        const pts = new Map(); let span0 = 0, fired = false;
        this._workspace.connect('captured-event', (a, ev) => {
            const t = ev.type();
            if (t !== Clutter.EventType.TOUCH_BEGIN && t !== Clutter.EventType.TOUCH_UPDATE && t !== Clutter.EventType.TOUCH_END && t !== Clutter.EventType.TOUCH_CANCEL) return Clutter.EVENT_PROPAGATE;
            const seq = ev.get_event_sequence(); const [x, y] = ev.get_coords();
            if (t === Clutter.EventType.TOUCH_END || t === Clutter.EventType.TOUCH_CANCEL) { pts.delete(seq); if (pts.size < 2) { span0 = 0; fired = false; } return Clutter.EVENT_PROPAGATE; }
            pts.set(seq, [x, y]);
            if (pts.size !== 2) return Clutter.EVENT_PROPAGATE;
            const [p, q] = [...pts.values()]; const span = Math.hypot(p[0] - q[0], p[1] - q[1]);
            if (!span0) { span0 = span; return Clutter.EVENT_PROPAGATE; }
            if (fired || this.drawer.isOpen || this.drag.active) return Clutter.EVENT_PROPAGATE;
            const r = span / span0;
            if (r <= M.pinchIn) { fired = true; haptic('button-pressed'); this.runGesture(this.settings.get_string('gesture-pinch-in')); }
            else if (r >= M.pinchOut) { fired = true; haptic('button-pressed'); this.runGesture(this.settings.get_string('gesture-pinch-out')); }
            return Clutter.EVENT_PROPAGATE;
        });

        // swipe up on the dock
        const dockPan = new Clutter.PanGesture();
        let dockY0 = 0;
        dockPan.connect('recognize', g => { dockY0 = firstBegin(g)[1]; this.drawer.beginDrag(dockY0); });
        dockPan.connect('pan-update', g => { this.drawer.updateDrag(dockY0 + firstDelta(g)[1]); });
        dockPan.connect('end', g => {
            const dy = firstDelta(g)[1], action = this.settings.get_string('gesture-dock-swipe-up');
            // the drawer is already following the finger: let it finish (or fall back) like the swipe above the dock
            if (action === 'open_drawer' || -dy <= 40) { this.drawer.endDrag(dockY0 + dy, g.get_velocity().get_y() * 1000); return; }
            this.drawer.endDrag(dockY0, 0); this.runGesture(action);
        });
        dockPan.connect('cancel', () => this.drawer.endDrag(dockY0, 0));
        this.guardBack(dockPan); this._hotseat.add_action(dockPan);

        // swipe up on the page-dots strip: the drawer, following the finger
        const dotsPan = new Clutter.PanGesture();
        let dotsY0 = 0, dotsOn = false;
        dotsPan.connect('may-recognize', () => !this._editing && !this.drawer.isOpen && !this.drag.active);
        dotsPan.connect('recognize', g => { dotsY0 = firstBegin(g)[1]; dotsOn = false; });
        dotsPan.connect('pan-update', g => {
            const dy = firstDelta(g)[1];
            if (!dotsOn) { if (dy > -8) return; dotsOn = true; this.drawer.beginDrag(dotsY0); }
            this.drawer.updateDrag(dotsY0 + dy);
        });
        dotsPan.connect('end', g => { if (!dotsOn) return; this.drawer.endDrag(dotsY0 + firstDelta(g)[1], g.get_velocity().get_y() * 1000); dotsOn = false; });
        dotsPan.connect('cancel', () => { if (dotsOn) this.drawer.endDrag(dotsY0, 0); dotsOn = false; });
        this.guardBack(dotsPan); this._dotsBar.add_action(dotsPan);
    }

    /** A pan that would otherwise win the race against the edge back-gesture must not cancel it. */
    guardBack(gesture) { for (const g of this.backGestures) gesture.can_not_cancel(g); }
    /** The edge back gestures (backgesture.js); app cells read them through opts.home. */
    get backGestures() { return this.backGesture?.gestures ?? []; }
    /** The Extensions prefs dialog for this extension, raised if it is already open. */
    openPreferences() {
        const w = global.display.get_tab_list(0, null).find(x => /Extensions|Neo Launcher|neolauncher/i.test(`${x.get_wm_class()} ${x.get_title()}`));
        if (w) { Main.activateWindow(w); Main.overview.hide(); return; }
        const p = Main.extensionManager.openExtensionPrefs(this.ext.uuid, '', {});
        if (p?.catch) p.catch(e => { if (!/Already showing/.test(e.message)) logError(e, '[neolauncher] prefs'); });
        Main.overview.hide();
    }
    runGesture(action, ctx = {}) {
        switch (action) {
        case 'open_drawer': this.drawer.open(); break;
        case 'global_search': this.drawer.open({focusSearch: true}); break;
        // the same sheet the top-edge swipe opens: quick-settings toggles and the notifications under them
        case 'open_notifications': { const m = Main.panel.statusArea?.quickSettings?.menu; if (m) { if (m.box) m.box.translation_y = 0; m.isOpen ? m.close() : m.open(true); } break; }
        case 'open_dash': if (this.dash.isOpen) this.dash.close(); else this.dash.open(); break;
        case 'quick_settings': { const m = Main.panel.statusArea?.quickSettings?.menu; if (m) m.toggle(); break; }
        case 'edit_mode': this.setEditMode(!this._editing); break;
        case 'options_popup': this._onEmptyLongPress(ctx.x ?? 180, ctx.y ?? 400); break;
        case 'lock': Main.screenShield?.lock?.(true); break;
        default: break;
        }
    }

    // ---------------- folders / popups / edit ----------------
    /** The open folder is kept as home.folderView so the back gesture can close it. */
    openFolder(cell) {
        const fv = new FolderView(this, cell); this.folderView = fv;
        fv.connect('destroy', () => { if (this.folderView === fv) this.folderView = null; });
        this._content.add_child(fv); fv.open();
    }
    _onCellLongPress(cell, source = 'home', extra = {}) {
        if (this.drag.active) return;
        const popup = showIconPopup(this, cell);
        this.drag.arm(cell, source, popup, extra);
        if (!cell._disarmId) cell._disarmId = cell.connect('released', () => this.drag.disarm(cell));
    }
    _onEmptyLongPress(x, y) { if (this.drag.active) return; showOptionsPopup(this, x + this.get_transformed_position()[0], y + this.get_transformed_position()[1]); }
    /** CustomizeSheet (Neo): rename the icon's label; an empty name restores the app's own. */
    customizeApp(cell) {
        const item = cell.item; const app = cell.app;
        const dialog = new ModalDialog.ModalDialog({styleClass: 'neo-customize'});
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 12px; min-width: 280px;'});
        content.add_child(new St.Label({text: 'Customize', style_class: 'neo-customize-title'}));
        const row = new St.BoxLayout({style: 'spacing: 12px;'});
        row.add_child(iconActor(app, 48));
        const entry = new St.Entry({text: item.label ?? app?.get_name() ?? '', hint_text: app?.get_name() ?? 'Name', x_expand: true, can_focus: true});
        row.add_child(entry); content.add_child(row);
        dialog.contentLayout.add_child(content);
        const done = () => {
            const name = entry.get_text().trim();
            if (name && name !== app?.get_name()) item.label = name; else delete item.label;
            this.model.save(); dialog.close();
        };
        dialog.addButton({label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape});
        dialog.addButton({label: 'Done', default: true, action: done});
        entry.clutter_text.connect('activate', done);
        // tracked so a disable while it is open closes it (and drops its modal grab)
        this._customizeDialog?.close(); this._customizeDialog = dialog;
        dialog.connect('destroy', () => { if (this._customizeDialog === dialog) this._customizeDialog = null; });
        dialog.open(); entry.grab_key_focus(); entry.clutter_text.set_selection(0, -1);   // typing replaces the name, like the sheet's TextField
    }
    // ---------------- drag feedback (Workspace spring-loaded state, DropTargetBar) ----------------
    setSpringLoaded(on) {
        if (this._springLoaded === on) return; this._springLoaded = on;
        const scale = on ? 0.86 : 1;
        this._column.set_pivot_point(0.5, 0.55);
        this._column.ease({scale_x: scale, scale_y: scale, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        for (const p of this._pages) { if (on) p.add_style_class_name('spring-loaded'); else p.remove_style_class_name('spring-loaded'); }
    }
    showDropTargetBar(on) {
        if (on) { this._dropBar.visible = true; this._dropBar.translation_y = -M.statusBar; this._dropBar.ease({opacity: 255, translation_y: 0, duration: 150}); }
        else this._dropBar.ease({opacity: 0, translation_y: -M.statusBar, duration: 150, onComplete: () => { this._dropBar.visible = false; }});
        this._dropBar.remove_style_class_name('active');
    }
    showDropHighlight(target, accept = false) {
        const h = this._dropHighlight;
        if (target.kind === 'remove') this._dropBar.add_style_class_name('active'); else this._dropBar.remove_style_class_name('active');
        for (const p of this._pages) for (const c of p.get_children()) if (c._iconBin) c._iconBin.ease({scale_x: 1, scale_y: 1, duration: 100});
        if (target.kind !== 'cell') { h.visible = false; return; }
        const g = this.cellGeometry();
        if (target.occupant) {
            h.visible = false;
            if (target.folder) {   // folder-accept ring: the target icon's background scales ×1.2 (100 ms)
                const page = this._pages[target.page]; const c = page?.get_children().find(x => x.item === target.occupant);
                c?._iconBin.ease({scale_x: accept ? 1.2 : 1.1, scale_y: accept ? 1.2 : 1.1, duration: accept ? 100 : 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
            return;
        }
        h.visible = true;
        h.set_size(Math.round(g.cellW), Math.round(g.cellH));
        h.set_position(Math.round(g.padX + target.col * g.cellW), Math.round(g.padTop + target.row * g.cellH));
    }
    turnPageForDrag(dir) {
        const n = this._pages.length; let next = this.currentPage + dir;
        if (next >= n) { if (!this.model.layout.pages[n - 1]?.length || n >= 20) return; this.model.layout.pages.push([]); this._buildPages(); this._buildDots(); next = this._pages.length - 1; for (const p of this._pages) p.add_style_class_name('spring-loaded'); }
        if (next < 0) return;
        this.snapToPage(next, 300);
    }
    setEditMode(on) {
        this._editing = on;
        const scale = on ? 0.86 : 1;                   // spring-loaded scale (page backgrounds shown)
        for (const p of this._pages) { p.set_pivot_point(0.5, 0.5); p.ease({scale_x: scale, scale_y: scale, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD}); if (on) p.add_style_class_name('spring-loaded'); else p.remove_style_class_name('spring-loaded'); }
        this._hotseat.set_pivot_point(0.5, 1); this._hotseat.ease({scale_x: scale, scale_y: scale, duration: 150});
    }
});
