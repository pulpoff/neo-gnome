# gnome-shell-mobile 48 on the phone — launcher-replacement research

Date: 2026-10-05. Phone: `pulp@192.168.10.98` (poco, sm7150, Nura edge =
postmarketOS edge, aarch64). Nothing on the phone's UI/session was touched:
only file reads, `apk info`, `gresource extract`, `strings`, `readelf`,
`gdbus` property reads and `gsettings get` as the session user.

Companion files:

* `/home/pulp/shell-js/org/gnome/shell/**` — the shell's JS, extracted from
  the phone (152 modules, 5.5 MB). `ui/`, `misc/`, `gdm/`, `extensions/`.
* `/home/pulp/shell-js/theme/gnome-shell-{light,dark,high-contrast}.css` —
  the compiled theme from `gnome-shell-theme.gresource`.
* `/home/pulp/shell-js/ext-src/` — the `org.gnome.Shell.Extensions` prefs
  service sources (+ the `.gresource` itself, used by `check.sh`).
* `/home/pulp/neo-shell/upstream/gnome-shell-mobile/` — shallow clone of
  verdre's `gnome-48-mobile` branch (commit `cf9bd6b5`, 2024-08-06
  "Bump version to 48.mobile.0").
* `/home/pulp/neo-shell/extension/` — the skeleton (`neolauncher@yesman.de/`),
  `install.sh` (NOT run), `check.sh` (run, all green).

---

## 1. What is installed, and where the shell's JavaScript lives

### Packages

```
gnome-shell-mobile-999948.0-r6        (apk info -L / apk list -I)
gnome-shell-mobile-schemas-999948.0-r6
gnome-mobile-extensions-app-999948.0-r6   (the "Extensions" GTK app)
mutter-mobile-999948.0-r3             provides libmutter-16.so.0, Clutter/Cogl/Meta/Mtk-16 in /usr/lib/mutter-16/
gjs-1.90.0-r0
gnome-shell-extensions-51.0-r0        (stock GNOME 51 extensions; all "OUT OF DATE" on this 48 shell)
libadwaita-1.10.0-r0, Gtk-4.0 + Adw-1 typelibs present (needed by prefs)
```

`apk info -a gnome-shell-mobile` prints a confusing `48.0-r11` header (that is
the `provides: gnome-shell=48.0-r11` alias) but the installed package is
`999948.0-r6` — pmOS's "9999-prefixed fork version" convention. `gnome-shell
--version` → `GNOME Shell 48.0`; `misc/config.js`:
`PACKAGE_VERSION = '48.0'`, `LIBMUTTER_API_VERSION = '16'`.
Repos: `mirror.nura.eco/postmarketos/{extra-repos/systemd/main,main}` plus
Alpine edge main/community/testing.

### Which upstream commit

The extracted JS is byte-identical to upstream `gnome-48-mobile` @ `cf9bd6b5`
for every mobile-relevant file (`overview.js`, `overviewControls.js`,
`appDisplay.js`, `layout.js`, `windowManager.js`, `panel.js`, ...). Diffs
exist only in `main.js` (pmOS patch: `GioUnix.DesktopAppInfo.set_desktop_env`
instead of `Gio.DesktopAppInfo`, for the newer GLib), `keyboard.js` (one
`GLib.SOURCE_CONTINUE`→`SOURCE_REMOVE`), `environment.js`,
`remoteSearch.js`, `windowPreview.js`, `misc/parentalControlsManager.js`.
The upstream repo also has `dbusServices/`, `portalHelper/`,
`extensions/prefs.js` which ship in separate gresources (see below).

### Where the JS is

There is no `gnome-shell.gresource` file. The JS is linked into
`/usr/lib/gnome-shell/libshell-16.so` as an ELF section:

```
$ readelf -S -W /usr/lib/gnome-shell/libshell-16.so | grep gresource
  [15] .gresource.shell_js_resources PROGBITS ... 292920
```

`gresource list libshell-16.so` prints nothing on this box (Alpine's
`gresource` apparently does not walk ELF sections), so dump the section:

```
objcopy --dump-section .gresource.shell_js_resources=shell_js.gresource \
        /usr/lib/gnome-shell/libshell-16.so /dev/null
gresource list shell_js.gresource            # 152 entries under /org/gnome/shell/
gresource extract shell_js.gresource /org/gnome/shell/ui/overview.js
```

`/usr/bin/gnome-shell` itself only references
`resource:///org/gnome/shell/ui/init.js` and `listModes.js`.
Separate gresources in `/usr/share/gnome-shell/`:
`gnome-shell-theme.gresource` (CSS), `gnome-shell-icons.gresource`,
`gnome-shell-osk-layouts.gresource` (3.3 MB, incl. the `*-mobile` layouts),
`gnome-shell-dbus-interfaces.gresource`,
`org.gnome.Shell.Extensions.src.gresource` (the prefs host, contains
`js/extensions/prefs.js`), `org.gnome.Shell.{Notifications,Screencast,
SensorDaemon,ScreenSaver}.src.gresource`, `org.gnome.Extensions.*`.

