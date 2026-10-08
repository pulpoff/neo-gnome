# Neo Launcher → GNOME Shell clone: reference spec

Target: 360×800 logical px phone (1080×2400 @ 3×). 1 dp in this document = 1 logical px on the target.

## 0. Sources and how to read this document

| Source | What it is | Used for |
|---|---|---|
| `/usr/src/Neo-Launcher` @ `bc028ddd7` (`git describe`: `0.9.3-2146-gbc028ddd7`, branch `main`) | The **in-progress Android-16 rebase** of Neo Launcher. Package `com.neoapps.neolauncher`, Launcher3 from AOSP 16, all Neo code under `Omega/src/com/neoapps/neolauncher/`. | Feature inventory, settings tree, defaults, layout formulas, animation constants (§1–3, §5). This is the version the clone should follow — it is where development is going. |
| `git archive 0.9.3` of the same repo (extracted to the scratchpad as `neo093/`) | The **last shipped release** (Dec 2023): package `com.saggitt.omega`, Android-13 Launcher3, Neo code under `Omega/src/com/saggitt/omega/`. | Cross-check for everything the screenshots show, because the only installable APK is 0.9.3. |
| `NeoLauncher-release.apk` 0.9.3 (23.3 MB, github release) | Installed on the Galaxy S10e for visual references. | §4 screenshots and px measurements. |

Where 0.9.3 and `main` differ, both are listed and marked **[0.9.3]** / **[main]**. Bare statements apply to both.

Shorthand for interpolators (all from `libs_systemui/animationlib/src/com/android/app/animation/Interpolators.java`):

| Name | Definition |
|---|---|
| `LINEAR` | identity |
| `STANDARD` | cubic-bezier(0.2, 0, 0, 1) — Material 3 "standard" |
| `STANDARD_ACCELERATE` | cubic-bezier(0.3, 0, 1, 1) |
| `STANDARD_DECELERATE` | cubic-bezier(0, 0, 0, 1) |
| `EMPHASIZED` | path: (0,0) C(0.05,0 0.1333,0.06 0.1667,0.4) C(0.2083,0.82 0.25,1 1,1) — "fast_out_extra_slow_in" |
| `EMPHASIZED_ACCELERATE` | cubic-bezier(0.3, 0, 0.8, 0.15) |
| `EMPHASIZED_DECELERATE` | cubic-bezier(0.05, 0.7, 0.1, 1) |
| `FAST_OUT_SLOW_IN` (= `LEGACY`) | cubic-bezier(0.4, 0, 0.2, 1) |
| `LINEAR_OUT_SLOW_IN` (= `LEGACY_DECELERATE`, `DECELERATED_EASE`) | cubic-bezier(0, 0, 0.2, 1) |
| `FAST_OUT_LINEAR_IN` (= `ACCELERATED_EASE`) | cubic-bezier(0.4, 0, 1, 1) |
| `ACCELERATE` / `ACCELERATE_2` | Android `AccelerateInterpolator(1)` = t², `(2)` = t⁴ |
| `DECELERATE` / `DECELERATE_1_5` / `DECELERATE_1_7` / `DECELERATE_2` / `DECELERATE_3` | Android `DecelerateInterpolator(f)` = 1-(1-t)^(2f) |
| `ZOOM_OUT` | custom (used for workspace scale in state transitions) |
| `SCROLL` | 1 - (1-t)⁵ (quintic ease-out, the page-scroll curve) |
| `SCROLL_CUBIC` | 1 - (1-t)³ |
| `OVERSHOOT_1_2 / _1_7` | Android `OvershootInterpolator(tension)` |
| `TOUCH_RESPONSE` | cubic-bezier(0.3, 0, 0.1, 1) |
| `clampToProgress(i, a, b)` | i applied to the sub-range [a,b] of progress, 0 before a, 1 after b |
| `mapToProgress(i, a, b)` | output of i rescaled to [a,b] |
| `FINAL_FRAME` | 0 until t = 1, then 1 (a step) |
| `INSTANT` | always 1 |

Text height everywhere below is Launcher3's `Utilities.calculateTextHeight(px) = ceil(fontMetrics.bottom - fontMetrics.top)`; for Roboto that is ≈ 1.33 × text size (14.4 sp → ≈ 19 dp; 13 sp → ≈ 17 dp). GNOME's default UI font (Cantarell) has different metrics — use the same *formula* with the real metrics, or pin Roboto for a 1:1 match.

---

## 1. Feature inventory

Legend for GNOME feasibility: ✅ implementable with Shell/St/Clutter + GSettings; ⚠️ needs a substitute; ❌ impossible / no equivalent on Linux (plan a substitute).

### 1.1 Home screen (workspace)

| Feature | Detail (file) | GNOME |
|---|---|---|
| Paged workspace, horizontal swipe | `src/.../Workspace.java`, `PagedView.java`. Pages are created on demand when an item is dropped on the "+" page at the end; empty pages removed when the last item leaves unless *Allow Empty Pages* is on (`desktopAllowEmptyScreens`, `desktopEmptyScreenIds` persists their ids **[main]**). | ✅ |
| Grid | rows × columns from prefs (`desktopGridRows/Columns`, see §1.9); default comes from the chosen Launcher3 grid-option (5×5 on this phone class, see §2.1). | ✅ |
| App icons, shortcuts (deep shortcuts pinned), folders, widgets | `ItemInfo` types. Widgets via `AppWidgetHost` (`LauncherAppWidgetHostView`). | icons/shortcuts/folders ✅; **widgets ❌** (no AppWidget on Linux — substitute: GNOME extension "widgets" of our own: clock, weather, calendar card) |
| Smartspace / At-a-glance row at the top of page 0 | `search_container_workspace` = `SmartspaceQsb` hosting either Google's smartspace widget (needs `com.google.android.googlequicksearchbox`) or Neo's own date view (`smartspace_date_view.xml`: `TextClock` 24 sp, 30 dp high) — `smartspaceEnable` default **false [main]** (so the top row is a normal grid row by default). Neo's own providers: date, time (12/24 h), weather (Google / OpenWeatherMap / Pixel Experience), events (battery status, now playing, calendar, alarms, unread notifications). | ⚠️ re-implement as our own row (clock/date/weather via GNOME Weather / Evolution calendar) |
| Auto-add icon for newly installed app | `desktopIconAddInstalled` default true. New icons bounce in (`Launcher.createNewAppBounceAnimation`, stagger `NEW_SHORTCUT_STAGGER_DELAY`). | ✅ (watch `Shell.AppSystem` installed-changed) |
| Hide icon labels / multiline labels / label size | `desktopHideAppLabels` (false), `desktopMultilineLabel` (false → 1 line, true → 2 lines), `desktopLabelScale` 0.5–2.0 ×. | ✅ |
| Icon scale | `desktopIconScale` 0.5–2.0 × of the profile icon size. | ✅ |
| Lock desktop | `desktopLock` false — when on, long-press drag/reorder is disabled. | ✅ |
| Cycle scrolling | `desktopCycleScrolling` false — swiping past the last page wraps to the first. | ✅ |
| Free scrolling (dev) | `desktopFreeScrolling` false — pages scroll continuously without snapping. | ✅ |
| Default home page | `desktopDefaultPage` int 0 (set from the long-press "Set as Home Screen" option when `SET_HOME_POPUP` is enabled). | ✅ |
| Full-width widgets | `desktopAllowFullWidthWidgets` false. | ❌ (widgets) |
| Hide status bar | `desktopHideStatusBar` false, **commented out of the UI [main]**. | ✅ (hide top panel) |
| Allow rotation | `profileAllowRotation` false. | ✅ |
| Wallpaper | Android `WallpaperManager`; parallax: wallpaper width = `wallpaperTravelToScreenWidthRatio` × screen (phones < 720 dp: 2×). Workspace wallpaper offset scrolls with pages (`WallpaperOffsetInterpolator`). Wallpaper colour hints (`WallpaperColorsCompat.supportsDarkTheme`, primary/secondary/tertiary colours) feed the theme. | ✅ wallpaper + parallax (we draw the background ourselves); colours ⚠️ (sample the image) |
| Page indicator | `PageIndicatorDots` (dots) — `dockDotsPageIndicator` true, `dockShowPageIndicator` true (both **removed from the Dock settings UI in main**, dots are the only option in A16). Dots sit in a 24 dp tall strip (`workspace_page_indicator_height`) directly above the hotseat. | ✅ |
| Drop targets while dragging | `DropTargetBar` at the top (56 dp tall): **Remove** (`DeleteDropTarget`) and **Uninstall** (`SecondaryDropTarget`; app info when uninstall is not possible). | ✅ (Remove; Uninstall ⚠️ via PackageKit) |
| Spring-loaded (drag) mode | `SPRING_LOADED` state: workspace shrinks (see §3.5), page backgrounds shown at alpha 0.2, hotseat stays 1×. | ✅ |
| Edit mode | `EDIT_MODE` state **[main]** (Lawnchair-style "Edit Home Screen", triggered from the long-press menu or the *Pinch in* gesture default): workspace + hotseat scaled to spring-loaded scale, page backgrounds visible, 150 ms. | ✅ |
| Long-press empty space | opens `OptionsPopupView` (see §5.3) unless the *Touch and hold* gesture is remapped. | ✅ |
| Double-tap empty space | gesture → default *Open Dash*. | ✅ |
| Desktop icon popup ("Shortcut Bubble") | long-press icon → `PopupContainerWithArrow` with deep shortcuts + system shortcuts; Neo adds **Customize** (`OmegaShortcuts.Customize`, always when `PREFS_DESKTOP_POPUP_EDIT` in `desktopPopup`, default on) and **Uninstall** (`PREFS_DESKTOP_POPUP_UNINSTALL`, default off). | ✅ (deep shortcuts ⚠️ → `.desktop` *Actions*) |
| Notification dots / counts | `NotificationListener` → `DotRenderer`; `notificationDots` (needs listener permission), `notificationCount` false, `notificationCustomColor` false, `notificationBackground` `#FFF32020`, `notificationCountFolder` true (badge count on folder). | ⚠️ (GNOME notification source → per-app count) |
| Onboarding | `DiscoveryBounce` (hotseat bounce hint, 450 ms delay) once (`onboardingBounceSeen`). | ✅ |

### 1.2 Dock (hotseat)

