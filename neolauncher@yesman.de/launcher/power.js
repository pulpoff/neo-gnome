// Power button and power menu on the phone.
//
// 1. The mobile shell opens the quick-settings power submenu after a 2000 ms hold of the power
//    key (powerManager.powerButtonEvent); Android phones show theirs after about a second, so
//    the hold is shortened to `power-hold-ms`.
// 2. The shell decides whether Power Off / Restart are offered by asking gnome-session's
//    CanShutdown, expecting a boolean. The gnome-session on this image (49 snapshot) answers
//    with an enum, the proxy call fails on the type, and the shell hides both entries although
//    logind (and the polkit rule in /etc/polkit-1/rules.d/50-phone-power.rules) allow them.
//    Whoever holds a phone's power button may turn it off, so the question is put to logind.
//    Both of these, and Restart / Power Off going straight to logind, apply on the mobile shell only
//    (layoutManager.is_phone): on a desktop gnome-session's end-session dialog and inhibitors stay.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const here = import.meta.url.replace(/\/[^/]*$/, '');
const {dbusCall, isPhone} = await import(`${here}/util.js?gen=${gen}`);

/** A logind Can* answer, asynchronously: a blocking call here stalled the compositor for up to its timeout. */
async function login1(method) {
    const [r] = await dbusCall(Gio.DBus.system, 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', method, null, 2000);
    return r;
}

/** Power off / restart through logind (the menu entry is the confirmation, as on Android). */
function logindAction(method) {
    Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', method,
        new GLib.Variant('(b)', [true]), null, Gio.DBusCallFlags.NONE, -1, null,
        (c, r) => { try { c.call_finish(r); } catch (e) { Main.notifyError(method === 'Reboot' ? 'Restart' : 'Power off', e.message); } });
}

/**
 * Android's power menu: the screen dims and a card offers Power off, Restart and Suspend, nothing else. The
 * shell's own opened its quick-settings menu (the pull-down, with its notifications) to show a submenu.
 */
let dialog = null;
export function showPowerDialog() {
    if (dialog) return;
    Main.panel.statusArea?.quickSettings?.menu?.close(false);
    const dlg = new ModalDialog.ModalDialog({styleClass: 'neo-power-dialog', destroyOnClose: true});
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'neo-power-list'});
    const entry = (icon, label, run) => {
        // left-aligned rows: the icons line up in one column (centred, each sat at its own label's offset)
        const row = new St.BoxLayout({style_class: 'neo-power-row', x_expand: true, x_align: Clutter.ActorAlign.START});
        row.add_child(new St.Icon({icon_name: icon, style_class: 'neo-power-icon', y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(new St.Label({text: label, style_class: 'neo-power-label', y_align: Clutter.ActorAlign.CENTER}));
        const b = new St.Button({child: row, style_class: 'neo-power-button', x_expand: true, can_focus: true});
        b.connect('clicked', () => { dlg.close(); run(); });
        box.add_child(b);
    };
    entry('system-shutdown-symbolic', 'Power off', () => goingDown('Powering off…', 'PowerOff'));
    entry('view-refresh-symbolic', 'Restart', () => goingDown('Restarting…', 'Reboot'));
    entry('weather-clear-night-symbolic', 'Suspend', () => Main.powerManager?.suspend?.());
    dlg.contentLayout.add_child(box);
    // no Cancel button: a tap anywhere outside the card closes it (and Escape / back)
    const outside = ev => {
        const [x, y] = ev.get_coords();
        const card = dlg.dialogLayout, [cx, cy] = card.get_transformed_position();
        return x < cx || y < cy || x > cx + card.width || y > cy + card.height;
    };
    // on the dialog itself: it holds the input grab while open, so the stage's own handlers never see the tap
    let pressedOutside = false;
    const tapId = dlg.connect('captured-event', (st, ev) => {
        // Close on the RELEASE and let every event through: swallowing a touch's begin left the gestures
        // waiting for a sequence that never ended, and the whole screen stopped responding.
        const t = ev.type();
        if (t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.TOUCH_BEGIN) pressedOutside = outside(ev);
        else if ((t === Clutter.EventType.BUTTON_RELEASE || t === Clutter.EventType.TOUCH_END) && pressedOutside && outside(ev)) {
            pressedOutside = false;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { dlg.close(); return GLib.SOURCE_REMOVE; });
        } else if (t === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) dlg.close();
        return Clutter.EVENT_PROPAGATE;
    });
    dlg.connect('closed', () => { dialog = null; dlg.disconnect(tapId); });
    dialog = dlg;
    dlg.open();
}

const RING_DIR = '/usr/share/plymouth/themes/yesman-ring';

/**
 * Power off / Restart: the boot splash's own ring (the Plymouth theme's frames, 35 fps) on black with what is
 * happening under it, the same picture Plymouth shows once the session has ended (yesman-ring.script), so the
 * choice visibly took and the hand-over does not change the screen. A spinner if the theme is not installed.
 * It holds the input grab, and the logind call goes out once it is painted.
 */
function goingDown(text, action) {
    const stage = global.stage, W = stage.width, H = stage.height;
    const scale = St.ThemeContext.get_for_stage(stage).scale_factor || 1;
    const screen = new St.Widget({style: 'background-color: black;', reactive: true, opacity: 0, x: 0, y: 0, width: W, height: H,
        layout_manager: new Clutter.FixedLayout()});
    const frames = [];
    for (let i = 0; i < 41; i++) {
        const f = Gio.File.new_for_path(`${RING_DIR}/frame${String(i).padStart(2, '0')}.png`);
        if (!f.query_exists(null)) break;
        frames.push(new Gio.FileIcon({file: f}));
    }
    let anim = null, timer = 0;
    if (frames.length === 41) {
        // Plymouth draws the 640 px frames unscaled (smaller only if wider than 80 % of the screen)
        const px = Math.min(640, Math.round(W * 0.8));
        anim = new St.Icon({gicon: frames[0], icon_size: Math.round(px / scale)});
        anim.set_position(Math.round((W - px) / 2), Math.round((H - px) / 2));
        screen.add_child(anim);
        let n = 0;
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / 35), () => { anim.gicon = frames[++n % 41]; return GLib.SOURCE_CONTINUE; });
    } else {
        const sp = new Animation.Spinner(48, {animate: true});
        sp.set_position(Math.round(W / 2 - 24 * scale), Math.round(H / 2 - 24 * scale));
        screen.add_child(sp); sp.play();
    }
    // Plymouth's message: Sans 24, light grey, centred at 80 % of the height
    const label = new St.Label({text, style: `color: rgb(204,204,204); font-family: Sans; font-size: ${Math.round(24 * 4 / 3 / scale)}px;`});
    screen.add_child(label);
    label.connect('notify::width', () => label.set_position(Math.round((W - label.width) / 2), Math.round(H * 0.8)));
    Main.layoutManager.uiGroup.add_child(screen);
    Main.layoutManager.uiGroup.set_child_above_sibling(screen, null);
    screen.connect('destroy', () => { if (timer) GLib.source_remove(timer); });
    try { Main.pushModal(screen); } catch (_) {}
    screen.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { logindAction(action); return GLib.SOURCE_REMOVE; });
}