Session modes: `/usr/share/gnome-shell/modes/` only has `classic.json`
(owned by gnome-shell-extensions-51) and `initial-setup.json`. The phone runs
`/usr/bin/gnome-shell --mode=user` (PID 2467, uid 10000 `user`,
`XDG_CURRENT_DESKTOP=GNOME`, `DESKTOP_SESSION=gnome`); PID 1108 is the
greeter (`--mode=gdm`, uid 111). The built-in `user` mode in
`sessionMode.js` is what matters, and it is patched by the fork:

```js
'user': {
    hasOverview: true, hasWorkspaces: true, hasWindows: true, ...
    panel: { left: ['activities', 'dateMenu'], center: [],
             right: ['screenRecording','screenSharing','dwellClick','a11y','keyboard','quickSettings'] },
    hasBottomPanel: true,          // <-- fork addition; false in restrictive/gdm/unlock-dialog
},
```

### Display facts that decide "phone mode"

`org.gnome.Mutter.DisplayConfig.GetCurrentState`: `DSI-1 1080x2400@120`,
logical monitor scale **3.0** → 360×800 logical px.

```js
// layout.js
_checkIsPhone() {
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    const width = this.primaryMonitor.width / scaleFactor;
    const height = this.primaryMonitor.height / scaleFactor;
    if ((width < 500 && height < 1000) || (height < 500 && width < 1000))
        return true;
    return false;
}
```

so `Main.layoutManager.is_phone === true`, `#uiGroup` carries the CSS class
`mobile` (and `horizontal` in landscape). `is-phone` is a GObject property on
`LayoutManager` (`notify::is-phone`), and there is a `forceInvertIsPhone`
setter for testing. Everything mobile hangs off this one flag.

`org.gnome.mutter dynamic-workspaces` is **true** in the session
(`[org.gnome.mutter:GNOME]` override; note that `gsettings get` without
`XDG_CURRENT_DESKTOP=GNOME` in the env — e.g. plain `sudo asuser gsettings`
— shows `false`, because the GNOME-conditional override is not applied).
That matters because `WorkspaceTracker._redoLayout()` refuses
single-window-workspaces when dynamic workspaces are off.

---

## 2. How the mobile "home" works

### 2.1 The home screen IS the overview, forced open

There is no separate launcher object. On a phone the fork turns on
"single-window workspaces" and keeps the overview (in APP_GRID state) open
whenever there are no windows:

```js
// windowManager.js  WindowManager._init
if (Main.sessionMode.hasWorkspaces) {
    this.workspaceTracker = new WorkspaceTracker();
    Main.layoutManager.bind_property('is-phone',
        this.workspaceTracker, 'single-window-workspaces',
        GObject.BindingFlags.SYNC_CREATE);
}
```

```js
// windowManager.js  WorkspaceTracker (GObject, props 'single-window-workspaces', 'zero-open-windows')
get zeroOpenWindows() {
    if (this._workspaces.length === 1 &&
        !this._workspaces[0]._startupSequenceTimeoutId &&
        !this._workspaces[0]._splashscreenGraceTimeoutId &&
        !this._workspaces[0]._newTilingWorkspaceTimeoutId &&
        !this._workspaceHasOwnWindows(this._workspaces[0]))
        return true;
    return false;
}
// _maybeRemoveWorkspace(): "...in single-workspace mode ... always to the overview."
if (!Main.layoutManager.starting_up && workspace.active)
    Main.overview.show(2);            // 2 === ControlsState.APP_GRID
```

```js
// overview.js  Overview._hideDone()
// disallow hiding and show again, needed for when the screen is turned :/
if (Main.wm.workspaceTracker.zeroOpenWindows) {
    this.show(2)
}
```

```js
// overviewControls.js  ControlsManager.runStartupAnimation()
const initialState = Main.layoutManager.is_phone
    ? ControlsState.APP_GRID : ControlsState.WINDOW_PICKER;
```

Every window gets its own workspace (`_maybeMoveToOwnWorkspace`, windows are
maximized; `_mapWindow`/`_destroyWindow` skip the desktop animations when
`singleWindowWorkspaces`). Launching from the grid goes through the tracker:

```js
// appDisplay.js  AppIcon.activate(button)
if (this.app.state === Shell.AppState.STOPPED || openNewWindow) {
    const workspace = Main.wm.workspaceTracker.maybeCreateWorkspaceForWindow(
        event.get_time(), this.app, this.icon.icon);
    if (workspace) { workspace.activate(event.get_time()); workspaceIndex = workspace.workspace_index; }
    else this.animateLaunch();
}
if (openNewWindow) this.app.open_new_window(workspaceIndex);
else               this.app.activate_full(workspaceIndex, 0);
Main.overview.hide();
```

`maybeCreateWorkspaceForWindow(time, app, existingIcon)` (windowManager.js
:938) creates/reuses an empty workspace, activates it, shows an
`AppStartupAnimation` (icon zooms out of the grid into a full-screen overlay
with its own `#bottomPanelBox` clone) and arms a 5 s "no window appeared"
timeout. **A replacement launcher must call this same method when launching,
otherwise the phone-specific app-opening animation and the workspace
bookkeeping are skipped.**

