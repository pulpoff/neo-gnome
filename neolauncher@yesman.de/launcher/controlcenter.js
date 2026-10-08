// MIUI-style Control Center inside the shell's quick settings menu.
//
// The shell's menu stays the container: its swipe-down drag, open/close animation, notification list and
// the toggles' own detail menus (Wi-Fi networks, Bluetooth devices...) keep working. Its status-bar clone
// and toggle grid are hidden and this panel takes their place: operator + status icons, a big clock with
// the date, four large tiles (mobile data, Wi-Fi, Bluetooth, USB), round toggles four to a row, and pill
// sliders for brightness and volume. Every control drives the shell's own toggle object (or slider), so
// state and behaviour are the shell's; nothing here talks to NetworkManager or BlueZ itself.
//
// The grid is kept in the layout (zero height, invisible, so it takes no input): the shell places a
// toggle's detail menu from the grid's position, and the menus open over the dimmed panel from there.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const here = import.meta.url.replace(/\/[^/]*$/, '');
const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const {firstDelta} = await import(`${here}/gesture.js?gen=${gen}`);
const {readInt, findFlashLed} = await import(`${here}/util.js?gen=${gen}`);

const TILE_PAD = 16, CORNER = 30;                         // .neo-cc-tile padding-left; the corner mark's touch area
const asset = name => Gio.FileIcon.new(Gio.File.new_for_uri(`${here}/../assets/${name}`.replace(/\?.*$/, '')));

const qs = () => Main.panel.statusArea?.quickSettings;
const item = key => qs()?.[key]?.quickSettingsItems?.[0] ?? null;
const nmItem = cls => qs()?._network?.quickSettingsItems?.find(i => i.constructor.name === cls) ?? null;

/**
 * Geometry from the screen's short side, so a tile, a toggle and a pill are the same size in both
 * orientations: portrait is one column, landscape puts two of those columns side by side (tiles left,
 * toggles and sliders right), centred, instead of stretching them to the wider screen.
 */
function metrics() {
    const mon = Main.layoutManager.primaryMonitor;
    const landscape = mon.width > mon.height;
    const short = Math.min(mon.width, mon.height);
    const side = Math.round(short * 0.075);                              // 27 at 360: MIUI's 80/1080
    const colW = short - 2 * side;
    const gap = Math.round(colW * 0.046);                                // 14 at 306
    const tileW = Math.floor((colW - gap) / 2);
    const round = Math.min(62, Math.floor((colW - 3 * 18) / 4));
    return {mon, landscape, side, colW, gap, tileW, tileH: Math.round(tileW * 0.515), round,
        roundGap: Math.floor((colW - 4 * round) / 3), pillH: Math.round(round * 0.95),
        colGap: landscape ? Math.min(64, mon.width - 2 * colW - 2 * side) : 0};
}