| Feature | Detail | GNOME |
|---|---|---|
| Enable/disable | `dockEnabled` true (label "Dock Enabled"). Off → hotseat bar size 0 and workspace grows. | ✅ |
| Icon count | `dockNumIcons` IdpIntPref 2–16 (13 steps), default = grid-option `numHotseatIcons` (5 for 5×5). `dockNumRows` 2–3 default 2 exists **[main]** but hotseat rows are forced to 1 (`DeviceProfileOverrides`: `numHotseatRows = 1 // TODO`). | ✅ |
| Background | `dockCustomBackground` false; `dockBackgroundColor` default `custom|#ff101010`; corner radius = `profileWindowCornerRadius` (24 dp default) or 16 dp (`enforced_rounded_corner_max_radius`) when that pref is "Auto" (-1). Drawn as a rounded rect extending below the screen (only the top corners are visible) with a 4 dp blur shadow (`all_apps_scrim_blur`). `CustomHotseat.kt`. | ✅ |
| Bottom padding | `dockBottomPadding` 0.1–1.6 × (default 1.0) multiplies `hotseatBarBottomSpacePx`. | ✅ |
| Dock scale / icon scale / expandable dock | `dockScale` 0.7–1.75, `dockIconScale` 0.5–2, `dockExpandable` — prefs exist **[main]** but are **commented out of the Dock page**; expandable dock has no implementation in `main`. **[0.9.3]** had `dockScale` + `dockOpacity` (0.9) in the UI. | — |
| Dock search bar | `searchDockEnabled` false **[main]** — pref only, no UI, no QSB layout (`search_container_hotseat.xml` is a 0 dp `View`). **[0.9.3]** `dockSearchBar` false with a real Pixel-style QSB (`searchBarRadius` -1=auto…24 dp, mic button `showMic`, `openAssistant`). | ✅ either way; follow `main` (no dock QSB) |
| Swipe up on dock | gesture `gestureDockSwipeUp` → default *Launch Global Search* **[main]** / *Open app drawer* **[0.9.3]**. The dock region is `y ≥ dragLayer.height - (hotseatBarSizePx + insets.bottom)`. | ✅ |
| Dock icons | same `BubbleTextView` as workspace but `DISPLAY_WORKSPACE` with labels hidden (Hotseat cell height = icon only). Folders allowed in the dock. | ✅ |

### 1.3 App drawer (All Apps)