### 2.2 Actor tree (what you see, bottom to top)

```
global.stage
└─ Main.layoutManager.uiGroup  (UiActor #uiGroup, classes .mobile[.horizontal])
   ├─ global.window_group           hidden while in overview (_updateVisibility: windowsVisible = hasWindows && !_inOverview)
   │   └─ layoutManager._backgroundGroup (Meta.BackgroundGroup, one Background.BackgroundManager per monitor) ← desktop wallpaper
   ├─ overviewGroup  (St.Widget #overviewGroup, BindConstraint to uiGroup, visible only in overview)
   │   └─ Overview._overview : OverviewActor (St.BoxLayout #overview, MonitorConstraint primary)
   │       └─ _controls : ControlsManager (St.Widget .controls-manager[.empty][.search-active], clip_to_allocation)
   │           ├─ wallpaper  (Clutter.Actor + Background.BackgroundManager{controlPosition:false};
   │           │             visible ⇔ workspaceTracker.single-window-workspaces)  ← THE HOME WALLPAPER
   │           ├─ _searchEntryBin (St.Bin > St.Entry .search-entry "Type to search")
   │           ├─ _appDisplay  : AppDisplay (BaseAppView)        ← THE APP GRID
   │           ├─ dash         : Dash.Dash   (visible ⇔ !is_phone  → hidden on phone)
   │           ├─ _searchController : SearchController (#searchController, hidden until search-active)
   │           ├─ _thumbnailsBox    : ThumbnailsBox (hidden on phone: `!Main.layoutManager.is_phone && ...`)
   │           └─ _workspacesDisplay: WorkspacesDisplay (the strip of single-window workspaces = "app switcher")
   ├─ panelBox > Main.panel (St.Widget #panel; top bar)
   ├─ bottomPanelBox (St.Bin #bottomPanelBox > St.Widget #bottomPanelLine)  ← the "gesture bar"
   ├─ keyboardBox > Main.keyboard (OSK)
   ├─ screenShieldGroup, modalDialogGroup, screenshotUIGroup, top_window_group, ...
```

### 2.3 The ControlsManager layout on a phone

`ControlsManagerLayout` (a `const`, **not exported**, reachable only as
`controls.layout_manager`) places the children by `_stateAdjustment.value`
(`OverviewAdjustment`: HIDDEN=0, WINDOW_PICKER=1, APP_GRID=2) and the
`empty` flag:

```js
// overviewControls.js  ControlsManagerLayout._computeWorkspacesBoxForState
if (Main.layoutManager.is_phone) {
    hiddenStateBox  = workArea (+ bottomPanelBox.height)
    appGridStateBox = (0, startY + searchHeight + spacing, width, round(height * SMALL_WORKSPACE_RATIO /*0.25*/))
    HIDDEN → hiddenStateBox; WINDOW_PICKER → hiddenStateBox.interpolate(appGridStateBox, 0.5); APP_GRID → appGridStateBox
}
// _getAppDisplayBoxForState (phone): the grid box is the SAME for all three states,
// i.e. it does not slide, it sits below the (shrunk) workspaces strip:
appGridStateBox.set_origin(0, startY + searchHeight + spacing + workspacesBox.get_height() [* 0.8 if empty] [+ spacing]);
// vfunc_allocate:  if (this.empty) this._workspacesDisplay.allocate(new Clutter.ActorBox());   // zero-size when no windows
//                  ... this._appDisplay.allocate(appDisplayBox); this._searchController.allocate(...);
//                  box.y1 -= startY; this._background.allocate(box);                             // wallpaper fills everything
```