/** A large tile: icon, title and subtitle; filled blue when on. `src` is a shell QuickToggle, or a provider. */
class Tile {
    constructor(cc, p) {
        this.p = p;
        this.actor = new St.Button({style_class: 'neo-cc-tile', can_focus: true, x_expand: false});
        const row = new St.BoxLayout({style_class: 'neo-cc-tile-row', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._icon = new St.Icon({style_class: 'neo-cc-tile-icon', y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._title = new St.Label({style_class: 'neo-cc-tile-title'});
        this._sub = new St.Label({style_class: 'neo-cc-tile-sub'});
        for (const l of [this._title, this._sub]) l.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        text.add_child(this._title); text.add_child(this._sub);
        row.add_child(this._icon); row.add_child(text);
        this._row = row;
        const stack = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this._stack = stack;
        stack.add_child(row);
        // the corner mark: "this tile has details"; a tap on it (or a long press anywhere) opens them
        if (p.hasMenu?.()) {
            this._corner = new St.Button({style_class: 'neo-cc-tile-corner', width: CORNER, height: CORNER, child: new St.Widget({style_class: 'neo-cc-tile-mark', x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END})});
            this._corner.connect('clicked', () => p.openMenu());
            stack.add_child(this._corner);
            const lp = new Clutter.LongPressGesture({long_press_duration_ms: 400});
            lp.connect('recognize', () => p.openMenu());
            this.actor.add_action(lp);
        }
        this.actor.set_child(stack);
        this.actor.connect('clicked', () => p.activate());
        this._ids = p.watch?.(() => this.sync()) ?? [];
        this.sync();
    }
    sync() {
        const p = this.p;
        this.actor.visible = p.available();
        if (!this.actor.visible) return;
        const on = !!p.checked();
        this._title.text = p.title() ?? '';
        const sub = p.subtitle();
        this._sub.text = sub || (on ? 'On' : 'Off');
        const g = p.gicon?.(); if (g) this._icon.gicon = g; else this._icon.icon_name = p.icon();
        if (on) this.actor.add_style_pseudo_class('checked'); else this.actor.remove_style_pseudo_class('checked');
    }
    setSize(w, h) {
        this.actor.set_size(w, h);
        const inner = w - TILE_PAD;                      // the button's left padding
        this._stack.set_size(inner, h);
        this._row.set_size(inner - 8, h);
        this._corner?.set_position(inner - CORNER, h - CORNER);
    }
    destroy() { for (const [o, id] of this._ids) { try { o.disconnect(id); } catch (_) {} } this.actor.destroy(); }
}

/** A round toggle: icon only, filled blue when on. */
class Round {
    constructor(cc, p) {
        this.p = p;
        this._icon = new St.Icon({style_class: 'neo-cc-round-icon'});
        this.actor = new St.Button({style_class: 'neo-cc-round', can_focus: true, child: this._icon, accessible_name: p.title()});
        this.actor.connect('clicked', () => p.activate());
        this._ids = p.watch?.(() => this.sync()) ?? [];
        this.sync();
    }
    sync() {
        const p = this.p;
        this.actor.visible = p.available();
        if (!this.actor.visible) return;
        const g = p.gicon?.(); if (g) this._icon.gicon = g; else this._icon.icon_name = p.icon();
        if (p.checked()) this.actor.add_style_pseudo_class('checked'); else this.actor.remove_style_pseudo_class('checked');
    }
    setSize(d) { this.actor.set_size(d, d); this._icon.icon_size = Math.round(d * 0.4); }
    destroy() { for (const [o, id] of this._ids) { try { o.disconnect(id); } catch (_) {} } this.actor.destroy(); }
}

/** A pill slider (MIUI's brightness bar): a white fill from the left, dragged relative to where it was. */
class Pill {
    constructor(slider, iconName) {
        this._slider = slider;
        this.actor = new St.Widget({style_class: 'neo-cc-pill', reactive: true, layout_manager: new Clutter.FixedLayout(), clip_to_allocation: true});
        // The white fill is drawn, clipped to the pill's own rounded outline: it fills the grey shape at every
        // value (St does not clip children to a parent's rounded corners, and a widget with its own radius showed
        // a round end inside the pill, and a sharp sliver at the left edge near zero).
        this._fill = new St.DrawingArea();
        this._fill.connect('repaint', area => {
            const cr = area.get_context(), [W, H] = area.get_surface_size(), r = H / 2;
            cr.newSubPath();
            cr.arc(r, r, r, Math.PI / 2, 3 * Math.PI / 2);
            cr.arc(W - r, r, r, 3 * Math.PI / 2, Math.PI / 2);
            cr.closePath();
            cr.clip();
            cr.rectangle(0, 0, Math.round(this._slider.value * W), H);
            cr.setSourceRGBA(1, 1, 1, 0.96);
            cr.fill();
            cr.$dispose();
        });
        this._icon = new St.Icon({style_class: 'neo-cc-pill-icon', icon_name: iconName});
        this.actor.add_child(this._fill); this.actor.add_child(this._icon);
        const pan = new Clutter.PanGesture({pan_axis: Clutter.PanAxis.X});
        let v0 = 0;
        pan.connect('recognize', () => { v0 = this._slider.value; });
        pan.connect('pan-update', g => { this._set(v0 + firstDelta(g)[0] / Math.max(1, this.actor.width)); });
        this.actor.add_action(pan);
        const click = new Clutter.ClickGesture();
        click.connect('recognize', g => { const [ax] = this.actor.get_transformed_position(); this._set((g.get_point_coords_abs(0).x - ax) / Math.max(1, this.actor.width)); });
        this.actor.add_action(click);
        this._id = slider.connect('notify::value', () => this._draw());
    }
    _set(v) { this._slider.value = Math.max(0, Math.min(1, v)); }
    setIcon(name) { this._icon.icon_name = name; }
    setSize(w, h) {
        this.actor.set_size(w, h); this._fill.set_size(w, h);
        const s = Math.round(h * 0.38); this._icon.icon_size = s; this._icon.set_position(Math.round(h * 0.5), Math.round((h - s) / 2));
        this._draw();
    }
    _draw() { this._fill.queue_repaint(); }
    destroy() { this._slider.disconnect(this._id); this.actor.destroy(); }
}

/** A provider over a shell QuickToggle. */
function fromToggle(get, extra = {}) {
    return {
        available: () => !!get()?.visible,
        checked: () => !!get()?.checked,
        title: () => extra.label ?? get()?.title,
        subtitle: () => get()?.subtitle,
        icon: () => get()?.icon_name,
        gicon: () => (get()?.icon_name ? null : get()?.gicon),
        activate: () => get()?.emit('clicked', 1),
        hasMenu: () => !!get()?.menu,
        openMenu: () => get()?.menu?.open(true),
        watch: cb => { const t = get(); return t ? ['checked', 'title', 'subtitle', 'icon-name', 'gicon', 'visible'].map(p => [t, t.connect(`notify::${p}`, cb)]) : []; },
        ...extra,
    };
}

export class ControlCenter {
    constructor(home) {
        this.home = home;
        this._menu = qs()?.menu;
        this._inner = this._menu?.box?.get_children().find(c => c.has_style_class_name?.('inner-box')) ?? null;
        if (!this._inner) throw new Error('quick settings menu layout not found');
        this._clone = this._inner.get_children().find(c => c.has_style_class_name?.('panel-clone'));
        this._grid = this._menu._grid;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._boxStyle = this._menu.box.style;            // the shell's own inline style, given back on destroy

        // a panel an earlier instance left behind (one that failed half way, before a reload)
        for (const c of this._inner.get_children()) if (c.has_style_class_name?.('neo-cc')) c.destroy();
        this.actor = new St.BoxLayout({style_class: 'neo-cc', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        // Painted once into a texture and reused while the menu slides (the pull): a pull went from ~50 to
        // ~85 fps. Only a change inside the panel (the clock each second, a toggle) paints it again.
        this.actor.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        this._inner.insert_child_at_index(this.actor, 0);
        // the shell's grid: moved under the panel's status row, zero height and invisible, still the menus' anchor
        this._clone?.hide();
        this._inner.remove_child(this._grid);
        this._grid.set({opacity: 0, height: 0, style: 'padding: 0; margin: 0;'});     // its own padding kept 33 px
        this._menu.box.add_style_class_name('neo-cc-box');
        try { this._build(); } catch (e) { this.destroy(); throw e; }
        // Which half of the top edge the pull started from (Android/MIUI): the left opens the controls, the
        // right only the notifications. The touch that starts the shell's pull is seen here first.
        this._press = null;
        this._pressId = global.stage.connect('captured-event', (st, ev) => {
            const t = ev.type();
            if (t === Clutter.EventType.TOUCH_BEGIN || t === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = ev.get_coords();
                this._press = {x, y, time: GLib.get_monotonic_time()};
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // The pull: the shell opens the menu at once (fully visible) and slides its box down under the finger.
        // The backdrop and the panel follow that slide instead of appearing at once (the screen went to a flat
        // colour first, then the panel came down over it).
        this._slideId = this._menu.box.connect('notify::translation-y', () => this._syncProgress());
        this._openId = this._menu.connect('open-state-changed', (m, open) => {
            Main.layoutManager.panelBox.ease({opacity: open ? 0 : 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            if (open) this._onOpen(); else this._stopClock();
        });
        // A rotation only marks the panel stale: rebuilding it (and blurring a new backdrop) at once made every
        // rotation slow, open or not. It is rebuilt when it next opens (or now, if it is open).
        this._monId = Main.layoutManager.connect('monitors-changed', () => { if (this._menu.isOpen) this._build(); else this._stale = true; });
        this._schemeId = this._iface.connect('changed::color-scheme', () => this._applyScheme());
        this._applyScheme();
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._stopClock();
        Main.layoutManager.panelBox.remove_all_transitions(); Main.layoutManager.panelBox.opacity = 255;
        this._backdrop?.destroy(); this._backdrop = null;
        if (this._wallId) { this._wallMgr?.disconnect(this._wallId); this._wallId = 0; }
        if (this._openId) this._menu.disconnect(this._openId);
        if (this._slideId) { this._menu.box.disconnect(this._slideId); this._slideId = 0; }
        if (this._pressId) { global.stage.disconnect(this._pressId); this._pressId = 0; }
        if (this._menu._messageList) this._menu._messageList.visible = true;
        if (this._monId) Main.layoutManager.disconnect(this._monId);
        if (this._schemeId) this._iface.disconnect(this._schemeId);
        this._openId = this._monId = this._schemeId = 0;
        this._clear();
        this.actor.destroy();
        // the grid goes back where the shell had it: after the status-bar clone
        if (!this._grid.get_parent()) {
            if (this._clone) this._inner.insert_child_above(this._grid, this._clone); else this._inner.insert_child_at_index(this._grid, 0);
        }
        this._clone?.show();
        this._grid.set({opacity: 255, height: -1, style: null});
        this._menu.box.style = this._boxStyle;
        for (const c of ['neo-cc-box', 'neo-cc-light']) this._menu.box.remove_style_class_name(c);
    }

    /**
     * The backdrop: the wallpaper, blurred, over the whole screen. A background-mode blur of whatever is under
     * the menu did not show at all; a blurred copy of the wallpaper is a static image, blurred once. The copy
     * is made again whenever the layout is built: the launcher replaces its wallpaper actor on every rotation
     * and wallpaper change, and a clone of the old one draws nothing.
     *
     * The blurred clone sits in a wrapper and only the wrapper fades with the menu: an opacity change on the
     * blurred actor itself marks it dirty and the whole screen was blurred again on every frame of the pull.
     */
    _makeBackdrop() {
        this._backdrop?.destroy(); this._backdrop = null; this._blurred = null;
        const m = this._m ?? metrics();
        const light = this._iface.get_string('color-scheme') !== 'prefer-dark';
        // never transparent: an opaque colour under the blurred wallpaper, in case the copy draws nothing
        const solid = light ? '#5c5e62' : '#101214';
        const wall = this.home._bgManager?.backgroundActor;
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 90, brightness: light ? 0.7 : 0.4});
        this._backdrop = new St.Widget({reactive: false, x: 0, y: 0, width: m.mon.width, height: m.mon.height, style: `background-color: ${solid};`});
        if (wall) {
            this._blurred = new Clutter.Clone({source: wall, reactive: false, x: 0, y: 0, width: m.mon.width, height: m.mon.height});
            this._blurred.add_effect(this._blur);
            this._backdrop.add_child(this._blurred);
        }
        this._menu.actor.insert_child_below(this._backdrop, this._menu._boxPointer);
        this._syncProgress();
        // the wallpaper actor is replaced when the wallpaper changes (a light/dark switch swaps the picture)
        if (this._wallId) this._wallMgr?.disconnect(this._wallId);
        this._wallMgr = this.home._bgManager;
        this._wallId = this._wallMgr?.connect?.('changed', () => this._makeBackdrop()) ?? 0;
    }

    /** How far the pull has come, 0 (just started) to 1 (fully down), from the box's slide. */
    _syncProgress() {
        const box = this._menu.box;
        const h = this._menu._panHeight || box.height || Main.layoutManager.primaryMonitor.height;
        const t = Math.max(0, Math.min(1, 1 + box.translation_y / h));
        if (this._backdrop) this._backdrop.opacity = Math.round(255 * Math.min(1, t * 1.6));   // full a bit before the end
        this.actor.opacity = Math.round(255 * Math.min(1, t * 1.25));
    }

    _applyScheme() {
        const light = this._iface.get_string('color-scheme') !== 'prefer-dark';
        if (light) this._menu.box.add_style_class_name('neo-cc-light'); else this._menu.box.remove_style_class_name('neo-cc-light');
        if (this._blur) this._blur.brightness = light ? 0.7 : 0.4;
    }

    _clear() {
        // the shell's grid lives inside this panel while it is up: take it out before clearing
        if (this._grid.get_parent() && this._grid.get_parent() !== this._inner) this._grid.get_parent().remove_child(this._grid);
        for (const w of this._widgets ?? []) w.destroy();
        this._widgets = [];
        this.actor.destroy_all_children();
    }

    // ---------------- providers ----------------
    _providers() {
        const home = this.home;
        const close = () => this._menu.close(false);
        const usb = home.usbMode;
        const flash = findFlashLed();                    // null: no torch LED, the tile stays hidden
        const flashMax = flash ? readInt(`${flash}/max_brightness`) : NaN;
        const touch = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.peripherals.touchscreen'});
        return {
            tiles: [
                fromToggle(() => nmItem('NMModemToggle'), {label: 'Mobile data'}),
                fromToggle(() => nmItem('NMWirelessToggle')),
                fromToggle(() => item('_bluetooth')),
                {   // USB: what a connected computer may use (launcher/usbmode.js)
                    available: () => !!usb?.available,
                    checked: () => !!usb?.connected,
                    title: () => 'USB',
                    subtitle: () => usb?.connected ? usb.modeTitle() : 'Not connected',
                    icon: () => 'drive-removable-media-symbolic',
                    activate: () => { close(); usb.showChooser(); },
                    hasMenu: () => false,
                    watch: cb => usb ? [[usb, usb.connect('changed', cb)]] : [],
                },
            ],
            rounds: [
                {   // the camera flash LED as a torch
                    available: () => Number.isFinite(flashMax),
                    checked: () => readInt(`${flash}/brightness`) > 0,
                    pollOnOpen: true,                   // sysfs sends no change signal: read again on every open
                    title: () => 'Flashlight', icon: () => null, gicon: () => asset('cc-flashlight-symbolic.svg'),
                    activate: () => {
                        const on = readInt(`${flash}/brightness`) > 0;
                        // in place: sysfs takes no temporary file (file_set_contents' default), and the udev rule
                        // gnome/device/poco-tuning/90-flashlight.rules makes it writable for the session user
                        try {
                            GLib.file_set_contents_full(`${flash}/brightness`, String(on ? 0 : Math.max(1, Math.round(flashMax / 4))), GLib.FileSetContentsFlags.NONE, 0o666);
                        } catch (e) { Main.notifyError('Flashlight', e.message); }
                        this._syncAll();
                    },
                },
                fromToggle(() => item('_doNotDisturb')),
                {   // screenshot: the shell's own UI, once the menu is out of the way
                    available: () => !!Main.screenshotUI, checked: () => false,
                    title: () => 'Screenshot', icon: () => 'screenshot-recorded-symbolic',
                    activate: () => { close(); GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => { Main.screenshotUI.open().catch(e => logError(e)); return GLib.SOURCE_REMOVE; }); },
                },
                fromToggle(() => item('_rfkill')),
                {
                    available: () => true, checked: () => false,
                    title: () => 'Lock', icon: () => 'system-lock-screen-symbolic',
                    activate: () => { close(); Main.screenShield.lock(true); },
                },
                fromToggle(() => item('_nightLight')),
                {   // auto-rotate: the setting itself, so it is there with a keyboard attached too
                    available: () => true,
                    checked: () => !touch.get_boolean('orientation-lock'),
                    title: () => 'Auto rotate', icon: () => touch.get_boolean('orientation-lock') ? 'rotation-locked-symbolic' : 'rotation-allowed-symbolic',
                    activate: () => touch.set_boolean('orientation-lock', !touch.get_boolean('orientation-lock')),
                    watch: cb => [[touch, touch.connect('changed::orientation-lock', cb)]],
                },
                fromToggle(() => item('_darkMode')),
            ],
        };
    }

    // ---------------- layout ----------------
    _build() {
        this._clear();
        this._sizes = {};                          // a new layout: measure again
        const m = metrics();
        this._m = m;
        this._makeBackdrop();
        const p = this._providers();
        this.actor.style = `padding: 0 ${m.side}px;`;
        if (m.landscape) this.actor.add_style_class_name('neo-cc-landscape'); else this.actor.remove_style_class_name('neo-cc-landscape');
        // no forced height: the backdrop is its own full-screen layer, and the shell's pull slides the box in
        // from its bottom edge, so a full-screen box showed its empty lower part first (the clock came last)
        this._menu.box.style = this._boxStyle;

        // status row: operator on the left, the panel's status icons on the right
        // MIUI's status row: the operator where the clock was, the status icons at the right. The menu is
        // stacked above the real status bar, which is hidden while the Control Center is open (it showed
        // through the translucent backdrop, doubled).
        const status = new St.BoxLayout({style_class: 'neo-cc-status', x_expand: true, height: Main.panel.height});
        this._operator = new St.Label({style_class: 'neo-cc-operator', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        status.add_child(this._operator);
        status.add_child(new Clutter.Clone({source: Main.panel._rightBox, height: Main.panel._rightBox.height, y_align: Clutter.ActorAlign.CENTER}));
        this.actor.add_child(status);
        this.actor.add_child(this._grid);

        // clock row: the time, the date beside it, settings and edit at the right
        const clock = new St.BoxLayout({style_class: 'neo-cc-clock-row', x_expand: true});
        this._time = new St.Label({style_class: 'neo-cc-time', y_align: Clutter.ActorAlign.END});
        this._date = new St.Label({style_class: 'neo-cc-date', y_align: Clutter.ActorAlign.END, x_expand: true});
        clock.add_child(this._time); clock.add_child(this._date);
        const btn = (icon, cb) => { const b = new St.Button({style_class: 'neo-cc-head-button', y_align: Clutter.ActorAlign.CENTER, child: new St.Icon({icon_name: icon})}); b.connect('clicked', cb); return b; };
        clock.add_child(btn('emblem-system-symbolic', () => { this._menu.close(false); this._launch('org.gnome.Settings.desktop'); }));
        // power: the menu a long press of the power key opens (suspend / restart / power off), over this panel
        // (SystemActions' power-off dialog does nothing on the phone)
        clock.add_child(btn('system-shutdown-symbolic', () => Main.powerManager?._showInteractivePowerMenu?.()));

        // tiles 2×2
        const tiles = new St.Widget({layout_manager: new Clutter.GridLayout({column_spacing: m.gap, row_spacing: m.gap}), style_class: 'neo-cc-tiles'});
        p.tiles.forEach((prov, i) => {
            const t = new Tile(this, prov); t.setSize(m.tileW, m.tileH);
            tiles.layout_manager.attach(t.actor, i % 2, Math.floor(i / 2), 1, 1);
            this._widgets.push(t);
        });

        // round toggles, four to a row
        const rounds = new St.Widget({layout_manager: new Clutter.GridLayout({column_spacing: m.roundGap, row_spacing: Math.round(m.roundGap * (m.landscape ? 0.6 : 0.95))}), style_class: 'neo-cc-rounds'});
        let n = 0;
        for (const prov of p.rounds) {
            if (!prov.available()) continue;
            const r = new Round(this, prov); r.setSize(m.round);
            rounds.layout_manager.attach(r.actor, n % 4, Math.floor(n / 4), 1, 1); n++;
            this._widgets.push(r);
        }

        // sliders: brightness, then volume
        const sliders = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'neo-cc-sliders'});
        const bright = item('_brightness');
        if (bright?.slider && bright.visible) { const s = new Pill(bright.slider, 'display-brightness-symbolic'); s.setSize(m.colW, m.pillH); sliders.add_child(s.actor); this._widgets.push(s); }
        const vol = item('_volumeOutput');
        if (vol?.slider) {
            const s = new Pill(vol.slider, 'audio-volume-high-symbolic'); s.setSize(m.colW, m.pillH);
            const icon = () => s.setIcon(vol.slider.value <= 0 ? 'audio-volume-muted-symbolic' : vol.slider.value < 0.34 ? 'audio-volume-low-symbolic' : vol.slider.value < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic');
            const id = vol.slider.connect('notify::value', icon); icon();
            this._widgets.push({destroy: () => vol.slider.disconnect(id)});
            sliders.add_child(s.actor); this._widgets.push(s);
        }

        if (m.landscape) {
            const cols = new St.BoxLayout({style_class: 'neo-cc-columns', x_expand: true, x_align: Clutter.ActorAlign.CENTER, style: `spacing: ${m.colGap}px;`});
            const left = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, width: m.colW});
            const right = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, width: m.colW});
            left.add_child(clock); left.add_child(tiles);
            right.add_child(rounds); right.add_child(sliders);
            cols.add_child(left); cols.add_child(right);
            this.actor.add_child(cols);
            this._controlParts = [tiles, right];
        } else {
            this._controlParts = [tiles, rounds, sliders];
            this.actor.add_child(clock);
            this.actor.add_child(tiles);
            this.actor.add_child(rounds);
            this.actor.add_child(sliders);
        }
        this._syncHeader();
        this._setMode(this._mode ?? 'controls');
    }

    /** 'controls': the Control Center, no notifications under it. 'notifications': the clock and the
     *  notification list only (the shell's message list, which the controls view hides). */
    _setMode(mode) {
        this._mode = mode;
        const controls = mode === 'controls';
        for (const p of this._controlParts ?? []) p.visible = controls;
        if (this._menu._messageList) this._menu._messageList.visible = !controls;
        this._fixSize();
    }

    /**
     * A fixed size for the panel, measured once per layout and view. Opening the menu positions its box
     * pointer, which asks the whole content for its size; the hidden toggles change while the menu is closed
     * (Wi-Fi strength...) and drop every cached size, so each open measured all of it again: ~80 ms before
     * the first frame. With a fixed size Clutter answers without asking the children.
     */
    _fixSize() {
        this._sizes ??= {};
        const key = `${this._mode}:${this._m?.mon.width}x${this._m?.mon.height}`;
        if (this._sizes[key]) { this.actor.set_size(...this._sizes[key]); return; }
        // Not known yet: lay out freely once and keep what it really took (a size asked for up front came out
        // short and cut the sliders off).
        this.actor.set_size(-1, -1);
        if (this._sizeId) this.actor.disconnect(this._sizeId);
        this._sizeId = this.actor.connect('notify::allocation', () => {
            const box = this.actor.get_allocation_box(), w = Math.round(box.get_width()), h = Math.round(box.get_height());
            if (w < 10 || h < 10 || this._mode !== key.split(':')[0]) return;
            this.actor.disconnect(this._sizeId); this._sizeId = 0;
            this._sizes[key] = [w, h];
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { if (`${this._mode}:${this._m?.mon.width}x${this._m?.mon.height}` === key) this.actor.set_size(w, h); return GLib.SOURCE_REMOVE; });
        });
    }

    _launch(id) {
        try {
            const info = Gio.DesktopAppInfo.new(id);
            info?.launch([], global.create_app_launch_context(global.get_current_time(), -1));
            Main.overview.hide();
        } catch (e) { logError(e); }
    }

    _syncAll() { for (const w of this._widgets) w.sync?.(); }

    _syncHeader() {
        const now = GLib.DateTime.new_now_local();
        const clock = this._iface.get_string('clock-format');
        this._time.text = now.format(clock === '12h' ? '%l:%M' : '%H:%M').trim();
        this._date.text = now.format('%a, %b %-d');
        const modem = nmItem('NMModemToggle');
        this._operator.text = (modem?.visible && modem.subtitle) ? modem.subtitle : '';
    }

    _onOpen() {
        if (this._stale) { this._stale = false; this._build(); }
        // a pull that started on the right half of the top edge (within the last second) shows notifications
        const p = this._press, screen = Main.layoutManager.primaryMonitor;
        const fromTop = p && (GLib.get_monotonic_time() - p.time) < 1500000 && p.y < Main.panel.height * 2;
        this._setMode(fromTop && p.x >= screen.x + screen.width / 2 ? 'notifications' : 'controls');
        // the wallpaper actor may have been replaced since the backdrop was made (rotation, a light/dark swap)
        const wall = this.home._bgManager?.backgroundActor, mon = Main.layoutManager.primaryMonitor;
        if (!this._backdrop || this._blurred?.source !== wall || this._backdrop.width !== mon.width || this._backdrop.height !== mon.height)
            this._makeBackdrop();
        // the toggles follow their own signals; only providers without one (the flashlight's sysfs) are read here
        for (const w of this._widgets ?? []) if (w.p?.pollOnOpen) w.sync?.();
        this._syncHeader();
        this._stopClock();
        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => { this._syncHeader(); return GLib.SOURCE_CONTINUE; });
    }
    _stopClock() { if (this._clockId) { GLib.source_remove(this._clockId); this._clockId = 0; } }
}
