// Small helpers shared by the launcher's system services (sysfs reads, D-Bus calls, "is this a phone").
//
// Nothing here registers a GType, so importing it again under a new ?gen= on a dev reload is harmless.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** A small text file (sysfs attribute, /run state file), trimmed; null when it cannot be read. */
export function readText(path) {
    try { const [ok, b] = GLib.file_get_contents(path); return ok ? new TextDecoder().decode(b).trim() : null; } catch (_) { return null; }
}

/** An integer sysfs attribute; NaN when missing or unreadable. */
export function readInt(path) {
    const t = readText(path);
    return t === null ? NaN : parseInt(t, 10);
}

/** Can this process write `path` (exists and the access check passes)? */
export function canWrite(path) {
    try { return Gio.File.new_for_path(path).query_info('access::can-write', Gio.FileQueryInfoFlags.NONE, null).get_attribute_boolean('access::can-write'); } catch (_) { return false; }
}

/**
 * The mobile shell decided this is a phone (gnome-shell-mobile's LayoutManager `is-phone`, from the panel
 * size). Everything that would be wrong on a desktop — power off without the end-session dialog, a swipe
 * lock, panel rotation, the hidden pointer — is gated on it. A stock shell has no such property: false.
 */
export function isPhone() {
    const lm = Main.layoutManager;
    return !!(lm?.is_phone ?? lm?.isPhone ?? false);
}

function seat() {
    try { return global.stage.context.get_backend().get_default_seat(); } catch (_) {}
    try { return Clutter.get_default_backend().get_default_seat(); } catch (_) { return null; }
}

/** A touchscreen is attached (the cursor policy only makes sense on touch hardware). */
export function hasTouchscreen() {
    try { return seat()?.list_devices().some(d => d.get_device_type() === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE) ?? false; } catch (_) { return false; }
}

/** Mutter's touch mode (no keyboard/pointer in use): it hides the pointer itself while this is on. */
export function touchMode() { return !!seat()?.touch_mode; }

/** The screen is locked: the shell's screen shield, or the launcher's own swipe lock (launcher/lockscreen.js). */
export function screenLocked() {
    if (Main.screenShield?.locked) return true;
    return Main.layoutManager.uiGroup.get_children().some(c => c.name === 'neoLockScreen' && c.visible);
}

/** An async D-Bus call; resolves to the reply's unpacked tuple (deepUnpack), rejects with the GLib error. */
export function dbusCall(bus, name, path, iface, method, params = null, timeout = -1) {
    return new Promise((resolve, reject) => bus.call(name, path, iface, method, params, null, Gio.DBusCallFlags.NONE, timeout, null, (c, r) => {
        try { resolve(c.call_finish(r).deepUnpack()); } catch (e) { reject(e); }
    }));
}

/**
 * org.gnome.Mutter.DisplayConfig.GetCurrentState, fully unpacked:
 * {serial, monitors: [[[connector, vendor, product, serial], modes, props]], logical: [[x, y, scale, transform, primary, [[connector, ...]], props]]}.
 * A mode is [id, w, h, refresh, preferredScale, scales, props]; props hold plain values (is-current, is-builtin).
 */
export function displayState() {
    return new Promise((resolve, reject) => Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', null, null, Gio.DBusCallFlags.NONE, -1, null, (c, r) => {
            try { const [serial, monitors, logical] = c.call_finish(r).recursiveUnpack(); resolve({serial, monitors, logical}); } catch (e) { reject(e); }
        }));
}

/** The logical monitor that holds the built-in panel (eDP/DSI), or null. */
export function builtinLogical(state) {
    const builtin = new Set(state.monitors.filter(m => m[2]?.['is-builtin']).map(m => m[0][0]));
    return state.logical.find(lm => lm[5].some(spec => builtin.has(spec[0]))) ?? null;
}

/**
 * The torch LED: the first /sys/class/leds entry named like a flash or torch (white:flash on the Poco,
 * led:torch_0 / *:flash on others); null when the device has none.
 */
export function findFlashLed() {
    const names = [];
    try {
        const en = Gio.File.new_for_path('/sys/class/leds').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let i; (i = en.next_file(null));) names.push(i.get_name());
        en.close(null);
    } catch (_) { return null; }
    const name = names.sort().find(n => /flash|torch/i.test(n));
    return name ? `/sys/class/leds/${name}` : null;
}