`empty` is maintained by
`ControlsManager._emptyStateMaybeChanged()` ← `notify::zero-open-windows`;
it adds the style class `empty` and sets `layout_manager.empty = true` (the
search entry then moves down by `spacing * 4.5`, the workspaces strip gets a
zero box, the grid gets 80 % of the strip's space back).

Visibility of the grid is recomputed constantly — this is the hook a
replacement has to neutralise:

```js
_updateAppDisplayVisibility(stateTransitionParams = null) {
    ...
    this._appDisplay.visible =
        (Main.layoutManager.is_phone || state > ControlsState.WINDOW_PICKER) &&
        !this._searchController.searchActive;
}
// called from _update() (every notify::value of _stateAdjustment) and from _onSearchChanged() onComplete.
```

### 2.4 AppDisplay / grid specifics (appDisplay.js, 3401 lines)

Classes: `AppGrid` (exported, IconGrid subclass), `BaseAppViewGridLayout`
(const), `BaseAppView` (St.Widget; `_scrollView`, `_grid`, `_pageIndicators`,
`_swipeTracker` for horizontal page swipes, DnD, folders), `PageManager`
(const), `AppDisplay` (exported), `AppSearchProvider`, `AppViewItem`
(St.Button), `FolderGrid`/`FolderView`/`FolderIcon`/`AppFolderDialog`,
`AppIcon`, `DashIcon`, `SystemActionIcon`.

Phone-specific bits:

```js
_createGrid() {
    const appGrid = new AppGrid({allow_incomplete_pages: true});
    const phoneGridModes = [{rows: 4, columns: 4}, {rows: 3, columns: 6}, {rows: 2, columns: 8}];
    if (Main.layoutManager.isPhone) appGrid.setGridModes(phoneGridModes);
    return appGrid;
}
// BaseAppViewGridLayout: _getIndicatorsWidth() → 0 on phone; no prev/next page indicators/arrows on phone
// PageManager: settings key is 'app-picker-layout-mobile' on phone ('app-picker-layout' otherwise)
// AppDisplay: on overview 'hidden' → goToPage(0) only if !isPhone
// AppFolderDialog: this.child.add_style_class_name('mobile') on phone
// iconGrid.js: _updateSquareLayout() on notify::is-phone
// appFavorites.js: favourites hidden from the grid handling differs on phone (see lines 76-93)
```

The persisted grid order lives in `org.gnome.shell app-picker-layout-mobile`
(`aa{sv}`; currently 2 pages on this phone). Theme: `#uiGroup.mobile
.icon-grid {row-spacing: 0; column-spacing: 0}`,
`#uiGroup.mobile #overviewGroup .page-indicators {margin-bottom: 18px}`.

### 2.5 Gestures (the fork's new gesture framework)

mutter-mobile backports the `ClutterGesture` framework (GIR:
`Clutter.Gesture`, `ClickGesture`, `LongPressGesture`, `PanGesture`,
`PressGesture`) and libshell adds `Shell.EdgeDragGesture` (property `side`,
parent `Clutter.Gesture`; C: `EDGE_THRESHOLD 35`, `BEGIN_THRESHOLD 24`,
`DRAG_DISTANCE 80`, `CANCEL_THRESHOLD 100`, `CANCEL_TIMEOUT_MS 300`) and
`Shell.DndStartGesture`. `SwipeTracker` wraps a `_panGesture`.

`Overview.init()` installs on `global.stage`:

* `_threeFingerOverviewGesture` / `_threeFingerWorkspacesGesture`
  (touchpad), `make2d()`-linked;
* `_singleFingerOverviewGesture` (vertical SwipeTracker, `allowScroll:false`)
  gated by `_singleFingerOverviewEdgeDrag = new Shell.EdgeDragGesture({side: St.Side.BOTTOM})`
  — i.e. **swipe up from the bottom edge opens the overview**; the edge drag is
  disabled once `OverviewShownState.SHOWN` and re-enabled on HIDING;
* `_singleFingerWorkspacesGesture` (horizontal, switches workspaces =
  switches between apps), also requiring the edge drag to recognise first
  while hidden;
* both single/three-finger overview gestures are `enabled =
  !Main.wm.workspaceTracker.zeroOpenWindows` — **on the empty home the
  swipe-up gesture is off**;
* `ControlsManager.overviewGestureBegin()` on a phone uses points
  `[HIDDEN, APP_GRID]` (skips WINDOW_PICKER).

Other gesture users: `Panel` has a `Clutter.PanGesture` (pan down the top bar
→ `quickSettings.menu.panelPan*`, full-screen quick settings on phone, see
`quickSettings.js:909`), `Workspace` has a `Clutter.PanGesture`
("swipe-up-to-close" of the window preview, `workspace.js:1229`),
`WindowManager` has a `Shell.EdgeDragGesture({side: TOP})` ("Window
unfullscreen top drag"), the OSK's `EmojiPager` and `BaseAppView` use
`SwipeTracker`.

### 2.6 The bottom "gesture bar"

`Main.layoutManager.bottomPanelBox` (layout.js:277-320): an `St.Bin
#bottomPanelBox` with a child `#bottomPanelLine`, added via
`addChrome(..., {affectsStruts: true, trackFullscreen: true})`, aligned to
the bottom with an `AlignConstraint`, `height = is_phone ? -1 : 0`, opacity
toggled by `hasBottomPanel`, `inhibitShowBottomPanel()/uninhibitShowBottomPanel()/maybeShowBottomPanel()`;
`Main.overview 'showing'` sets its opacity to 0 and `'hidden'` restores it.
CSS: `#bottomPanelBox {background-color: #fafafa; height: 18px}`,
`#bottomPanelLine {width: 100px; height: 3px; border-radius: 9999px}`,
`.dark-mode-enabled` variants, `:overview {background: transparent}`.
Because it is a strut, the work area is 18 px shorter; the overview's HIDDEN
box re-adds `bottomPanelBox.height`. Three *copies* of the bar exist for
animations: in `AppStartupAnimation` (windowManager.js:192), in
`WorkspaceBackground` (workspace.js:1106) and inside the OSK
(`keyboard.js:1818`, shown only when `!Main.overview.visible && hasBottomPanel`).
It is purely visual — the actual gesture is the stage-level
`Shell.EdgeDragGesture`.

### 2.7 Panel, OSK, lock screen

* `panel.js`: standard `Panel` (St.Widget `#panel` in `panelBox`); phone
  differences are CSS (`#uiGroup.mobile #panel ...`) and the pan gesture; the
  status-area implementations are chosen by `is_phone` at lines 920/932.
* `keyboard.js`: `KeyboardManager`; on phone max height is `monitor.height *
  0.55`, fixed 16:9 key aspect, layouts renamed `${group}-mobile`,
  `PHONE`/digits purposes. Independent of the overview except the
  bottom-bar clone above.
* `screenShield.js`/`unlockDialog.js`: live in `screenShieldGroup`, don't
  touch the overview (only import `Overview.ANIMATION_TIME`). The unlock
  dialog has its own swipe-up SwipeTracker and phone layout. The lock screen
  runs in session mode `unlock-dialog` (`hasOverview: false` → `Overview.isDummy`).

### 2.8 Search

`SearchController` (searchController.js) owns the `St.Entry`, toggles
`search-active`; `ControlsManager._onSearchChanged()` fades `_appDisplay` out
and `_searchController` in. `search.js` `SearchResultsView` aggregates
`AppSearchProvider` (from appDisplay.js — it reuses `AppIcon`) and remote
providers from `/usr/share/gnome-shell/search-providers/*.ini`.
`Overview.focusSearch()` and the D-Bus `FocusSearch` show the overview and
grab the entry.

---

## 3. Override map for a launcher extension

Everything below is reachable from an extension as plain JS; nothing needs
unsafe mode. `Main` = `resource:///org/gnome/shell/ui/main.js`.

| What | Handle | Kind of change | Notes |
|---|---|---|---|
| The overview actor | `Main.overview._overview` (OverviewActor) / `.controls` getter → `ControlsManager` | read | exists after `overview.init()` (main.js:292), before `extensionManager.init()` (main.js:345) |
| Stock grid | `controls._appDisplay` (also `controls.appDisplay` getter) | hide | `hide()` is undone by `_updateAppDisplayVisibility()`; override that method on `Object.getPrototypeOf(controls)` with `InjectionManager.overrideMethod` (done in the skeleton) |
| Search entry | `controls._searchEntryBin` / `controls._searchEntry` / `Main.overview.searchEntry` | hide or reuse | the layout still allocates the bin; hiding is safe |
| Workspace strip ("app switcher") | `controls._workspacesDisplay` | keep | on the empty home it already gets a zero box; with windows it occupies the top 25 % |
| Home wallpaper | the first child of `controls` (unnamed `Clutter.Actor` with `controls._bgManager`) | keep / cover | separate from the desktop wallpaper in `layoutManager._backgroundGroup` (hidden in overview) |
| Geometry of all of the above | `controls.layout_manager` (instance of non-exported `ControlsManagerLayout`) → patch `Object.getPrototypeOf(controls.layout_manager).vfunc_allocate` / `_getAppDisplayBoxForState` | monkey-patch via `InjectionManager` (`vfunc_` names are supported) | needed only if the launcher wants to live *inside* the ControlsManager allocation; the skeleton avoids it by adding to `overviewGroup` |
| Where to put our actor | `Main.layoutManager.overviewGroup.add_child(actor)` + `new Layout.MonitorConstraint({primary: true})` | add | painted above `_overview`; `overviewGroup` is reactive and only visible while in overview (`showOverview()/hideOverview()`) |
| Home-state detection | `Main.wm.workspaceTracker.zeroOpenWindows` + `notify::zero-open-windows`; `controls` style class `empty` | read | `Main.wm.workspaceTracker.singleWindowWorkspaces` tells whether phone mode is on |
| Overview show/hide | `Main.overview.show(state)/hide()/toggle()/showApps()`, signals `showing/shown/hiding/hidden` | intercept if needed | `Overview` is a plain class (`Signals.EventEmitter`), `Main.overview.show = ...` monkey-patch works; the forced `show(2)` in `_hideDone()` is what keeps the home up |
| Launching apps | `Main.wm.workspaceTracker.maybeCreateWorkspaceForWindow(time, app, iconActor)` then `app.activate_full(wsIndex, 0)` / `open_new_window`, then `Main.overview.hide()` | call | copy `AppIcon.activate()`; reuse `AppDisplay.AppIcon` itself if the icon widget is acceptable |
| App list | `Shell.AppSystem.get_default().get_installed()`, `lookup_app(id)`, `Shell.WindowTracker`, `ParentalControlsManager.getDefault().shouldShowApp()`, `AppFavorites.getAppFavorites()` | read | same sources the grid uses (`AppDisplay._loadApps`) |
| Persisted layout | `global.settings` key `app-picker-layout-mobile` (`aa{sv}`), `org.gnome.desktop.app-folders` | read/write | or keep the launcher's own schema |
| Gestures | `Main.overview._singleFingerOverviewGesture`, `_singleFingerWorkspacesGesture`, `_singleFingerOverviewEdgeDrag` (`.enabled`) ; own `Clutter.PanGesture`/`SwipeTracker` on our actor | read / add | horizontal stage swipe still switches workspaces while the overview is shown — claim the sequence in our own PanGesture or disable that tracker while the launcher is on screen |
| Bottom bar | `Main.layoutManager.bottomPanelBox`, `inhibitShowBottomPanel()` | read | already hidden in overview; nothing to do for a launcher inside the overview |
| Phone flag | `Main.layoutManager.is_phone`, `notify::is-phone` | read | respect it: on a tablet/desktop the fork falls back to stock behaviour |
| CSS | extension `stylesheet.css` auto-loaded; scope under `#uiGroup.mobile` if desired | add | St CSS subset only |
| Panel | `Main.panel`, `Main.panel.statusArea.quickSettings` | leave | |
| OSK | `Main.keyboard` | leave | |

### Risks / what else depends on the stock grid

1. **Search** — `SearchController` fades `_appDisplay` and `_workspacesDisplay`
   via `ControlsManager._onSearchChanged()`; `AppSearchProvider` lives in
   appDisplay.js but does not need the `AppDisplay` *actor*. If the launcher
   hides the search entry it must provide its own entry, or call
   `Main.overview.focusSearch()` from its own UI. Keyboard typing in the
   overview goes to the entry through `SearchController._onStageKeyPress`.
2. **Folders / DnD** — `AppFolderDialog`, `FolderIcon`, the `item-drag-*`
   signals on `Main.overview` and `DND` all assume the `BaseAppView` tree.
   Hiding the grid is safe; *destroying* it is not (`ctrlAltTabManager`
   groups, `appDisplay.selectApp(id)` from `Overview.selectApp` /
   `Shell.AppSystem` `installed-changed`, `PageManager`). Keep the actor
   alive and hidden.
3. **The forced overview** — `Overview._hideDone()` re-shows the overview
   when `zeroOpenWindows`; `WorkspaceTracker._maybeRemoveWorkspace()` calls
   `Main.overview.show(2)` when the last window of the active workspace
   closes. A launcher *inside* the overview rides on this; a launcher outside
   it (own top-level actor, overview suppressed) must re-implement the modal
   grab (`Main.pushModal(global.stage, {actionMode: Shell.ActionMode.OVERVIEW})`),
   the `window_group` hiding and would fight these two call sites.
4. **ControlsManagerLayout is private** and allocates exactly its known
   children; an extra child added to `controls` would never be allocated.
   Add to `overviewGroup` (skeleton) or patch `vfunc_allocate`.
5. **Monkey-patching prototypes** affects every instance; there is only one
   `ControlsManager`, so this is fine, but `disable()` must restore
   (`InjectionManager.clear()`) and re-run `_updateAppDisplayVisibility()`.
6. **Lock screen** — unaffected (`unlock-dialog` mode has no overview and
   `session-modes: ["user"]` keeps the extension disabled there). The fork's
   lock screen (`unlockDialog.js`) has its own phone layout.
7. **Rotation** — `monitors-changed` recreates `controls._bgManager`;
   `MonitorConstraint` follows automatically. Anything sized manually must
   listen to `Main.layoutManager 'monitors-changed'`.
8. **Extension crash loop** — `org.gnome.Shell@.service` has
   `OnFailure=org.gnome.Shell-disable-extensions.service`, which runs
   `gsettings set org.gnome.shell disable-user-extensions true` when the
   shell flags extensions as the likely culprit (`%t/gnome-shell-disable-extensions`).
   If the launcher throws during `enable()`, the shell logs it and marks the
   extension `ERROR`; a hard crash costs the session.
9. **Startup animation** — `ControlsManager.runStartupAnimation()` animates
   `_searchEntryBin` and `dash`; our actor added at `enable()` time appears
   after that. No conflict, just no entrance animation.
10. **`Main.overview.visible` semantics** — `visible` is true during the
    hide animation; use `visibleTarget`/`closing` or the `hidden` signal.

---

## 4. The extension mechanism on this build

Verified against `ui/extensionSystem.js`, `extensions/extension.js`,
`misc/extensionUtils.js`, the D-Bus introspection of `org.gnome.Shell` and
the on-device CLI.

* **ESM only**: `extension.js` must `export default class ... extends
  Extension` (`resource:///org/gnome/shell/extensions/extension.js`), with
  `enable()`/`disable()`; the shell does
  `extensionModule = await import(extensionJs.get_uri()); new extensionModule.default({...metadata, dir, path})`.
  `InjectionManager` is exported from the same module (`overrideMethod(proto,
  name, orig => fn)`, `restoreMethod`, `clear`; handles `vfunc_*`).
  `Extension.getSettings()` loads `schemas/gschemas.compiled` from the
  extension dir (`Gio.SettingsSchemaSource.new_from_directory(dir/schemas, default, false)`),
  so **compile the schema on install** (`glib-compile-schemas <dir>/schemas`).
  `this.getLogger()` gives a prefixed console; plain `console.log` works too.
* **metadata.json** required keys: `uuid`, `name`, `description`,
  `shell-version` (non-empty string array). Version check:
  `_isOutOfDate()` → `!metadata['shell-version'].some(v => v.startsWith('48'))`
  (major of `Config.PACKAGE_VERSION` `'48.0'`) → use `"shell-version": ["48"]`.
  `org.gnome.shell disable-extension-version-validation` is `false` on the
  phone (so the stock 51.0 extensions in `/usr/share/gnome-shell/extensions`
  are all `OUT OF DATE`). Optional: `session-modes` (default `['user']`),
  `settings-schema`, `gettext-domain`, `version`, `version-name`, `url`.
  D-Bus `org.gnome.Shell.ShellVersion` / `org.gnome.Shell.Extensions.ShellVersion` = `'48.0'`,
  `org.gnome.Shell.Mode` = `'user'`, `UserExtensionsEnabled = true`,
  `allow-extension-installation = true`.
* **Where**: `global.userdatadir` = `~/.local/share/gnome-shell`, so
  `/home/user/.local/share/gnome-shell/extensions/neolauncher@yesman.de/`
  for uid 10000 (`user:user`, `.local/share` is mode 700; the `extensions/`
  dir does not exist yet). Directory name must equal `metadata.uuid`.
  Enabled list: `org.gnome.shell enabled-extensions` (currently `[]`),
  `disabled-extensions` wins over it, `disable-user-extensions = false`.
* **Enable**: `gnome-extensions enable <uuid>` as the session user
  (`sudo asuser 'XDG_CURRENT_DESKTOP=GNOME gnome-extensions enable ...'`;
  the CLI only writes the gsettings key, the running shell reacts via
  `changed::enabled-extensions` → `_onEnabledExtensionsChanged()` →
  `_callExtensionEnable(uuid)`). `gnome-extensions` 48.0 has
  `enable/disable/reset/uninstall/list/info/show/prefs/create/pack/install`.
  D-Bus equivalents: `org.gnome.Shell.Extensions.{EnableExtension,
  DisableExtension, ListExtensions, GetExtensionInfo, GetExtensionErrors,
  OpenExtensionPrefs, LaunchExtensionPrefs, InstallRemoteExtension,
  UninstallExtension, CheckForUpdates}`; `ReloadExtension` exists but
  returns "deprecated and does not work".
* **Reload semantics (important, verified in code)**:
  * `_loadExtensions()` scans the extension dirs **once at startup**
    (`FileUtils.collectFromDatadirs('extensions', includeUserDir)`); there is
    no directory monitor. `_callExtensionEnable()` begins with
    `if (!this.lookup(uuid)) return;` — **a freshly installed extension is
    invisible to the running shell**; the first install needs a logout/login
    (or the e.g.o `InstallRemoteExtension` path, which calls
    `createExtensionObject`+`loadExtension` — not usable for a local dir).
  * Modules are imported once (`extension.isImported`; `unloadExtension()`
    records the version in `_unloadedExtensions`, `_canLoad()` then logs
    "A different version was loaded previously. You need to log out for
    changes to take effect."). **Code changes need a logout** (on Wayland the
    shell cannot restart in place: `Restart=no`, `global.reexec_self()` only
    on the X11 'restart' path). `disable` → `enable` re-runs the old module's
    `disable()`/`enable()` — fine for toggling, useless for new code.
  * Logout without touching the UI: `sudo asuser 'XDG_CURRENT_DESKTOP=GNOME
    gnome-session-quit --logout --no-prompt'` (destroys the session; GDM
    greeter PID 1108 is already running). Not run.
* **Prefs**: `prefs.js` with `export default class extends
  ExtensionPreferences` from
  `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`,
  `fillPreferencesWindow(window)` with libadwaita (Adw 1.10, Gtk 4 typelibs
  present). It runs in a separate gjs process started by the D-Bus service
  `org.gnome.Shell.Extensions` (`/usr/share/gnome-shell/org.gnome.Shell.Extensions`
  → `imports.package.init` → `org.gnome.Shell.Extensions.src.gresource`),
  opened by `gnome-extensions prefs <uuid>` or the Extensions app
  (`gnome-mobile-extensions-app`). `prefs.js` must not import `ui/*`.
* **Unsafe mode / Eval**: `org.gnome.Shell.Eval` is gated by
  `global.context.unsafe_mode` (shellDBus.js:69). There is **no
  `--unsafe-mode` CLI flag** in this build (`gnome-shell --help-all` lists
  `--wayland --nested --no-x11 --headless --virtual-monitor --mode
  --list-modes` only); the flag is the Looking Glass "MetaContext unsafe-mode"
  toggle (`lookingGlass.js:49` → `global.context.unsafe_mode = true`), which
  also posts a "System was put in unsafe mode" notification (main.js:312).
  Not needed for a proper extension; useful later for live debugging only
  if someone is at the device.
* **Errors/notifications**: `Main.notify(title, body)`,
  `Main.notifyError(title, body)` (main.js:659/678); extension errors are
  stored per uuid (`GetExtensionErrors`) and `gnome-extensions info` shows
  the state (`ACTIVE`, `INACTIVE`, `ERROR`, `OUT OF DATE`, `INITIALIZED`).
* **Logs**: the shell's stdout/stderr go to the user journal. From `pulp`:
  `sudo journalctl -f _COMM=gnome-shell -o cat` (both shells) or
  `sudo journalctl _PID=2467 -o cat` (the user session; PID changes per
  login). `journalctl --user` as pulp does not see uid 10000's journal.
  The session shell's log currently holds ~860 lines (power-manager debug
  chatter, `clutter_press_gesture_get_pressed` assertions), no extension
  lines because none are enabled.
* **Crash protection**: see risk 8 above
  (`org.gnome.Shell-disable-extensions.service`).

---

## 5. Prototype (this box only)

```
/home/pulp/neo-shell/extension/
├── neolauncher@yesman.de/
│   ├── metadata.json          uuid neolauncher@yesman.de, shell-version ["48"], session-modes ["user"]
│   ├── extension.js           the skeleton described below
│   ├── prefs.js               Adw preferences (EntryRow + 2 SwitchRows bound to the schema)
│   ├── stylesheet.css         .neolauncher-home / -label / -sublabel
│   └── schemas/org.gnome.shell.extensions.neolauncher.gschema.xml
├── install.sh                 rsync → phone /tmp → sudo rsync --chown=user:user into
│                              /home/user/.local/share/gnome-shell/extensions/<uuid>/,
│                              glib-compile-schemas, gnome-extensions enable as the session user
│                              (--logout flag for the first install / code changes).  NOT RUN.
└── check.sh                   offline checks, all passing
```

`extension.js` behaviour:

1. `enable()`: `controls = Main.overview._overview?.controls`; bail out
   quietly if the session mode has no overview.
2. `InjectionManager.overrideMethod(Object.getPrototypeOf(controls),
   '_updateAppDisplayVisibility', ...)` → after the original runs, force
   `this._appDisplay.visible = false` while the launcher is active.
3. `new NeoHome(settings)` — `St.Widget #neoLauncherHome`, reactive,
   `Layout.MonitorConstraint({primary: true})`, `Clutter.BinLayout`, with an
   `St.Label` (text from the `placeholder-text` key, live-updated), a
   sub-label (`ShellVersion`, `is_phone`, monitor size and scale) and an
   `St.Button` "Show stock app grid" that flips the launcher off without
   disabling the extension (on-device QA escape hatch). Added with
   `Main.layoutManager.overviewGroup.add_child()`.
4. Optional `_searchEntryBin.visible = false` (key `hide-search-entry`).
5. Logs `[neolauncher] ...` lines and the overview `showing/shown/hiding/hidden`
   transitions when `debug-logging` is on.
6. `disable()`: destroy the widget, `InjectionManager.clear()`, re-show the
   search entry, call the restored `_updateAppDisplayVisibility()`.

What `check.sh` verified here (Debian 13, gjs 1.82.3, node 22):

* `metadata.json` parses, `glib-compile-schemas --strict --dry-run` passes;
* `node --check` (as ESM) on `extension.js` and `prefs.js`;
* **`prefs.js` imports for real**: gjs with the phone's
  `org.gnome.Shell.Extensions.src.gresource` registered imports
  `file://.../prefs.js`, resolves `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`
  → `ExtensionPreferences`, instantiates the class;
* every `resource:///org/gnome/shell/...` import in `extension.js` exists in
  the extracted shell JS, and the five private names it touches
  (`_updateAppDisplayVisibility`, `_searchEntryBin`, `overviewGroup`,
  `MonitorConstraint`, `OverviewActor.controls`, `InjectionManager`) exist
  in this exact build.

What **cannot** be checked outside the shell: `gi://St`, `gi://Shell`,
`gi://Clutter`, `gi://Meta` (typelibs live only in `/usr/lib/gnome-shell`
and `/usr/lib/mutter-16` on the phone and need a running compositor),
`resource:///org/gnome/shell/ui/*` (only registered inside the gnome-shell
process), so the actual `enable()` path, actor allocation, CSS and the
prototype override are untested until it runs on the device. Likely first
on-device issues: St CSS properties the theme engine rejects (warnings in
the journal), and `St.Button` with a bare `label` needing the stock
`.button` style for touch size.

### Suggested path from skeleton to Neo-Launcher clone

1. Install (needs one logout), confirm `[neolauncher] enable()` and the
   placeholder in the journal/screenshots; check that the forced-overview
   home still comes back after closing the last app.
2. Replace the placeholder with the launcher UI inside `NeoHome`
   (`St.ScrollView` of pages / dock / search), reusing
   `AppDisplay.AppIcon` or an own `St.Button` per `Shell.App`; launch via
   `maybeCreateWorkspaceForWindow` + `activate_full` + `Main.overview.hide()`.
3. Decide on the workspaces strip: either keep it (patch
   `ControlsManagerLayout.vfunc_allocate` so the launcher sits in the grid's
   box and the strip stays on top) or hide `_workspacesDisplay` on the empty
   home and offer an own "recent apps" view.
4. Own horizontal `Clutter.PanGesture` for page swipes; while the launcher is
   shown, disable `Main.overview._singleFingerWorkspacesGesture` or make our
   gesture `can_not_cancel` it, so page swipes don't switch workspaces.
5. Search: either keep the stock entry (unhide `_searchEntryBin`, position
   ours around it) or drive `Main.overview.searchController` from an own
   entry.
6. Long-press menus (`Clutter.LongPressGesture`), folders, favourites, and
   persistence in the extension schema; wallpaper from
   `org.gnome.desktop.background` via `Background.BackgroundManager` if the
   launcher should not depend on the stock one.