| Feature | Detail | GNOME |
|---|---|---|
| Layouts (`drawerLayout`, default `LAYOUT_VERTICAL`=0) **[main]** | 0 **Vertical** (alphabetical `AllAppsRecyclerView` grid with fast-scroller + A–Z letter rail), 1 **Horizontal** (`HorizontalAppsView`: `AllAppsPagedView` pages of cols×rows + a dot indicator: 8 dp dots, 4 dp margin, 40 dp pagination strip, active alpha 255 / inactive 100, 8 dp top padding), 2 **Vertical Categories** (`CategorizedAppsView`: a vertical Compose `categories_bar` rail on the left with "All apps" + enabled Flowerpot categories, list on the right), 3 **Horizontal Tabs** (`AllAppsTabs`: pill tabs in the header, one `AllAppsPagedView` page per tab). | ✅ |
| Layouts **[0.9.3]** | `drawerLayoutNew`: 0 Vertical, 1 Paged (strings also list "Vertical List"). | — |
| Columns | `drawerGridColumns` 2–16, default = grid `numAllAppsColumns` (= 5 for the 5×5 option). | ✅ |
| Sort (`drawerSortMode`, default A→Z) | A→Z, Z→A, Most Used (`AppUsageComparator` on Neo's `AppTracker` launch counts), By Color (`AppColorComparator`, icon dominant hue), Last Installed (`InstallTimeComparator`) **[main]**; 0.9.3 lacks "Last Installed". | ✅ |
| App suggestions row | `drawerAppSuggestions` false — top "prediction row" (`PredictionRowView`) of most-used apps. | ✅ |
| Icon / label prefs | `drawerIconScale` 0.5–2, `drawerHideLabels` false, `drawerMultilineLabel` false (→ Launcher3 two-line toggle), `drawerLabelScale` 0.3–1.8, `drawerCellHeightMultiplier` 0.5–2 (pref, hidden from UI in main). | ✅ |
| Hidden apps | `drawerHiddenAppSet` (set of `ComponentKey` strings), picker page `HiddenAppsPage` (title shows "N selected"). Hidden apps are filtered from the drawer, searchable only if `searchHiddenApps`. | ✅ |
| Protected apps | `drawerEnableProtectedApps` (TwoStatePref: toggle + "Tap to open protected Apps"), `drawerProtectedAppsSet`; opening a protected app prompts `BiometricPrompt` (strong biometric or device credential); turning the feature off also requires auth. Needs a secure keyguard, else a toast. | ⚠️ (polkit / password prompt) |
| Folders in drawer | `drawerFolderManager` (TwoStatePref over `DRAWER_ENABLE_FOLDERS`, default true) → `DrawerFolderPage` to create/edit folders (`DrawerFolders`, `DrawerFolderInfo`). Folders appear only on the first tab (`allowFolders = index == 0`). | ✅ |
| Tabs / categories | `drawerTabManager` → `AppCategoriesPage`: create custom tabs (title, colour, app set, "hide from all apps"), profile tabs (personal/work), Flowerpot auto-categories (Play-Store categories matched by package list, `flowerpot/playstore/*`: ANDROID_WEAR, ART_AND_DESIGN, AUTO_AND_VEHICLES, BEAUTY, BOOKS_AND_REFERENCE, BUSINESS, COMICS, COMMUNICATION, DATING, EDUCATION, ENTERTAINMENT, EVENTS, FAMILY, FINANCE, FOOD_AND_DRINK, GAME, HEALTH_AND_FITNESS, HOUSE_AND_HOME, LIBRARIES_AND_DEMO, LIFESTYLE, MAPS_AND_NAVIGATION, MEDICAL, MUSIC_AND_AUDIO, NEWS_AND_MAGAZINES, PARENTING, PERSONALIZATION, PHOTOGRAPHY, PRODUCTIVITY, SHOPPING, SOCIAL, SPORTS, TOOLS, TRAVEL_AND_LOCAL). `categoriesLayout` = set of enabled categories (default: all that match ≥1 installed app). | ✅ (map to `.desktop` `Categories=`) |
| Work apps tab | `drawerSeparateWorkApps` false. | ❌ (no work profiles) — drop |
| Scroll state / scrollbar | `drawerSaveScrollPosition` false ("Remember Position"), `drawerHideScrollbar` false. | ✅ |
| Background | `drawerCustomBackground` false, `drawerBackgroundColor` `custom|#ff101010`, `drawerBackgroundOpacity` 0–1 (1.0). Scrim colour = custom colour or theme `allAppsScrimColor` (light `grey_50 #fafafa`, dark `grey_800 #424242`, black `#000000`) × opacity (`OmegaUtils.getAllAppsScrimColor`). | ✅ |
| Drawer icon popup | `drawerPopup`: Customize (default on), Uninstall (off). | ✅ |
| Search bar | see §1.5. `searchDrawerEnabled` true. | ✅ |
| Keyboard | search field is a Compose `TextField`; it is **not** auto-focused on open — tapping it focuses and shows the IME; the "×" clears + hides the keyboard; `imeAction = Search`. (Compare 0.9.3: `AppsSearchContainerLayout` EditText, same behaviour.) | ✅ |

### 1.4 Folders

| Feature | Detail | GNOME |
|---|---|---|
| Create | drag an icon onto another icon on the workspace/dock (`FolderIcon` accept animation: preview background scales ×1.2 over 100 ms, `PreviewBackground.ACCEPT_SCALE_FACTOR`). | ✅ |
| Preview | `ClippedFolderIconLayoutRule`: up to 4 items (2×2); item scale 0.44 (MIN) … 0.51 (MAX) of the folder icon; radius dilation 0.25; preview background = icon shape (`desktopFolderIconShape`, default "system"), colour `folderPreviewColor`/custom (`desktopCustomFolderBackground` + `desktopFolderBackgroundColor` default system accent), opacity `desktopFolderOpacity` 0–1 (1.0), optional stroke (`desktopFolderStroke`, `desktopFolderStrokeColor` — prefs present, not in the UI). | ✅ |
| Open folder | `Folder` + `FolderPagedView`; grid `desktopFolderColumns/Rows` 2–5 (default 3×3 **[main]**; grid-option default for 5×5 is 4×4 but Neo overrides with its own pref default 3), paged when more items than fit; footer with editable name (`FolderNameEditText`, hint "Unnamed Folder", `TextHeadline` style) + page dots. Content corner radius `folder_content_corner_radius` 12 dp [Omega dimen]; `desktopFolderCornerRadius` -1(auto)…24 dp. Background colour `folderBackgroundColor` light `#EFEDED` / dark `#1F2020` / black `#000`. | ✅ |
| Full screen folder | `desktopFolderFullScreen` false (commented out of the UI; `FolderRootView`). | — |
| Cover mode | `CustomizeFolderSheet` (bottom sheet from the folder's popup → Customize): rename, change icon, **Cover mode** switch — tapping the folder icon launches the first app instead of opening; swipe up on it opens the folder (`folderInfo.isCoverMode`). | ✅ |
| Close | tap outside, back, or drag an item out and hold 400 ms (`ON_EXIT_CLOSE_DELAY`). Reorder delay inside 250 ms, scroll-hint 500 ms. | ✅ |
| Badge | folder shows summed notification count when `notificationCountFolder`. | ⚠️ |

### 1.5 Search

| Feature | Detail | GNOME |
|---|---|---|
| Drawer search field | `ComposeSearchLayout` (`Omega/res/layout/search_container_all_apps_compose.xml`): full-width, 12 dp horizontal margin, 2 dp padding, background `bg_all_apps_searchbox` = pill (radius 200 dp), fill `popupColorPrimary` (light `#FFF`, dark `#3C4043`), 0.5 dp stroke `allappsHeaderProtectionColor`. Inner `TextField` rounded with the global corner radius, 24 dp leading search icon, hint "Search apps" (`widgets_full_sheet_search_bar_hint`), trailing ✕ when non-empty. Field height 48 dp (`all_apps_search_bar_field_height`), text 16 sp. | ✅ |
| Algorithm | `NeoAppSearchAlgorithm`: title prefix/word match; `searchFuzzy` false → fuzzy (approximate) matching; `searchHiddenApps` false; results also include **web suggestions** from the active provider's `suggestionUrl` (max 5, `SearchProvider.MAX_SUGGESTIONS`), **contacts** (`searchContacts` false, `PeopleItems`), and a "Search the web" row (`searchGlobal` true). | ✅ (web suggestions optional) |
| Providers | Room table `SearchProvider(id,name,iconId,searchUrl,suggestionUrl,enabled,order)`. Built-ins: *App search* (id 1, offline, always), AlternativeTo, Baidu, Bing, Brave, DuckDuckGo, Ecosia, Google, Metager (en/de), … (see `data/models/SearchProvider.kt`; `%s` = query). `searchProviders` = enabled ids (default `{1}`), `SearchProvidersPage` = reorderable list with enable switches + add/edit dialog (name, search URL, suggestion URL). The search bar cycles providers on icon tap (`changeSearchProvider`). App-based providers (`search/providers/*`: Baidu, Bing, DuckDuckGo, Edge, Firefox, Google Go, S Finder) launch the installed app's search/assist intent. | ✅ (URL providers → `xdg-open`) |
| Voice / assistant buttons | `searchShowMic` false, `searchShowAssistant` false (prefs only in main). | ❌ |
| Global search gesture | `StartGlobalSearchGestureHandler` → goes to ALL_APPS with the search field focused. | ✅ |
| Feed | `feedProvider` (TwoStatePref enable + provider from installed feed apps), `feedEnable` false — swipe-right overlay ("Google Feed", `OpenOverlayGestureHandler`). | ❌ drop |

### 1.6 Gestures (`gestures/`)

Gesture slots (pref → default handler) **[main]** (0.9.3 differences in brackets):

| Slot (label) | Pref key | Default |
|---|---|---|
| Double tap | `GESTURES_DOUBLE_TAP` | Open Dash |
| Touch and hold | `GESTURES_LONG_TAP` | Open Popup Menu (`DesktopBubbleGestureHandler`) [0.9.3: Edit Home Screen / overview] |
| Pinch in | `GESTURES_PINCH_IN` | Edit Home Screen (`OpenOverviewGestureHandler` → `EDIT_MODE`) [0.9.3: no pinch gestures] |
| Pinch out | `GESTURES_PINCH_OUT` | Do Nothing |
| Swipe down | `GESTURES_SWIPE_DOWN` | Open notifications |
| Swipe Upwards | `GESTURES_SWIPE_UP` | Open app drawer |
| Swipe upwards from dock | `GESTURES_SWIPE_UP_DOCK` | Launch Global Search [0.9.3: Open app drawer] |
| Home Button Tap | `GESTURES_HOME_PRESS` | Do Nothing |
| Back button | `GESTURES_BACK_PRESS` | Do Nothing [0.9.3: Back button] |
| Launch Assistant (through button or gesture) | `GESTURES_LAUNCH_ASSISTANT` | Do Nothing [0.9.3: Open Dash] |

Available handlers (`GestureController.getGestureHandlers`, in menu order): Do Nothing · Back button (only offered for swipe-up slots) · Sleep (accessibility lock-screen or device-admin `lockNow`) · Sleep Using Screen Timeout (sets screen timeout to 0 via a transparent activity) · Open Dash · Open app drawer · Open Widget Drawer · Open notifications (`StatusBarManager.expandNotificationsPanel` via reflection) · Open Google Feed (overlay) · Edit Home Screen · Open Popup Menu · Launch Global Search · Open Launcher Settings. Plus `StartAppGestureHandler` ("Open App"/"Open “%s”", `hasConfig` = chosen app) which exists in code and strings but is not in the picker list in `main`. The picker (`GestureSelectorPage`) is a plain list with the handler icon + name. Handlers are stored as JSON `{"class": "...", "config": {...}}`.

Detection (`VerticalSwipeGestureController`, `PinchGestureController`, `WorkspaceTouchListener`):
- Vertical swipes only in `NORMAL` state with no floating view open; velocity is EMA-smoothed (`SCROLL_VELOCITY_DAMPENING_RC = 1000/(2π·10)` ms) and **triggers at |v| > 2.25 px/ms** (down → swipe-down handler; up → dock handler if the touch started over the hotseat, else the swipe-up handler). Default swipe-up (Open app drawer) is *not* a custom gesture: it is Launcher3's `AllAppsSwipeController` drag-to-open with the sheet following the finger (see §3.2).
- Pinch: two pointers; triggers once per gesture when span ratio ≤ 0.85 (in) / ≥ 1.15 (out) **and** |Δspan| ≥ 1.5 × touchSlop; haptic `EFFECT_CLICK` on trigger.
- Double tap: Android `GestureDetector` defaults (300 ms double-tap timeout, 100 dp slop). Long press: `WorkspaceTouchListener` after `ViewConfiguration.longPressTimeout` (400 ms system default) with `HapticFeedbackConstants.LONG_PRESS`; cancelled if the finger moves > touchSlop. Icon long-press uses `CheckLongPressHelper` with factor **0.75 × longPressTimeout = 300 ms** (`DEFAULT_LONG_PRESS_TIMEOUT_FACTOR`).

GNOME: all gestures ✅ (notifications → `Main.panel` message tray / `Main.messageTray`; sleep → `Main.screenShield.lock`; assistant/back/home ❌ or map to Shell actions).

### 1.7 Dash (`dash/`)

Bottom sheet (`ComposeBottomSheet` → `DashPage`) opened by double tap. Content: `LazyVerticalGrid` with `dashLineSize` columns (4–6, default 6), 8 dp gaps and 8 dp content padding; optional **MusicBar** row spanning the full width (aspect `lineSize/2.8`), then items in the user's order (`dashProvidersItems`, reorderable in `EditDashPage`):
- **Control** providers (toggle, span 2 cells, aspect 2.15, filled `primaryContainer` when on / `surfaceContainer` off, `MaterialTheme.shapes.medium`, label `labelLarge`; "extendable" ones open the system settings page on long/second tap): Wi-Fi, Mobile Network, Location, Bluetooth, Auto Rotation, Sync.
- **Action** providers (square, span 1, icon only): Edit Dash, Pick Wallpaper, Home settings (launcher settings), Volume Dialog, Device Settings, Manage apps, Open All Apps, Sleep, Launch Assistant, Torch, Audio Player.
- Default set **[main]**: Wi-Fi, Mobile Network, Device Settings, Launch Assistant, Volume Dialog, Edit Dash. **[0.9.3]** default ids `17,15,4,6,8,5`.
GNOME: ✅ (map to NetworkManager/BlueZ/rfkill/GSD toggles; Mobile Network ⚠️ ModemManager; Torch ⚠️ via `/sys/class/leds`).

### 1.8 Icons & theming

| Feature | Detail | GNOME |
|---|---|---|
| Icon packs | `IconPackProvider` discovers installed packs by the classic intents (Nova/ADW/Apex/Go/… `Config.ICON_INTENTS`) + Lawnicons; `profileIconPack` "" = system. Per-app override (`IconOverrideRepository`, Room) via Customize → tap icon → `EditIconPage` (pick from any pack, or external image picker). `profileResetCustomIcons` dialog appears when overrides exist. | ⚠️ freedesktop icon themes as "packs"; per-app override ✅ |
| Themed (monochrome) icons | `profileThemedIcons` default = Android ≥ 13; pack entry "Themed icons" (`icon_packs_intent_name`). | ⚠️ symbolic icons |
| Adaptify | `profileIconAdaptify` false — wrap legacy pack icons in the adaptive mask. | ✅ (mask every icon) |
| Coloured backgrounds | `profileIconColoredBackground` true — for adaptive icons, keep their own background. | ✅ |
| Icon shadow | `profileIconShadow` false — shadow for non-adaptive icons. | ✅ |
| Icon shapes (`profileIconShape`, default "system") | `IconShape.kt`: circle · square (arc corners, scale .16) · sharpSquare (0) · roundedSquare (.6) · squircle · sammy · teardrop (BR .3) · cylinder (y .6) · cupertino · hexagon · octagon (cut .5) · egg (bottom .75) · custom `v1|TL|TR|BL|BR` with per-corner shape (arc/squircle/sammy/cut/cuthex/cupertino) and scale. Corner Bézier control distance for arc = 0.44777. `IconShapePage` shows a grid of previews (`IconShapeIcon`, 24 dp theme icons). Folder icon shape separate (`desktopFolderIconShape`). | ✅ (Cairo paths) |
| Theme (`profileTheme`) | flags: Light 0 · Dark 1 · Black 3 · System 8 (default on ≥ Android 12) · System (Black) 10 · Auto-from-wallpaper 4 · Auto (Black) 6. Dark decided by: System → night mode; Wallpaper → `WallpaperColors` dark hint; else flag. Note: the Theme row is **commented out of the Profile page in main** (follows system). | ✅ (GNOME `color-scheme`) |
| Accent (`profileAccentColor`, default `system_accent`) | options `dynamicColors`: System accent · Wallpaper primary · secondary · tertiary; `staticColors`: #F32020 #F20D69 #EF5350 #2C41C9 #00BAD6 #00796B #47B84F #FFBB00 #512DA8 #7C5445 #67818E; custom hex. Settings/dash/sheets use a Material-3 dynamic scheme generated from the accent (`dynamicColorScheme(seed, isDark, isAmoled, PaletteStyle.Fidelity)` with `primary` forced to the accent). | ⚠️ (needs an HCT palette generator — port material-color-utilities) |
| Global corner radius | `profileWindowCornerRadius` -1 (Auto) … 48 dp, default **24 dp**; drives dock background, search bar, folder corners, sheets. | ✅ |
| Language | `profileLanguage` "" = system. | ✅ |
| Popup menu items (`profilePopupMenu`) | which rows appear in the long-press-empty-space menu: Wallpaper, Widgets, Apps list (default on), Edit Home Screen, Set as Home Screen (default off). "Home settings" is always present. | ✅ |
| Custom app names | `customAppName` map (Customize sheet → name field). | ✅ |
| Hide app from Customize sheet | switch "Hide app" in `CustomizeIconPage`, plus "Reset custom icon", category/tab assignment. | ✅ |

Compose palette constants (`theme/Color.kt`) used before dynamic colour kicks in: Light bg `#FFFFFF`, surface `#E9ECEF`, primary `#009688`, onSurfaceVariant `#555555`, outline `#9D9D9D`; Dark bg `#212121`, surface `#262626`, surfaceVariant `#323639`, onSurfaceVariant `#D9D9D9`; Black bg `#090909`, surface `#212121`. Launcher3 attrs: workspace text light `#FFF` (with shadow `#B0000000`, ambient `#40000000`, key `#89000000`) / dark text `#000`; notification dot light `#6DD58C` / dark `#C4EED0` (overridden by Neo's `#F32020` when custom colour is on); folder preview light `#7FCFFF` / dark `#1E1F20`; popup bg light `#FFF` / dark `#3C4043`. Brand: launcher icon purple `#6644FF`, red `#EE4477`, bg `#F3FBFF`.

### 1.9 Settings tree (`compose/pages/preferences/*`, labels from `Omega/res/values/strings.xml`)

Settings is a Compose `NavigableListDetailPaneScaffold` (list of pages on phones, list+detail on tablets). Each page is a `LazyColumn` of `PreferenceGroup`s (card with heading; rows are M3 list items; first/last rows get `shapes.large` corners, middle rows `extraSmall` — `GroupItemShape`). Overflow menu on the main page: *Set as Home App* (if not default), *Restart*, *Developer Options*. Detail-pane transition: `fadeIn + scaleIn(0.95)` with the M3 motion scheme's default spatial spring, exit `fadeOut` fast spatial.

**Home settings** (main page)
- *User Interface*: Profile (Palette icon) · Drawer (DotsNine) · Desktop (Monitor) · Dock · Folder (Folder)
- *Features*: Widgets & Notifications (SquaresFour) · Search & Feed (MagnifyingGlass) · Gestures & Dash (ScribbleLoop)
- *Others*: Backups (ClockCounterClockwise) · Developer Options (BracketsCurly, only if enabled) · About (Info; sub-pages Translators, Licenses, Changelog, Acknowledgement)

Per page (group → rows; type; default; range):

**Profile**
- Profile: Language (select, "" = System) · ~~Theme~~ (hidden) · Accent Color (→ `ColorSelectionPage`: dynamic chips + static swatches + custom hex, default System)
- Icons: Icon Packs (select, "" system) · Icon shape (→ IconShapePage, "system") · Create adaptive icons for icon pack (bool false) · Coloured backgrounds (bool true) · Show Icon Shadow (bool false) · Remove Custom Icons (dialog, only when overrides exist)
- Others: Global corner radius (slider -1 Auto…48, 50 steps, 24 dp) · Allow home screen rotation (bool false) · Popup menu items (multi-select: Wallpaper ✓, Widgets ✓, Apps list ✓, Edit Home Screen, Set as Home Screen) · ~~Show Top Shadow~~

**Desktop**
- Icons: Icon size (0.5–2.0, 150 steps, 100 %) · Hide icon labels on home screen (false) · Multiline app names (false) · Text Size (0.5–2.0, 100 %) · Popup menu items (multi: Customize ✓, Uninstall)
- Grid: Grid size (dialog with two sliders Columns/Rows, each 2–16; defaults from grid option) · Add app icons to home screen "For new apps" (true) · Full width widgets (false) · Cycle Scrolling (false)
- Others: Allow Empty Pages (false) · Lock Desktop (false)

**Dock** (single group): Dock Enabled (true) · Icon Count (dialog slider 2–16) · Show Background (false) · Background Color (only when background on; `custom|#ff101010`) · Dock bottom padding (0.1–1.6, 100 %)

**Drawer**
- Icons: All Apps Icon Size (0.5–2.0) · Hide app names (false) · Multiline app names (false) · Text Size (0.3–1.8) · Shortcut Bubble (multi: Uninstall, Customize ✓)
- Grid: Number of columns (dialog 2–16) · App suggestions (false) · App Sorting (A→Z / Z→A / Most Used / By Color / Last Installed) · Layout Mode (Vertical / Horizontal / Vertical Categories / Horizontal Tabs) · Manage Categories (only for Vertical Categories; multi-select) · Manage Tabs (only for Horizontal Tabs; → AppCategoriesPage) · Enable folders in drawer (TwoState: switch + "Tap to create or edit folders") · Remember Position (false) · Hide Scrollbar (false)
- Others: Hidden App Shortcuts (→ HiddenAppsPage) · Turn on protected apps (TwoState, false; auth on disable) · Use custom background color (false) · Background Color (when on) · Opacity (0–1, 100 steps, 100 %)

**Folder**
- General: Use custom folder background (false) · Folder background color (when on; system accent)
- Icons: Folder icon shape ("system") · Folder Icon Opacity (0–1, 10 steps, 100 %)
- Grid: Folder Columns (2–5, default 3) · Folder Rows (2–5, default 3)

**Widgets & Notifications**
- Smartspace: Show Smartspace (false) · Show Themed Background (false) · Show Date (true) · Show Time (true) · 24-Hour Format (false) · Enable weather (TwoState: switch + provider Google / OpenWeatherMap / Pixel Experience) · OWM API Key, City ("##Auto") (only for OWM) · Temperature unit (Celsius / Fahrenheit / Kelvin / Rankine / Delisle / Newton / Réaumur / Rømer) · Events sources (multi: Battery Status ✓, Now Playing ✓, Calendar events, Upcoming alarms, Notifications; Google weather provider ✓)
- Notifications: Notification dots (intent launcher → system notification access) · Use custom color (false) · Notification Background Color (when on; #F32020) · Show Notification Count (false)

**Search & Feed**
- Search Providers: Drawer search bar (true) · Fuzzy Search (false) · Search Providers "Select and sort active search providers" (→ SearchProvidersPage) · Find hidden apps (false)
- Enable Feed Provider: TwoState (false, provider list)

**Gestures & Dash**
- Gestures: the 10 slots of §1.6, summary = current handler name, tap → `GestureSelectorPage`
- Dash: Dash line size (4–6, default 6) · Edit Dash (→ EditDashPage: reorderable list with switches, grouped Actions / Controls)

**Backups**: Create backup (→ page with checkboxes Settings / Home screen / Databases / Wallpaper → saves a `.zbk` zip, MIME `application/vnd.omega.backup`) · Restore backup (file picker, then `restoreSuccess` + restart). `BackupManager.INCLUDE_HOME_SCREEN=1, SETTINGS=2, WALLPAPER=4, DATABASES=8`.

**Developer Options**: Restart "Can be helpful if some settings are not properly applied" · Show in Settings (false) · Show debug info (false) · Free Scrolling (false)

**0.9.3 geometry/theme deltas** (relevant when reading the screenshots): Launcher3-13 hotseat = icon + `dynamic_grid_hotseat_extra_vertical_size` 34 dp + top padding 8 + bottom padding 2 (≈ 100 dp bar); dock QSB when enabled is 56 dp tall (`qsb_widget_height`), radius 8/16 dp by icon shape (`qsb_radius_square/squircle`) or `searchBarRadius`; default accent is Material Red A400 **#FF1744** (`themeAccentColor`, `Color.kt LightPrimary`), Compose primary #FF1744 vs #009688 in `main`; default corner radius 8 dp vs 24.

**0.9.3 settings not in main** (visible in the screenshots): Profile → Theme (Light/Dark/Black/System/…), Blur (`themeBlurEnable` false, `themeBlurRadius` 0.1–1.5 → 0.75), corner radius default 8 dp, icon shape as string, "Force shapeless" icons; Desktop → Allow rotation, Hide status bar, Widget corner radius (1–24 → 16 dp), Folder radius, Folder rows/cols here; Dock → Dock scale, Opacity (0.9), Dock search bar + search bar radius; Search → single Search engine select, Show mic, Open Assistant, Web results, Search Contacts; Widgets → Time above date, Pill QSB; Drawer → App groups (single pref), Row height, Second Tab for Work Apps.

### 1.10 Things that cannot be cloned on GNOME (plan substitutes)

- **App widgets** (home-screen widgets, widget picker `WidgetsFullSheet`, widget resize frame, "Widgets" long-press option, Open Widget Drawer gesture) → our own widget set (clock/date, weather, calendar, media) rendered as Shell actors; keep the picker UX (bottom sheet, 267 ms open/close, search field, per-app sections) but with our catalogue.
- **Quickstep / Recents / Overview** (the `OverviewState`, `QuickstepLauncher`) — Neo itself ships *without* quickstep ("QuickSwitch is not available, no plans") so there is nothing to clone; swipe-up from the nav area is the OS gesture, not the launcher's. For GNOME the system's own overview/app-switcher stays.
- **Google smartspace / feed overlay / assistant / voice search** — drop.
- **Notification access** (dots/counts, "Notifications" event provider) → GNOME notification sources.
- **Work profile tab, protected-apps biometrics, device-admin sleep, StatusBarManager reflection, accessibility back** → Shell equivalents or drop.
- **Icon packs / themed icons** → icon themes; **wallpaper colours / Material You** → own palette extraction.
- **Deep shortcuts** (`ShortcutInfo`) → `.desktop` `Actions`.
- **Uninstall / App info** → PackageKit / Software; Android "App info" has no equivalent.

---

## 2. Layout metrics for a 360×800 dp phone

### 2.1 Which Launcher3 grid profile applies

`InvariantDeviceProfile.invDistWeightedInterpolate`: take the smallest (width, height) in dp over all supported window bounds (portrait: available size; landscape on phones: transposed), then pick the display-option with the smallest Euclidean distance to (minWidthDps, minHeightDps), blending the 3 nearest (`KNEARESTNEIGHBOR = 3`, weights `100000 / d^5`) for the continuous values (icon size, text size, cell heights), with the icon size capped at the closest option's.

For 360×800 with a 24 dp status bar and gesture navigation: w ≈ 336 (landscape height 360-24), h ≈ 776 → distances: **5_by_5 / "Large Phone" (406×694) ≈ 108** (closest), Nexus 4 (359×567) ≈ 210, Nexus 5 (335×567) ≈ 209. Weight of the Nexus options ≈ (108/209)^5 ≈ 3.7 % each, so blended values stay within 0.1 of "Large Phone". Result (`res/xml/device_profiles.xml`, both versions):

| Property | Value |
|---|---|
| Grid | **5 columns × 5 rows**, `numHotseatIcons` 5, `numFolderRows/Columns` 4×4 (Neo's pref default overrides to 3×3), `numAllAppsColumns` = 5, not scalable (uses the "non-responsive" DeviceProfile path) |
| `iconImageSize` | **56 dp** |
| `iconTextSize` | **14.4 sp** (blended ≈ 14.35) |
| `allAppsCellHeight` | 104 dp |
| `allAppsBorderSpace` | 16 dp |
| `hotseatBarBottomSpace` | default 48 dp (`config.xml hotseat_bar_bottom_space_default`), `hotseatQsbSpace` 0 |
| DB | `launcher_5_5_5.db` (Neo names the DB `launcher_{rows}_{cols}_{hotseat}.db`) |

Neo then applies `DeviceProfileOverrides.Options.applyUi`: rows/cols/hotseat/all-apps-columns/folder grid from prefs (defaults = the grid option), `iconSize *= desktopIconScale`, `iconTextSize *= desktopLabelScale` (0 when labels hidden), `allAppsIconSize *= drawerIconScale`, `allAppsIconTextSize *= drawerLabelScale`. NB: `iconTextSizeFactor` is wired to **`drawerLabelScale`** in `Options` (a bug in main; `TextFactors` uses `desktopLabelScale`) — clone the intent, not the bug.

The Galaxy S10e used for screenshots (360×760 dp, 480 dpi) resolves to the same 5×5 "Large Phone" option — **confirmed by the launcher's own dump** (`ref/deviceprofile-s10e.txt`: `inv.numColumns:5`, `iconSizePx 56`, `iconTextSizePx 14.33 sp`, hotseat 5); see §4.1.

### 2.2 Workspace (home screen) — `WorkspaceProfileNonResponsiveFactory.createWorkspaceProfileNonScalable` + `res/values/dimens.xml`

| Metric | Value (dp) | Source / formula |
|---|---|---|
| Icon bitmap size | 56 | `iconImageSize` × `desktopIconScale` |
| Icon visible area | 0.92 × icon (51.5) | `IconNormalizer.ICON_VISIBLE_AREA_FACTOR` — adaptive icons are drawn with the mask occupying 92 % of the bitmap |
| Icon→label gap (`iconDrawablePaddingPx`) | 7 − (56 − 51.5)/2 ≈ **4.8** (→ 5) | `CellStyleDefault.iconDrawablePadding` 7 dp, normalised by the invisible icon border |
| Label text size | 14.4 sp, 1 line (2 if multiline), `BaseIcon` style: centred, `textColorSecondary` → `workspaceTextColor` #FFF with shadow radius 2 (light wallpaper theme) | `BubbleTextView` |
| Cell content height (`cellHeightPx`) | ceil(56 × 1.125) = 63 + 4.8 + textHeight(14.4 sp ≈ 19) ≈ **87** | `getIconSizeWithOverlap` uses `ICON_OVERLAP_FACTOR = 1 + 0.25/2 = 1.125` so folder previews (which dilate) fit |
| Cell content width (`cellWidthPx`) | 56 + 4.8 ≈ 61 | |
| Workspace padding L/R | **8** | `dynamic_grid_left_right_margin` |
| Workspace padding top | 0 + **10.77** | `workspaceTopPadding` (0 on phones) + `dynamic_grid_edge_margin` (non-scalable adds the edge margin) |
| Workspace padding bottom | hotseatBarSize − insets.bottom + 0 + **24** (page indicator) | formula in `calculateWorkspacePadding` |
| CellLayout padding (all sides) | **10.77** | `cell_layout_padding` |
| Cell border spacing | 0 (non-scalable grids have no gutter) | `cellLayoutBorderSpacePx = Point(0,0)` |
| Cell size (what a grid cell actually gets) | width = (360 − 16 − 21.5)/5 ≈ **64.5**; height = (800 − 24 − 10.77 − bottomPad − 21.5)/5 — with hotseat 104 dp + 24 dp indicator: (800−24−10.77−128−21.5)/5 ≈ **123** | content is vertically centred in the cell; `cellPaddingY = (cellSize.y − cellHeightPx)/2 ≈ 18` |
| Horizontal cell text padding | 8 | `dynamic_grid_cell_padding_x` (icon label inset) |
| Page indicator strip | 24 tall; dots 6 dp Ø, 4 dp gap (`page_indicator_dot_size`, `page_indicator_gap_width`), active alpha 255, inactive 128 (`DOT_ALPHA`), colour `workspaceTextColor`; auto-hides after scroll settle (`PAGINATION_FADE_DELAY = ViewConfiguration.scrollDefaultDelay = 300 ms`, fade-out 167 ms, fade-in 83 ms) | `PageIndicatorDots` |
| Spring-loaded page border | 2 dp | `spring_loaded_panel_border` |
| Spring-loaded min visible next page | 48 | `dynamic_grid_spring_loaded_min_next_space_visible` |
| Drop target bar | 56 tall, top margin 32, bottom 16 (`drop_target_top_margin`/`bottom_margin`), text 16 sp, icon 20 dp, pill radius 80 dp, inter-button gap 28 | `DropTargetProfile`, `dimens.xml` |
| Workspace content scale in ALL_APPS | 0.97 | `workspace_content_scale` |
| Status-bar shadow | `profileShowTopShadow` (pref) | |

**Resulting vertical layout (portrait, 24 dp status bar, 0 dp nav inset)** — 24 status · 10.77 top pad · 10.77 cell pad · 5 × 123 rows · 10.77 cell pad · 24 page dots · 104 hotseat bar (= 63 cell + 48 bottom space − 7 overlap, icons are bottom-aligned above the 48 dp space) = 800. If the Shell's bottom gesture area counts as an inset (e.g. 24 dp), `hotseatBarBottomSpacePx = inset + 8` only when that exceeds 48, so the bar stays 104 dp until the inset is > 40 dp.

### 2.3 Hotseat — `DeviceProfile.updateHotseatSizes`, `HotseatProfile`

| Metric | Value (dp) | Formula |
|---|---|---|
| Icon size | 56 (× `dockIconScale`, pref hidden) | same bitmap as workspace |
| Cell height (`hotseatCellHeightPx`) | ceil(56 × 1.125) = **63** | |
| Bottom space (`hotseatBarBottomSpacePx`) | **48** × `dockBottomPadding` (or insets.bottom + 8 if larger) | |
| QSB height | 0 (`qsb_widget_height` 0 dp, Neo has no dock QSB in main) | |
| Bar size (`hotseatBarSizePx`) | 56 + 0 + 0 + 48 = **104**; 0 when dock disabled | `iconSize + hotseatQsbSpace + qsbVisualHeight + bottomSpace` |
| Icon spacing | icons distributed across the workspace cell columns (hotseat uses the same `cellWidth` as the grid; `hotseatBorderSpace` = workspace border space 0; min 18 / max 50 dp when the hotseat has its own width) | `recalculateHotseatWidthAndBorderSpace` |
| Side padding | 0 (`dynamic_grid_hotseat_side_padding`) + workspace padding 8 | |
| Background (optional) | rounded rect, radius 24 (global) / 16, colour `dockBackgroundColor`, 4 dp shadow blur; spans full width, top edge at the hotseat's top | `CustomHotseat.drawBackground` |
| Spring-loaded top margin | 76 (`spring_loaded_hotseat_top_margin`) | |

### 2.4 All Apps drawer — `AllAppsProfile.createAllAppsProfileNonScalable`, layouts

| Metric | Value (dp) | Source |
|---|---|---|
| Columns | 5 (`numAllAppsColumns`) | |
| Icon size | 56 × `drawerIconScale` | `allAppsIconSize` defaults to `iconImageSize` |
| Icon text | 14.4 sp × `drawerLabelScale`; 1 line (2 with multiline) | |
| Icon→label padding | **8** | `all_apps_icon_drawable_padding` |
| Cell height | **104** (+ `allAppsBorderSpace.y` 16 = 120 in A16 non-scalable: `cellHeightPx = pxFromDp(allAppsCellHeight) + borderSpace.y`) × `drawerCellHeightMultiplier` | |
| Cell width | icon + 2 × 8 = **72** (cells are then stretched to fill the row) | |
| Border space | 16 × 16 | `allAppsBorderSpace` |
| Side padding | 16 (`AllAppsStyleDefault.horizontalPadding`) | |
| Top: search bar | 48 field height, 12 dp horizontal margins, 2 dp padding, pill; sits at `all_apps_header_top_padding` 36 from the sheet top; the floating header below has 36 top / 14 bottom padding | `search_container_all_apps_compose.xml`, `all_apps_content.xml` |
| Tabs (Horizontal Tabs layout) | header pill 48 tall (`all_apps_header_pill_height`), radius 12; each tab a Material button 14 sp, 8 dp horizontal / 4 dp vertical padding, 8 dp corner radius, 1 dp margins, in a `HorizontalScrollView` with 12 dp side padding (`all_apps_tabs_side_padding`), 8 dp top margin; paged content below with 40 dp top padding (`all_apps_paged_view_top_padding`) | `Omega/res/layout/all_apps_tab.xml` |
| Fast scroller | track 6–8 dp wide, thumb 52 tall, 58 dp touch width at −26 dp end margin; popup letter 32 dp text in a 75×62 bubble, 19 dp from the edge; A–Z letter rail: 14 sp letters, 5 dp dots | `fastscroll_*` dimens |
| Section/prediction divider | 2 dp × 128 dp (`all_apps_divider_*`), 8 dp vertical margins | |
| Sheet | the drawer is a full-screen sheet; its scrim colour = §1.3 background; sheet top corner radius follows the global corner radius (A16 draws `all_apps_bottom_sheet_background` on tablets only; phones are edge-to-edge) | |
| Drawer open travel | `allAppsShiftRange` = screen height (phones: `heightPx − allAppsTopPadding + insets.top`, with `allAppsTopPadding` 0) → the sheet slides the full screen height | `DeviceProfile` l.539 |
| Horizontal (paged) layout | dots 8 dp Ø, 4 dp margins, 40 dp strip at the bottom, 8 dp content top padding, elevation 4 | `HorizontalAppsView.kt` |
| Categories rail | Compose `AllAppsCategories` vertical bar (`wrap_content` width) on the left, elevation 16, top padding = 36 (header), bottom = nav-bar height | `CategorizedAppsView.kt` |

### 2.5 Folder — `FolderProfile.createFolderProfileScalable` with `FolderStyleDefault` (`styles.xml`)

| Metric | Value (dp) |
|---|---|
| Open folder grid | `desktopFolderColumns` × `desktopFolderRows` (default 3×3) |
| Cell | 80 wide × 94 tall (`folderCellWidth/Height`), gutter (`folderBorderSpace`) 16 |
| Content padding | top 24 (`folderTopPadding`), left/right 8 (`folder_content_padding_left_right`), folder cell x/y padding 9/6 |
| Footer | 56 tall (`folderFooterHeight`), 20 dp horizontal padding; name field centred, `TextHeadline` style, label scale 1.14 × child text (min 16 sp) |
| Child icon | = workspace icon (56) and text (14.4 sp), drawable padding = (cellHeight − icon − textHeight)/3 |
| Folder window corners | 12 dp (`folder_content_corner_radius` Omega) or `desktopFolderCornerRadius`; A16 default dialog radius 26 (`default_dialog_corner_radius`) |
| Folder icon (closed) preview | `folderIconSizePx` = icon size; preview background radius = previewSize/2; items at 0.44–0.51 scale in a 2×2 arrangement with 0.25 radius dilation; "accept" scale 1.2; hover 1.1 (300 ms) |
| Page arrows / dots | 32 dp touch boxes (`folder_arrow_touchbox_length`), dots as workspace |

### 2.6 Popups and sheets

| Element | Metrics |
|---|---|
| Icon long-press popup (`PopupContainerWithArrow`) | item width **216** (`bg_popup_item_width`), item height **52** (`bg_popup_item_height`), deep-shortcut icon 35 dp, text 14 sp at 54 dp start padding (`deep_shortcuts_text_padding_start`), system-shortcut icon 20 dp with 16 dp start margin; container padding 2 dp, item vertical padding 12 dp; arrow 12 × 10 dp, 2 dp corner radius, arrow centre 26 dp from the popup's edge; single-item radius 100 dp (pill), multi-item outer radius via `popup_smaller_radius` 4 dp inner corners; background `popupColorPrimary`; elevation 2 dp |
| Long-press-empty-space menu (`OptionsPopupView`) | same item geometry (216 × 52), icon 24 dp (`options_menu_icon_size`), rows: Wallpaper & style · Widgets · Edit Home Screen · Set as Home Screen · Apps list · Home settings (filtered by `profilePopupMenu`) |
| Bottom sheets (Dash, Customize, widgets, Compose sheets) | `AbstractSlideInView`: slide from bottom, open 267 ms (`config_bottomSheetOpenDuration`), close 267 / 200 (`BaseBottomSheet.DEFAULT_CLOSE_DURATION`), `FAST_OUT_SLOW_IN`; scrim `widgets_picker_scrim`; handle 32 × 4 dp, radius 2, 16 dp margin, 36 dp handle area; `ComposeBottomSheet.show` adds 50 dp bottom content padding; sheet top padding on phones = height/6 + 10.77 (`BottomSheetProfile`) |
| Dialogs | M3 `BaseDialog`, corner radius 26 dp |
| Snackbar | 48 tall, 12–14 sp, 30 dp bottom margin |
| Arrow tip | 14 sp, 2 dp radius |

### 2.7 Settings UI (Compose)

- `ViewWithActionBar`: M3 `TopAppBar` (title `headlineSmall`-ish, back arrow), content `LazyColumn` with 8 dp horizontal padding, 8 dp between groups.
- `PreferenceGroup`: optional heading (`titleSmall`, primary colour), items separated by 2 dp; each `PreferenceItem` ≈ 72 dp list row: leading 24 dp Phosphor icon, title `titleMedium`, summary `bodyMedium` onSurfaceVariant, trailing switch / value.
- Sliders: `IntSeekBarPreference` row with title + value text ("100 %", "24dp", "Auto") and an M3 `Slider`.
- Search bars inside pickers (`SearchBarUI`): **60 dp** tall surface (`TOPBAR_HEIGHT`) with 8 dp outer padding (`TOPBAR_PADDING`), corner radius = global radius (16 when Auto), 2 dp elevation, back IconButton + text field.
- `PreferenceGroup` heading: 48 dp tall row, 32 dp horizontal padding, `titleMedium` in the primary colour; 2 dp spacers between items; 8 dp spacer when there is no heading. Page title in the app bar: `titleLargeEmphasized`.

---

## 3. Animations

All durations in ms. "User-controlled" = follows the finger; the listed curve then applies to the fling/settle.

### 3.1 Page swipe / settle (`PagedView`, `Workspace`)

| Case | Duration | Curve |
|---|---|---|
| Programmatic snap (tap indicator, return to page, low velocity) | **750** (`config_pageSnapAnimationDuration`) | `SCROLL` (quintic ease-out) via `OverScroller` |
| Fling (`snapToPageWithVelocity`) | `4 × round(1000 × distance / velocity)` where distance = halfScreen + halfScreen × sin((min(1, |Δ|/screenW) − 0.5) × 0.3π/2), velocity = max(1500 dp/s, |v|) → typically **250–400 ms** | `SCROLL` |
| Thresholds | fling if |v| ≥ 500 dp/s (`fling_threshold_velocity`; 400 "easy fling"); min fling 250 dp/s; page commits if moved > 40 % of width (`SIGNIFICANT_MOVE_THRESHOLD`), returns if < 33 % (`RETURN_TO_ORIGINAL_PAGE_THRESHOLD`) | |
| Over-scroll at the ends | damped: `0.07 × f(amount/max) × max` (`OverScroll.OVERSCROLL_DAMP_FACTOR`), max = width/2 | spring back with the scroller |
| Wallpaper parallax | offset follows scroll; animates with the page | |
| Page indicator dot | slides 0.5 dot per animation, **200** (150 pre-visual-refresh), `OvershootInterpolator()` when finishing a fling; enter animation 400 ms, 300 ms delay + 150 ms stagger, overshoot tension 4.9 | `PageIndicatorDots` |

### 3.2 Drawer open / close (`AllAppsTransitionController`, `AllAppsSwipeController`, `AllAppsState`)

| Case | Duration | Curves |
|---|---|---|
| Open, atomic (tap "Apps list", gesture handler) | **600** (`config_allAppsOpenDuration`) | vertical progress: `clampToProgress(mapToProgress(EMPHASIZED_DECELERATE, 0.4→1), 0, 0.8333)`-style (`ALL_APPS_VERTICAL_PROGRESS_ATOMIC`); content fade: `ALL_APPS_FADE_ATOMIC` = `clamp(map(EMPHASIZED_DECELERATE, 0.2→1), 0.3333, 0.8333)`; scrim: `SCRIM_FADE_ATOMIC` = `clamp(map(LINEAR, 0→0.8), 0.2642, 0.8333)`; workspace fade/hotseat fade: step at 0.3333 (`STEP_TRANSITION_ATOMIC`); workspace & hotseat scale → 0.97 with `WORKSPACE_SCALE_ATOMIC` (clamped to [0.1667, 0.8333]); blur/depth with `BLUR_ATOMIC` |
| Open, manual (swipe up, finger-tracked) | shift = `allAppsShiftRange` (screen height); progress = 1 − dragged/shift | `ALL_APPS_VERTICAL_PROGRESS_MANUAL = LINEAR`; content fade `ALL_APPS_FADE_MANUAL` = `clamp(LINEAR, 0.4, 0.8)`; scrim `clamp(LINEAR, 0.117, 0.4)`; workspace/hotseat fade: step at 0.4 (`STEP_TRANSITION_MANUAL`), scale `LINEAR` over [0, 0.4]; **commit threshold: release past 60 % of the travel** (`SWIPE_DRAG_COMMIT_THRESHOLD = 1 − 0.4`) or fling; the settle after release is a **spring** (`createSpringAnimation`) |
| Close, atomic (back, home) | **300** (`config_allAppsCloseDuration`) | reverse of the atomic set; vertical progress `EMPHASIZED_ACCELERATE`; all-apps content `ALL_APPS_CLAMPING_RESPONDER` = `clamp(LINEAR, 0.2, 0.5)`; workspace fade `INSTANT`; scrim `reverse(clamp(LINEAR, 0.1, 0.5))` |
| Close by swiping down | manual set reversed; revert-to-all-apps if not committed: **200** (`REVERT_SWIPE_ALL_APPS_TO_HOME_ANIMATION_DURATION_MS`) | |
| Haptic | `MSDLToken.SWIPE_THRESHOLD_INDICATOR` when the drag crosses the commit threshold | |

### 3.3 Folder open / close (`FolderAnimationManager`, `Folder`)

| Element | Duration / delay | Curve |
|---|---|---|
| Folder window scale + translate from the folder-icon rect to its final rect (content and footer scale together; background rect radius animates from the icon preview radius to the folder corner radius) | **200** (`config_materialFolderExpandDuration`), item delay 30 (`config_folderDelay`) | open & close: `standard_interpolator` (= `STANDARD`, 0.2,0,0,1) |
| Preview items → grid positions (translate X/Y + scale from 0.44–0.51 to 1) | 200 − 30 delay on open (start 30 ms late), 200 − 60 on close | same, or for "large" folders (> 4 items on the first page) `large_folder_preview_item_open_interpolator` (0,0,…) / `standard_accelerate_interpolator` on close |
| Footer alpha | fades over the whole 200 (small folder); large folders: only the last **128 ms** (`LARGE_FOLDER_FOOTER_DURATION`) | `LINEAR` |
| Folder name | alpha over the last **32 ms** of the open (`FOLDER_NAME_ALPHA_DURATION`), first 32 ms of the close; rename-commit animation 633 (`FOLDER_NAME_ANIMATION_DURATION`) | |
| Folder colour change | 200 (`FOLDER_COLOR_ANIMATION_DURATION`) | |
| Elevation (z) | second half of the duration (open) / first half (close) | |
| Icon preview accept (hover with drag) | 100 (`CONSUMPTION_ANIMATION_DURATION`), scale 1.2; hover 1.1 over 300 (`EMPHASIZED_DECELERATE`) | |
| Auto-close after dragging an item out | 400 (`ON_EXIT_CLOSE_DELAY`); reorder inside after 250 (`REORDER_DELAY`) | |

### 3.4 Icon press, long-press, popup

| Element | Duration | Curve |
|---|---|---|
| Icon press feedback (`FastBitmapDrawable`) | scale **1.0 → 1.1** (`PRESSED_SCALE`) over **200 ms** (`CLICK_FEEDBACK_DURATION`; hover 300 ms `HOVER_FEEDBACK_DURATION`), `ACCEL` on press / `DEACCEL` on release (`AccelerateInterpolator()`, `DecelerateInterpolator()`); hover 1.1 with `HOVER_EMPHASIZED_DECELERATE` (0.05,0.7,0.1,1) | |
| Long press timeout | 0.75 × 400 = **300 ms** on icons; 400 on empty workspace; haptic `LONG_PRESS` (`MSDLToken.LONG_PRESS`) | |
| Popup open (`ArrowPopup`, Android U timings) | **200** total (`OPEN_DURATION_U`): scale from the arrow point with `PathInterpolator(0.3, 0, 0.33, 1)` ("overshoot" 200), container fade 83 (`OPEN_FADE_DURATION_U`, delay 0), child fade 83 (`LINEAR`) | `EMPHASIZED_DECELERATE` for the reveal |
| Popup close | **233** (`CLOSE_DURATION_U`); fades start at 150, last 83 | `EMPHASIZED_ACCELERATE` |
| Pre-drag (icon pulled while popup is open) | icon scales down by `pre_drag_view_scale` 6 dp; drag starts after 16 dp of movement (`deep_shortcuts_start_drag_threshold`) | |
| Drag view scale-in | 500 (`DRAG_VIEW_SCALE_DURATION_MS`) | |
| Drop into cell | 100–500 depending on distance (`config_dropAnimMin/MaxDuration`, `config_dropAnimMaxDist` 800 px scaled by `DECELERATE_1_5`) | `DECELERATE_1_5` |
| Spring-loaded enter/exit (`SpringLoadedState`) | **150**; exit delay after drop 500 (`SPRING_LOADED_EXIT_DELAY`) | workspace scale `ZOOM_OUT` (state default), `getWorkspaceSpringLoadScale`: scale = (shrunkBottom − shrunkTop)/cellLayoutHeight, reduced so 48 dp of the next page shows; page backgrounds alpha 0.2 |
| Edit mode enter/exit | 150 | same scale for workspace **and** hotseat |
| Workspace reorder (while hovering) | 650 (`REORDER_TIMEOUT`) | |
| New-app bounce | alpha+scale → 1, staggered by `NEW_SHORTCUT_STAGGER_DELAY` | |

### 3.5 Other state animations

| Element | Duration | Curve |
|---|---|---|
| Bottom sheets (Dash, Customize, widgets) | open 267, close 267/200; drag-to-dismiss uses `SCROLL_CUBIC` or `scrollInterpolatorForVelocity` | `FAST_OUT_SLOW_IN` |
| Compose detail-pane in Settings | M3 `motionScheme.defaultSpatialSpec()` spring (fade + scale 0.95 → 1), exit fast spatial fade | |
| Search bar focus | no animation on the field itself (Compose `TextField` focus highlight); keyboard slides up with the IME; the all-apps header "protection" (fade of the header background) is driven by scroll | |
| App launch (window reveal) | Neo has **no quickstep**, so `ApiWrapper.getActivityLaunchOptions` is `ActivityOptions.makeBasic()` — the launching app uses the **system window-open animation** (default Android activity open: scale from 0.85/0.9 + fade, ~ 300–450 ms); the launcher does not animate the icon. `ApiWrapper` only adds `fade_out` for the launcher's own activities. On GNOME: use Shell's app-launch (zoom/fade) animation. | system |
| Hint bounce (`DiscoveryBounce`) | 450 ms delay, uses `R.anim.discovery_bounce` (hotseat bob) | |
| Scrim (`ScrimView`) | fades with the state (`ANIM_SCRIM_FADE`, default `ACCELERATE_2`) | |
| View swipe-up on an icon (gesture handler w/ `ViewSwipeUpGestureHandler`) | icon follows the finger damped (max −400 / +100 dp), snaps back in 100 ms `DecelerateInterpolator` | |

---

## 4. Visual references (Galaxy S10e, LineageOS/Android 16, 1080×2280 @ 480 dpi → 360×760 dp; px/3 = dp)

Build captured: **Neo Launcher 0.9.3 (build 934), `com.saggitt.omega`** — the latest installable release. Device was in system dark mode; a second pass was made with Neo's Theme set to *Light*. Insets during capture: status bar/cutout **38.67 dp**, gesture nav **24 dp**. All PNGs are in `ref/`, the matching `uiautomator` dumps (px bounds) in `ref/dumps/`, and the launcher's own `DeviceProfile` dump in `ref/deviceprofile-s10e.txt` (that file contains two blocks: the first is the resident stock Launcher3 — ignore it; the second, `inv.numColumns:5`, is Neo).

### 4.1 Device profile as computed by Neo on this phone (`ref/deviceprofile-s10e.txt`, second block)

| Value | dp | Note |
|---|---|---|
| Grid | **5 × 5**, hotseat 5, all-apps columns 5 | confirms §2.1: the "Large Phone" option wins on a 360-wide phone |
| `iconSizePx` | **56** | |
| `iconTextSizePx` | **14.33 sp** (43 px) | the KNN-blended 14.4 |
| `iconDrawablePaddingPx` | 7 | Launcher3-13 does not normalise; A16 would give ≈ 4.8 |
| `cellWidthPx` / `cellHeightPx` | 63 / **89.3** | 89.3 = ceil(56×1.125)=63 + 7 + textHeight(14.33 sp)=19.3 → confirms textHeight ≈ 1.33 × size |
| `getCellSize()` | **66.3 × 125.3** | 5 columns in 360 − 2×8 − 2×8 = 331.5 → 66.3 |
| `workspacePadding` | L 8, T 8, R 8, **B 124** | B = hotseat 100 + page indicator 24 |
| `hotseatBarSizePx` / `hotseatCellHeightPx` | **100** / 63 | A13 formula: 56 + 34 extra + 8 top + 2 bottom; A16 gives 104 (56 + 48) |
| `folderCellWidthPx × folderCellHeightPx` | 74 × 87.3 | folder child icon 56, text 14.33, drawable padding 4; grid 4×4 by default on this build |
| `allAppsIconSizePx` / text / padding | 56 / 14.33 sp / 7 | |
| `allAppsCellHeightPx` | **121** | 104 + 16 border + rounding (A13); A16 gives 120 |

### 4.2 Screens captured (`ref/`)

| File | What |
|---|---|
| `01-home-first.png` | fresh install, dark, default page: 3 auto-placed icons + 5-icon dock |
| `02-home-apps.png` | same page after creating a folder (Gmail + Gallery) |
| `04-drawer-vertical.png` | drawer, dark, vertical layout (the only layout 0.9.3 ships — no "Layout Mode" row exists in its Drawer settings, so a paged-drawer capture is impossible on this build) |
| `06-search.png` | drawer search with "ca" typed → "APPS" section + results |
| `07-folder-open.png` | open folder, dark |
| `08-icon-popup.png` | icon long-press: header (App info, Customize) + Widgets + 4 deep shortcuts |
| `09-empty-longpress.png` | empty-space long-press menu: Home settings · Widgets · Wallpapers |
| `10a-widgets-edu-card.png`, `10-widgets-picker.png` | widgets sheet (first-run education card, then the per-app list) |
| `11-dash.png` | Dash sheet, dark |
| `20-settings-main*.png` | Home settings main page (top, scrolled) |
| `21-settings-profile*.png`, `21a-…-accent.png`, `21b-…-iconshape.png`, `21c-…-theme-dialog.png` | Profile page, Accent Color dialog, Customize Icons page, Theme dialog |
| `22-settings-desktop*.png` (3) | Desktop page |
| `23-settings-dock*.png` | Dock page |
| `24-settings-drawer*.png` (3), `24a-…-categorize.png`, `24b-…-hiddenapps.png` | Drawer page, Categorize Apps, Hidden App Shortcuts |
| `25-settings-widgets*.png` (3) | Widgets & Notifications |
| `26-settings-search*.png` (3), `26a-…-searchengine.png` | Search & Feed, Search engine dialog |
| `27-settings-gestures*.png` (3), `27a-…-gesture-selector.png`, `27b-…-editdash.png` | Gestures & Dash, gesture picker (Double tap), Edit Dash |
| `28-settings-backups.png`, `29-settings-desktopmode.png`, `30-settings-about*.png` | Backups, Desktop mode (0.9.3-only page; dump empty), About |
| `31-settings-profile-light.png`, `32-settings-main-light.png`, `33-home-light.png`, `34-drawer-light.png`, `35-folder-light.png`, `36-icon-popup-light.png`, `36-empty-longpress-light.png`, `37-dash-light.png` | light-theme variants |
| `00-playprotect*.png` | (install blocker, not UI) |

### 4.3 Measurements from the dumps (dp = px/3)

**Home / workspace** (`01`, `02`, `33`)
- Icon cells (label included): **66 × 118 dp**, columns at x = 14, 80, 147, 213, 279 (pitch 66.3), row at y = 517 (bottom row of the 5×5 grid). Grid is bottom-aligned above the dock; top rows empty on a fresh install.
- Page indicator band y 636–660 (**24 dp**), hotseat view y 660–760 (**100 dp**), dock cells **66 × 63 dp** at y 668 (icons sit 8 dp below the band top, 29 dp of bottom space + 24 dp nav inset below them).
- Workspace labels: white, 14.33 sp, single line, ellipsised ("Play S…" at 66 dp cell width). Labels stay white in Neo's light theme too (text colour follows wallpaper darkness, not the Neo theme).
- Folder icon (closed): 56 dp disc, background **#3E494A** (dark) / **#F6FAFB** (light), 2 mini icons at ≈ 0.45 scale side by side.

**Drawer** (`04`, `06`, `34`)
- Background **#212121** dark / **#FAFAFA** light (= `grey_50`/`grey_800`-family scrim at 100 %).
- Search container: **348 × 56 dp at (6, 54)**, pill, fill **#424242** / **#E0E0E0**; inside: 48 × 48 provider-logo button at x 10 (search icon in accent **#FF1744**), `EditText` 202 × 48, 44 × 48 clear button, 48 × 48 "Change settings" (⋮) button at x 301.
- List starts at y 94; header 42 dp; cells **67 × 121 dp** (pitch 121 vertically, 66.3 horizontally), 5 columns, first column x 13. Label colour dark **#92999A** (textColorSecondary), ~14 sp.
- Fast-scroller: 32 dp wide strip at the right edge, accent-coloured thumb (visible top-right in `04`).
- Search results: section header "APPS" (22 dp tall, x 37, y 124) then a result row of the same 67 × 121 cells.

**Folder (open)** (`07`, `35`)
- Window ≈ 160 × 146 dp at x 33, y 487 (from the screenshot), background **#3E494A** / **#F6FAFB**, corner radius ≈ 16; cells **74 × 87 dp** at x 39 / 113, y 500; footer: name field "Edit Name" 118 × 23 at (48, 600) + 20 × 20 ⋮ button at x 166 (Neo's folder-customise entry).

**Popups** (`08`, `09`, `36`)
- Icon popup: header pill with two 48 × 48 icon buttons (App info ⓘ, Customize ✎) right-aligned; then rows **216 × 56 dp** ("Widgets" system shortcut with icon; deep shortcuts with 32 dp round avatars and a drag handle "=" on the right); row pitch 58 (2 dp gap); popup left edge 21 dp (anchored over the pressed icon); bg **#252628** dark / **#EEEEEE** light; corner radius ≈ 24 on the outer corners, 4 between rows.
- Empty-space menu: 3 rows 216 × 56, pitch 58, centred on the touch x; items Home settings · Widgets · Wallpapers (icon 24 dp at x +12, text at x +40).

**Widgets sheet** (`10`)
- Full-height sheet bg **#424242**; list inset 8 dp; per-app rows: 48 dp icon at x 40, title 22 dp (16 sp) + subtitle 19 dp (14 sp) at x 104, 24 dp checkbox at x 296, row pitch **90 dp**.

**Dash** (`11`, `37`)
- Bottom sheet, bg **#212121** / **#FFFFFF**, top at ≈ y 575 dp, 8 dp padding, 6-column grid: control tiles span 2 columns (**92 × 53 dp**, e.g. Wi-Fi at x 8–100, Mobile Network 111–203) with 24 dp icon, label and a "›" chevron; action tiles ≈ 50 × 50 with a 24 dp icon; row pitch 61. Active control **#FF1744** (accent) with white content; inactive **#312528** / **#EAE1E6**; icons in accent.

**Settings** (`20`–`37`)
- App bar title "Home settings" 22 dp tall (≈ 22 sp `titleLarge`) at (16, 59); ⋮ overflow top-right.
- Group heading (e.g. "User Interface") 22 dp tall at x 40, y 116; rows are cards **344 × 64 dp** (x 8), pitch **66** (2 dp gap), first/last corners ≈ 24 dp, inner corners ≈ 4 dp; 40 dp tinted circle with a 24 dp Phosphor icon at x 16, title at x 62 (16 sp). Card fill **#3D2429** dark / **#EBD5DD** light (accent-tinted container), icon circle **#51232C** / **#EDC2CD**, accent **#FF1744**, page bg **#212121** / **#FFFFFF**.
- Sub-pages: title 22 dp (16 sp) at x 16, summary 19 dp (14 sp) 22 dp below; switch rows pitch 66, slider rows (title + value "100 %") pitch ≈ 57–66; group heading at x 40.
- Dialogs (Theme, Search engine): title 29 dp (≈ 24 sp), radio rows **48 dp** pitch starting 67 dp below the title, Cancel / OK text buttons bottom-left / bottom-right.
- Gesture picker: 3 tabs (Launcher / Apps / Shortcuts) at y 138, list rows 60 dp pitch with 24 dp icons; items: Do Nothing · Back button · Sleep · Open Dash · Open recents/app drawer · Open Widget Drawer · Open notifications · Open Google Feed · Show Desktop Bubble · Launch Global Search (0.9.3).
- Customize Icons page: 4-column grid of 72 dp shape previews, row pitch ≈ 92; shapes system · circle · square · rounded · squircle · sammy · teardrop · cylinder · cupertino · octagon; below: "Create adaptive icons for icon pack", "Coloured backgrounds".
- Edit Dash: "Enabled" list rows 52 dp pitch, "Tap item to enable" rows 48 dp pitch, 24 dp icons at x 46.
- Hidden App Shortcuts: checkbox rows 64 dp pitch.
- 0.9.3 page contents (for the record, differs from `main`, see §1.9): Profile = Language · Theme · Accent Color · Icon Packs · Icon shape · Blur · Blur Intensity (75 %) · Global corner radius (8 dp); Desktop = Icon size · Hide labels · Multiline · Text Size · Popup menu items · Grid size (5x5) · Add app icons · Allow rotation · Full width widgets · Allow Empty Pages · Widget corner radius (16 dp) · Folder corner radius (Auto) · Folder Columns (4) · Folder Rows (4) · Hide status bar · Lock Desktop; Dock = Dock Hide · Show Background · Background Color · Opacity (90 %) · Dock scale (100 %) · Icon Count (5); Drawer = … · Categorize Apps · Second Tab for Work Apps · Row height · Remember Position · Hidden App Shortcuts · Turn on protected apps · Protected Apps · custom background · Opacity; Widgets = Show Smartspace · Show Date · Show Time · Show Large Clock · 24-Hour · Show Pill Search Shortcut · Weather source (Google app) · Temperature unit · Events sources · Notification dots · Count · custom colour; Search = Search engine (App search) · Voice button · Open Assistant · Web results · Find hidden apps · Search Contacts · Fuzzy Search · Corner Radius (Auto) · Drawer search bar · Dock search bar · Feed Provider (None); Gestures = the 8 slots (no pinch) + Dash line size (6) + Edit Dash; Backups = Create / Restore tabs; About = version card, Source Code / Channel / Community links, team, contributors, License, Changelog.

### 4.4 Not captured
- Animations could not be timed on-device (no frame-accurate recording in this pass); §3 values are from source.
- Paged/horizontal/tab/category drawer layouts: not present in 0.9.3; `main` has them but is not buildable as a release here.
- Smartspace row (off by default) and the dock search bar (off by default) were left at defaults.

---

## 5. Usability / interaction model (what the clone must do identically)

### 5.1 Home screen
- **Tap icon** → press scale 1.1 (200 ms), launch; haptic none (system click sound only).
- **Tap folder** → opens (cover mode: launches the first app).
- **Long-press icon (300 ms)** → haptic LONG_PRESS, popup with: deep shortcuts (app-provided), then system shortcuts row: **App info**, **Widgets** (if the app has widgets), **Customize** (Neo), **Uninstall** (if enabled & uninstallable); a *notification* section appears above the shortcuts when the app has notifications (Launcher3 `NotificationContainer`, 104 dp). Keep holding and move 16 dp → popup closes into a pre-drag and the icon lifts (`DragView`, drag shadow with 4 dp click shadow), workspace enters SPRING_LOADED (150 ms), drop target bar slides in at the top (Remove / Uninstall). Hover 650 ms over an occupied cell → reorder preview; hover over another icon → folder-accept ring (×1.2); drag to the screen edge → page scroll after a hold; drop → settles 100–500 ms; exit spring-loaded 500 ms after drop.
- **Long-press empty space (400 ms)** → haptic, `OptionsPopupView` anchored at the touch point (Wallpaper & style · Widgets · Edit Home Screen · Set as Home Screen · Apps list · Home settings, filtered by the Profile pref). Remappable (`gestureLongPress`).
- **Double tap** → Dash sheet (remappable).
- **Pinch in** → Edit mode (shrunken pages, page add "+", pages reorderable); pinch out → nothing (remappable).
- **Swipe up anywhere** (not over dock) → drawer follows the finger; release past 60 % or fling → opens with the spring settle; otherwise snaps back 200 ms. **Swipe up over dock** → Launch Global Search (drawer open with the search field focused) in `main`; in 0.9.3 simply opens the drawer.
- **Swipe down** → open notification shade (velocity > 2.25 px/ms).
- **Horizontal swipe** → page change with the thresholds of §3.1; over-scroll damped at the ends unless Cycle Scrolling.
- **Back** → closes any open floating view (popup, folder, sheet) first; then the drawer; then (NORMAL) runs the Back-button gesture handler if set.
- **Home** → returns to the default page (`desktopDefaultPage`) and NORMAL state; if already there, runs the Home-press handler.
- **Drag from drawer to home** → long-press an app in the drawer (300 ms) → popup; drag → the drawer closes into SPRING_LOADED on the workspace and the item is placed on drop.
- **Widgets** (Android only): long-press → Widgets sheet → long-press a preview → drag onto the workspace → resize frame.

### 5.2 Drawer
- Opens in state ALL_APPS: workspace+hotseat fade out at 33 %/40 % of the travel and scale to 0.97; the sheet background (scrim colour) fades in from 26 %/12 %.
- Search field at the top is **not** focused automatically; tap → keyboard. Typing filters live (prefix/word match or fuzzy), shows web suggestions (5) and a "search web" row; ✕ clears and hides the IME; IME action "Search" runs the first result / web search. Back with keyboard up: closes keyboard first, then the drawer.
- Vertical layout: scroll with momentum; fast-scroller thumb on the right with a letter bubble; section letters (A–Z rail) tap-to-jump. Scroll position resets to top on close unless *Remember Position*.
- Horizontal layout: pages of 5×N, dots at the bottom.
- Tabs layout: tap tab or swipe horizontally between tabs; the tab pill highlights with the accent.
- Categories layout: tap a category in the left rail → list filters; "All apps" first.
- Long-press an app → popup (App info, Customize, Uninstall per pref) or drag out to the home screen.
- Protected app tap → biometric/credential prompt before launch.

### 5.3 Folders
- Open: window grows from the folder icon (200 ms STANDARD), items fly from their preview positions; footer shows the name (tap to edit inline, Enter to commit; empty name shows "Unnamed Folder" hint). Swipe horizontally to page when > rows×cols items. Drag an item out and hold → folder closes after 400 ms and spring-loaded continues on the workspace. Tap outside / back → close (reverse animation).
- Folder icon long-press → popup with **Customize** (rename, pick icon, Cover mode switch) and Remove via drag.

### 5.4 Dash
- Opens as a bottom sheet (267 ms) over a dimmed home; tiles toggle instantly (state colour swap); extendable controls open system settings; drag down or tap the scrim to dismiss.

### 5.5 Settings
- Launched from the popup ("Home settings"), the Dash, or the Open Launcher Settings gesture. Material 3 list/detail; changes apply immediately (most prefs call `reloadGrid()` / `recreate()` — grid changes rebuild the workspace, theme changes recreate the activity). Sliders show the value live. Multi-select rows open a dialog with checkboxes; selection rows open a radio dialog; colour rows navigate to a full page.

### 5.6 Haptics (Android `VibratorWrapper` / MSDL)
- Long press (icon or workspace): `HapticFeedbackConstants.LONG_PRESS` / `MSDLToken.LONG_PRESS`.
- Pinch gesture trigger: `VibrationEffect.EFFECT_CLICK` (`OVERVIEW_HAPTIC`).
- Drawer swipe crossing the commit threshold: `MSDLToken.SWIPE_THRESHOLD_INDICATOR`.
- Drag over a new cell / reorder: `MSDLToken.DRAG_INDICATOR_DISCRETE`; `CLOCK_TICK` for discrete steps; `TAP_HIGH_EMPHASIS` for drop-target hits.
- GNOME: map to the Shell's feedback API where present (feedbackd `event` names: `button-pressed`, `window-close`…).

---

## 6. What could not be determined from source / open questions

- Exact `calculateTextHeight` results depend on the device font; numbers above assume Roboto (≈1.33 ×). Measure on the device (§4).
- Compose `PreferenceItem` has no fixed height (M3 `ListItem`, ≈ 72 dp with summary / 56 dp without); measure from the settings screenshots.
- The Material-3 dynamic colour scheme (`dynamicColorScheme` from the *material-kolor* library, `PaletteStyle.Fidelity`) needs a port for exact colours; the static fallback palette is in §1.8.
- 0.9.3 ships only the vertical drawer; the Horizontal / Tabs / Categories layouts of `main` could not be screenshotted.
- `main` is a moving target (2146 commits past 0.9.3, several `TODO fix this`); the released 0.9.3 is what the screenshots show. Where they conflict, prefer `main` for structure and 0.9.3 for pixel references.
