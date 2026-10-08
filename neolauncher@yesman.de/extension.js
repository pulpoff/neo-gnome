// Neo Launcher for gnome-shell-mobile — extension entry point.
//
// Keep this file tiny and stable: GNOME Shell imports an extension's main module once per shell
// process, so every edit here costs a logout. The launcher itself lives in launcher/*.js and is
// imported once per shell process too: the shell disables and re-enables the extension on every
// lock/unlock (session-modes ["user"]), and importing it again each time registered a fresh set of
// GTypes and module copies per unlock that were never freed. Only the developer's Reload (in
// launcher/dev.js, which release packages do not ship) imports the files again under a new ?gen=.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = 'de.yesman.NeoLauncher';
const OBJECT_PATH = '/de/yesman/NeoLauncher';
// The release interface: the call screen's proximity switch and the loaded generation, nothing that runs code.
const ifaceXml = (devMethods = '') => `
<node>
  <interface name="${IFACE}">
    <method name="SetCallProximity"><arg type="b" direction="in" name="on"/></method>${devMethods}
    <property name="Generation" type="u" access="read"/>
  </interface>
</node>`;

// Per shell process: this module is imported once, so these outlive disable/enable (a lock/unlock).
let generation = 0;            // suffix of every GType name in launcher/*.js; only grows
let launcher = null;           // the imported launcher/home.js, reused on every re-enable
let bootLockClaimed = false;   // the launcher's lock screen comes up once, at the first load after login

/**
 * The developer tools (Eval, Reload): only when launcher/dev.js is present (a checkout synced by
 * install.sh; `make pack` and the APK leave it out) AND the developer asked for it, with
 * NEOLAUNCHER_DEV=1 in the shell's environment or ~/.config/neolauncher/dev-mode. Absent: null, silently.
 */
async function loadDevTools(dir) {
    const file = dir.get_child('launcher').get_child('dev.js');
    if (!file.query_exists(null)) return null;
    const marker = GLib.build_filenamev([GLib.get_user_config_dir(), 'neolauncher', 'dev-mode']);
    if (GLib.getenv('NEOLAUNCHER_DEV') !== '1' && !GLib.file_test(marker, GLib.FileTest.EXISTS)) return null;
    try { return await import(file.get_uri()); } catch (e) { console.warn(`[neolauncher] dev tools: ${e.message}`); return null; }
}

export default class NeoLauncherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._injectionManager = new InjectionManager();
        this._loadToken ??= 0;
        this._launcherActive = false;
        const controls = Main.overview._overview?.controls;
        if (!controls) { this._log('no overview in this session mode'); return; }
        this._controls = controls;
        // The stock grid comes back on every state change; keep it hidden while we are active.
        this._injectionManager.overrideMethod(Object.getPrototypeOf(controls), '_updateAppDisplayVisibility', original => {
            const ext = this;
            return function (...args) {
                original.call(this, ...args);
                if (ext._launcherActive) this._appDisplay.visible = false;
            };
        });
        this._exportDbus().catch(e => logError(e, '[neolauncher] D-Bus export'));
        this._loadLauncher().catch(e => this._fail(e));
    }

    disable() {
        this._unloadLauncher();
        this._dbus?.unexport(); this._dbus = null;
        this._injectionManager?.clear(); this._injectionManager = null;
        if (this._controls) {
            this._launcherActive = false;
            this._controls._searchEntryBin?.show();
            this._controls._updateAppDisplayVisibility();
            this._controls = null;
        }
        this._settings = null;
    }

    async _exportDbus() {
        const settings = this._settings;
        const dev = await loadDevTools(this.dir);
        if (this._settings !== settings || this._dbus) return;          // disabled (or re-enabled) meanwhile
        const target = {
            SetCallProximityAsync: (params, invocation) => this._setCallProximity(params, invocation),
            get Generation() { return generation; },
        };
        if (dev) Object.assign(target, dev.methods(this, Main));
        this._dbus = Gio.DBusExportedObject.wrapJSObject(ifaceXml(dev?.METHODS_XML), target);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        if (dev) console.log('[neolauncher] developer D-Bus methods (Eval, Reload) exported');
    }

    /**
     * The Yesman app: screen off at the ear while an earpiece call runs (launcher/proximity.js). The caller's
     * bus name owns the switch: when it leaves the bus (the app crashed or quit mid-call) the black layer
     * goes, so no client can leave the phone stuck behind it.
     */
    _setCallProximity([on], invocation) {
        const prox = this._home?.callProximity;
        if (!prox) { invocation.return_dbus_error(`${IFACE}.Error.NotLoaded`, 'the launcher is not loaded'); return; }
        prox.set(!!on, {connection: invocation.get_connection(), sender: invocation.get_sender()});
        invocation.return_value(null);
    }

    /** launcher/lockscreen.js: true exactly once per shell process, so a re-enable or a reload never re-locks. */
    claimBootLock() {
        if (bootLockClaimed) return false;
        bootLockClaimed = true;
        return true;
    }

    /** Dev Reload (launcher/dev.js): tear the UI down and import launcher/*.js again under a new generation. */
    reload() {
        this._unloadLauncher();
        this._loadLauncher(true).then(() => this._log('reloaded')).catch(e => this._fail(e));
        return `reloading generation ${generation + 1}`;
    }

    get home() { return this._home ?? null; }

    async _loadLauncher(fresh = false) {
        // A load token: a reload or a disable/enable while an import is pending must not end with two homes.
        const token = ++this._loadToken;
        let mod = launcher, gen = generation;
        if (fresh || !mod) {
            gen = ++generation;
            mod = await import(`${this.dir.get_child('launcher').get_child('home.js').get_uri()}?gen=${gen}`);
            if (gen === generation) launcher = mod;
        }
        if (token !== this._loadToken || !this._settings) return;     // superseded or disabled meanwhile
        this._home = new mod.NeoHome(this, this._settings, gen);
        Main.layoutManager.overviewGroup.add_child(this._home);
        this._launcherActive = true;
        this._retries = 0;
        this._controls._appDisplay.visible = false;
        if (this._settings.get_boolean('hide-search-entry')) this._controls._searchEntryBin?.hide();
        this._log(`launcher loaded (generation ${gen})`);
    }

    _unloadLauncher() {
        this._loadToken = (this._loadToken ?? 0) + 1;              // a pending import no longer builds a home
        this._launcherActive = false;
        try { this._home?.destroy(); } catch (e) { this._log(`destroy: ${e.message}`); }
        this._home = null;
    }

    _fail(e) {
        // A GType name clash means this process already registered that generation: skip ahead and try again
        // instead of giving the stock grid.
        if (this._settings && /already registered/.test(e?.message ?? '') && (this._retries = (this._retries ?? 0) + 1) <= 8) {
            console.log(`[neolauncher] generation ${generation} taken, retrying with ${generation + 1}`);
            this._loadLauncher(true).catch(err => this._fail(err));
            return;
        }
        this._launcherActive = false;
        this._controls?._updateAppDisplayVisibility();
        this._controls?._searchEntryBin?.show();
        logError(e, '[neolauncher] launcher failed; stock grid restored');
    }

    _log(msg) { if (this._settings?.get_boolean('debug-logging')) console.log(`[neolauncher] ${msg}`); }
}