/** Close the power dialog if it is open (the back gesture); true when there was one. */
export function closePowerDialog() {
    if (!dialog) return false;
    dialog.close();
    return true;
}

export class PowerTweaks {
    constructor(settings, log) {
        this._settings = settings; this._log = log;
        this._inj = new InjectionManager();
        const pm = Main.powerManager;
        const tweaks = this;
        if (pm && typeof pm.powerButtonEvent === 'function') {
            this._inj.overrideMethod(Object.getPrototypeOf(pm), 'powerButtonEvent', original => async function (event) {
                const press = event.type() === Clutter.EventType.KEY_PRESS;
                if (tweaks._settings.get_boolean('debug-logging')) tweaks._log?.(`power ${press ? 'press' : 'release'} flags=${event.get_flags()}`);
                if (press) { if (!tweaks._powerDown) tweaks._chord = false; tweaks._powerDown = true; }   // auto-repeat presses must not reset the chord
                else {
                    tweaks._powerDown = false;
                    if (tweaks._chord) {            // power + volume-down was a screenshot: no blank, no power menu
                        tweaks._chord = false;
                        if (this._powerHoldId) { GLib.source_remove(this._powerHoldId); delete this._powerHoldId; }
                        delete this._powerPressHappened;
                        return;
                    }
                    // People let go of power a little before volume-down. Hold the release action back 300 ms:
                    // a volume-down release inside that window still makes it a screenshot.
                    const pm = this, time = event.get_time();
                    const fake = {type: () => Clutter.EventType.KEY_RELEASE, get_time: () => time, get_flags: () => 0};
                    if (tweaks._deferId) GLib.source_remove(tweaks._deferId);
                    tweaks._deferId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        tweaks._deferId = 0;
                        if (tweaks._chord) { tweaks._chord = false; return GLib.SOURCE_REMOVE; }
                        original.call(pm, fake).catch?.(e => console.error(e));
                        return GLib.SOURCE_REMOVE;
                    });
                    tweaks._releasedAt = GLib.get_monotonic_time();
                    return;
                }
                const r = await original.call(this, event);
                if (event.type() === Clutter.EventType.KEY_PRESS && this._powerHoldId) {
                    GLib.source_remove(this._powerHoldId);
                    this._powerHoldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(300, tweaks._settings.get_int('power-hold-ms')), () => {
                        this._showInteractivePowerMenu();
                        delete this._powerPressHappened; delete this._powerHoldId;
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return r;
            });
        }
        // Power + volume-down = screenshot (Android). GNOME's volume binding takes the volume-down PRESS, but its
        // release still reaches the stage: a release while the power key is down is the chord.
        this._keyId = global.stage.connect('captured-event', (_a, ev) => {
            // No logging of key events here: this handler sees every key, password dialogs included.
            const justReleased = this._deferId && GLib.get_monotonic_time() - (this._releasedAt ?? 0) < 300000;
            if (ev.type() === Clutter.EventType.KEY_RELEASE && ev.get_key_symbol() === Clutter.KEY_AudioLowerVolume && (this._powerDown || justReleased) && !this._chord) {
                this._fireChord('volume release');
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // keychord.service (root, reads both PMIC key devices) touches this file the moment power and
        // volume-down are held together: exact, whatever the order of the presses and releases.
        try {
            this._chordMon = Gio.File.new_for_path('/run/neolauncher/chord').monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._chordMonId = this._chordMon.connect('changed', (_m, _f, _o, type) => {
                if (type === Gio.FileMonitorEvent.CHANGES_DONE_HINT || type === Gio.FileMonitorEvent.CHANGED) this._fireChord('keychord');
            });
        } catch (e) { this._log?.(`keychord monitor: ${e.message}`); }
        const sa = SystemActions.getDefault();
        // is_phone is read at each call, not here: it follows the monitors (a phone on an external screen is not one)
        this._inj.overrideMethod(Object.getPrototypeOf(sa), '_updateHaveShutdown', original => async function (...args) {
            if (!isPhone()) return original.call(this, ...args);
            let can = false;
            try { const r = await login1('CanPowerOff'); can = r === 'yes' || r === 'challenge'; } catch (_) {}
            if (tweaks._destroyed) return;                     // the shell's own check has run again since
            this._canHavePowerOff = can;
            this._updatePowerOff();
        });
        sa._updateHaveShutdown();
        // Restart / Power Off from the power menu went to gnome-session (RebootAsync / ShutdownAsync), which waits
        // for an end-session dialog the mobile shell never shows: nothing happened. The menu is the confirmation
        // (Android restarts at once), so on the phone they go to logind like the availability check above.
        this._inj.overrideMethod(Object.getPrototypeOf(sa), 'activateRestart', original => function (...args) {
            return isPhone() ? logindAction('Reboot') : original.call(this, ...args);
        });
        this._inj.overrideMethod(Object.getPrototypeOf(sa), 'activatePowerOff', original => function (...args) {
            return isPhone() ? logindAction('PowerOff') : original.call(this, ...args);
        });
        // the power key's long press (and the Control Center's power button) open the dialog above
        if (Main.powerManager) this._inj.overrideMethod(Object.getPrototypeOf(Main.powerManager), '_showInteractivePowerMenu', () => () => showPowerDialog());
        this._log?.(`power: hold ${settings.get_int('power-hold-ms')} ms`);
    }
    /** One screenshot per chord, and the power key's own action (blank / power menu) is cancelled. */
    _fireChord(why) {
        const now = GLib.get_monotonic_time();
        if (this._chordAt && now - this._chordAt < 1500000) return;   // the file monitor reports a write twice
        this._chordAt = now;
        this._chord = true;
        const pm = Main.powerManager;
        if (pm?._powerHoldId) { GLib.source_remove(pm._powerHoldId); delete pm._powerHoldId; }
        if (this._deferId) { GLib.source_remove(this._deferId); this._deferId = 0; delete pm._powerPressHappened; this._chord = false; }
        this._log?.(`chord (${why})`);
        this._screenshot().catch(e => this._log?.(`screenshot: ${e.message}`));
    }

    async _screenshot() {
        const dir = GLib.build_filenamev([GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']), 'Screenshots']);
        GLib.mkdir_with_parents(dir, 0o755);
        const path = GLib.build_filenamev([dir, `Screenshot From ${GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S')}.png`]);
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shooter = new Shell.Screenshot();
        await new Promise((resolve, reject) => shooter.screenshot(false, stream, (o, res) => { try { o.screenshot_finish(res); resolve(); } catch (e) { reject(e); } }));
        stream.close(null);
        // the camera flash, as on Android
        const mon = Main.layoutManager.primaryMonitor;
        const flash = new St.Widget({style: 'background-color: white;', opacity: 0, x: mon.x, y: mon.y, width: mon.width, height: mon.height});
        Main.layoutManager.uiGroup.add_child(flash);
        flash.ease({opacity: 200, duration: 60, onComplete: () => flash.ease({opacity: 0, duration: 260, onComplete: () => flash.destroy()})});
        try { global.display.get_sound_player().play_from_theme('screen-capture', 'Screenshot taken', null); } catch (_) {}
        this._log?.(`screenshot: ${path}`);
    }
    destroy() {
        this._destroyed = true;
        closePowerDialog();                // an open dialog outliving its code kept the input grab (screen stuck)
        if (this._chordMonId) { this._chordMon.disconnect(this._chordMonId); this._chordMon.cancel(); this._chordMonId = 0; }
        if (this._deferId) { GLib.source_remove(this._deferId); this._deferId = 0; }
        if (this._keyId) { global.stage.disconnect(this._keyId); this._keyId = 0; }
        this._inj.clear();
        try { SystemActions.getDefault()._updateHaveShutdown(); } catch (_) {}
    }
}
