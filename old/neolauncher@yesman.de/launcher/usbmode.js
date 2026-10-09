// "Use USB for": Android's USB preferences. When a computer enumerates the phone (the UDC state
// turns "configured") a notification offers the modes; the choice is written to
// /run/neolauncher/usb-request, where neo-usb-mode.path (root) rebuilds the USB gadget.
//
// The request file is 0620 root:plugdev (gnome/device/usb-mode/neo-usb-mode.tmpfiles): only the phone's
// user writes it. Nothing is offered unless it exists and is writable (the root helper is installed), and
// the modes that expose the phone (file transfer: $HOME over MTP; webcam) are neither offered nor sent
// while the screen is locked, so a cable into a locked phone gets no further than USB networking.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const here = import.meta.url.replace(/\/[^/]*$/, '');
const {readText, canWrite, screenLocked} = await import(`${here}/util.js?gen=${gen}`);

const REQUEST = '/run/neolauncher/usb-request';
const STATE = '/run/neolauncher/usb-mode';
const MODES = [
    {id: 'network', title: 'Network only', body: 'USB Ethernet to this computer, nothing else shared'},
    {id: 'files', title: 'File transfer', body: 'Browse and copy the phone\'s files (MTP)', exposes: true},
    {id: 'tether', title: 'USB tethering', body: 'Share the phone\'s internet connection with this computer'},
    {id: 'webcam', title: 'Webcam', body: 'The front camera as a USB camera for this computer', exposes: true},
];

/** Emits 'changed' when a computer connects or goes, and when the mode changes (the Control Center tile). */
export class UsbMode extends EventEmitter {
    constructor(log) {
        super();
        this.log = log;
        this._udc = (() => { try { const d = Gio.File.new_for_path('/sys/class/udc').enumerate_children('standard::name', 0, null); const i = d.next_file(null); return i ? `/sys/class/udc/${i.get_name()}/state` : null; } catch (_) { return null; } })();
        if (!this._udc) return;
        this._connected = readText(this._udc) === 'configured';
        // sysfs attributes do not notify; a 2 s poll of one small file is cheap
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => { this._poll(); return GLib.SOURCE_CONTINUE; });
    }

    /** A USB device controller exists and the root helper takes requests (the Control Center tile). */
    get available() { return !!this._udc && canWrite(REQUEST); }
    /** A computer has enumerated the phone. */
    get connected() { return !!this._connected; }

    destroy() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (this._refreshId) { GLib.source_remove(this._refreshId); this._refreshId = 0; }
        this._notification?.destroy(); this._notification = null;
        this._dialog?.close(); this._dialog = null;
        this._source?.destroy(); this._source = null;      // its tray entry outlived a disable
    }

    _poll() {
        const now = readText(this._udc) === 'configured';
        const mode = this._mode();
        if (mode !== this._lastMode) { this._lastMode = mode; this.emit('changed'); }
        if (now === this._connected) return;
        this._connected = now;
        this.emit('changed');
        if (now) this._notify(); else { this._notification?.destroy(); this._notification = null; }
    }

    _mode() { return readText(STATE) || 'network'; }
    _offered() { return screenLocked() ? MODES.filter(m => !m.exposes) : MODES; }
    modeTitle() { return (MODES.find(m => m.id === this._mode()) ?? MODES[0]).title; }

    _notify() {
        if (!canWrite(REQUEST)) return;                 // no root helper: a chooser that cannot switch anything
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'USB', iconName: 'drive-removable-media-symbolic'});
            this._source.connect('destroy', () => { this._source = null; });
            Main.messageTray.add(this._source);
        }
        const mode = MODES.find(m => m.id === this._mode()) ?? MODES[0];
        this._notification?.destroy();
        const n = new MessageTray.Notification({source: this._source, title: `USB connected · ${mode.title}`,
            body: 'Tap to choose what this computer can use', isTransient: false, resident: true});
        n.connect('activated', () => this.showChooser());
        n.connect('destroy', () => { if (this._notification === n) this._notification = null; });
        this._notification = n;
        this._source.addNotification(n);
    }

    showChooser() {
        this._dialog?.close();
        if (!canWrite(REQUEST)) { Main.notifyError('USB', 'The USB mode helper (neo-usb-mode) is not installed'); return; }
        const dlg = new ModalDialog.ModalDialog({styleClass: 'neo-usb-dialog'});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 6px; min-width: 300px;'});
        box.add_child(new St.Label({text: 'Use USB for', style: 'font-weight: bold; font-size: 1.15em; padding-bottom: 6px;'}));
        const current = this._mode();
        for (const m of this._offered()) {
            const row = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            row.add_child(new St.Label({text: `${m.id === current ? '●' : '○'}  ${m.title}`, style: 'font-size: 1.05em;'}));
            row.add_child(new St.Label({text: m.body, style: 'font-size: 0.85em; color: #9aa0a6; padding-left: 22px;'}));
            const btn = new St.Button({child: row, style_class: 'button', x_expand: true, can_focus: true, style: 'text-align: left; padding: 10px 12px;'});
            btn.connect('clicked', () => { dlg.close(); this._request(m.id); });
            box.add_child(btn);
        }
        dlg.contentLayout.add_child(box);
        dlg.setButtons([{label: 'Close', action: () => dlg.close(), key: Clutter.KEY_Escape}]);
        dlg.connect('closed', () => { if (this._dialog === dlg) this._dialog = null; });
        this._dialog = dlg;
        dlg.open();
    }

    _request(mode) {
        if (MODES.find(m => m.id === mode)?.exposes && screenLocked()) { this.log?.(`usb: ${mode} refused while locked`); return; }
        try {
            Gio.File.new_for_path(REQUEST).replace_contents(new TextEncoder().encode(`${mode}\n`), null, false, Gio.FileCreateFlags.NONE, null);
            this.log?.(`usb: requested ${mode}`);
            // the gadget re-enumerates; refresh the notification once the switch is done
            if (this._refreshId) GLib.source_remove(this._refreshId);
            this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => { this._refreshId = 0; if (this._connected) this._notify(); return GLib.SOURCE_REMOVE; });
        } catch (e) { Main.notifyError('USB', `Could not switch the USB mode: ${e.message}`); }
    }
}
