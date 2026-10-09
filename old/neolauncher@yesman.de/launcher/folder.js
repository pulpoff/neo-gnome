// Open folder (NEO-SPEC §1.4/§2.5/§3.3): window scales + translates from the folder
// icon over 200 ms (STANDARD curve), 3×3 grid of 80×94 cells, 56 dp footer with the
// editable name; tap outside closes.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

const here = import.meta.url.replace(/\/[^/]*$/, '');
const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const {AppCell} = await import(`${here}/icons.js?gen=${gen}`);

const F = {cellW: 80, cellH: 94, gutter: 16, padTop: 24, padSide: 8, footer: 56, radius: 12, openMs: 200, itemDelay: 30};

export const FolderView = GObject.registerClass({GTypeName: `NeoFolderView_${gen}`},
class FolderView extends St.Widget {
    _init(home, cell) {
        super._init({style_class: 'neo-folder-scrim', reactive: true, x_expand: true, y_expand: true, layout_manager: new Clutter.BinLayout()});
        this.home = home; this.cell = cell; this.item = cell.item;
        const cols = home.settings.get_int('desktop-folder-columns'), rows = home.settings.get_int('desktop-folder-rows');
        this._win = new St.BoxLayout({style_class: 'neo-folder', orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._win);
        const grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_spacing: F.gutter, row_spacing: F.gutter}), style: `padding: ${F.padTop}px ${F.padSide}px 0 ${F.padSide}px;`});
        const gl = grid.layout_manager;
        const opts = {showLabel: true, model: home.model, home};
        (this.item.items ?? []).slice(0, cols * rows).forEach((id, i) => {
            const c = new AppCell({type: 'app', id}, opts); c.set_size(F.cellW, F.cellH);
            c.connect('launched', () => this.close(true));
            c.connect('long-press', cc => home._onCellLongPress(cc, 'folder', {folder: this.item, folderView: this}));
            c.connect('drag-start', (cc, g) => home.drag.begin(cc, 'folder', g, {folder: this.item, folderView: this}));
            gl.attach(c, i % cols, Math.floor(i / cols), 1, 1);
        });
        this._win.add_child(grid);
        const footer = new St.Bin({style_class: 'neo-folder-footer', height: F.footer, x_expand: true});
        this._name = new St.Entry({style_class: 'neo-folder-name', hint_text: 'Unnamed Folder', text: this.item.name ?? '', x_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        // Enter and leaving the field take the name; it is saved when the folder closes (a save rebuilds the home,
        // which would take the folder's own icon away while it is still open and animates back to it)
        this._name.clutter_text.connect('activate', () => { this._takeName(); global.stage.set_key_focus(null); });
        this._name.clutter_text.connect('key-focus-out', () => this._takeName());
        this.connect('destroy', () => this._saveName());     // the launcher went away with the folder open
        footer.set_child(this._name);
        this._win.add_child(footer);
        this.connect('button-release-event', (a, ev) => { const [x, y] = ev.get_coords(); const [wx, wy] = this._win.get_transformed_position(); if (x < wx || y < wy || x > wx + this._win.width || y > wy + this._win.height) this.close(); return Clutter.EVENT_STOP; });
        this.connect('key-press-event', (a, ev) => { if (ev.get_key_symbol() === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; } return Clutter.EVENT_PROPAGATE; });
    }
    get isOpen() { return !this._closing; }
    _takeName() {
        if (this._closing) return;
        const name = this._name.text.trim();
        if (name !== (this.item.name ?? '')) { this.item.name = name; this._nameDirty = true; }
    }
    _saveName() { if (this._nameDirty) { this._nameDirty = false; this.home.model.save(); } }
    open() {
        // FolderAnimationManager: scale from the icon's rect to the final rect, 200 ms STANDARD
        const [ix, iy] = this.cell.get_transformed_position(); const iw = this.cell.width;
        this._win.set_pivot_point(0.5, 0.5);
        const run = () => {
            const [fx, fy] = this._win.get_transformed_position(); const fw = this._win.width, fh = this._win.height;
            const s = Math.max(0.05, iw / Math.max(1, fw));
            this._win.scale_x = this._win.scale_y = s;
            this._win.translation_x = ix + iw / 2 - (fx + fw / 2); this._win.translation_y = iy + iw / 2 - (fy + fh / 2);
            this._win.opacity = 200; this.opacity = 0;
            this._win.ease({scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, opacity: 255, duration: F.openMs, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            this.ease({opacity: 255, duration: F.openMs});
            this._name.opacity = 0; this._name.ease({opacity: 255, duration: 32, delay: F.openMs - 32});
        };
        if (this._win.get_width() > 0) run(); else { const id = this._win.connect('notify::allocation', () => { this._win.disconnect(id); run(); }); }
        this.grab_key_focus();
    }
    close(launched = false) {
        if (this._closing) return;
        this._takeName(); this._closing = true;
        const [ix, iy] = this.cell.get_transformed_position(); const iw = this.cell.width;
        const [fx, fy] = this._win.get_transformed_position(); const fw = this._win.width, fh = this._win.height;
        this._saveName();          // after the icon's rect is read: the save rebuilds the home
        this._win.ease({scale_x: iw / Math.max(1, fw), scale_y: iw / Math.max(1, fw), translation_x: ix + iw / 2 - (fx + fw / 2), translation_y: iy + iw / 2 - (fy + fh / 2), opacity: 0, duration: F.openMs, mode: Clutter.AnimationMode.EASE_IN_CUBIC});
        this.ease({opacity: 0, duration: F.openMs, onComplete: () => this.destroy()});
    }
});
