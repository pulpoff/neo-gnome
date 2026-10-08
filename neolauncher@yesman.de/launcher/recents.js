const {firstDelta, firstBegin, firstPoint} = await import(`${import.meta.url.replace(/\/[^/]*$/, '')}/gesture.js?gen=${(import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0'}`);
// Recents: the Android task switcher ("Overview" in quickstep terms) for the Neo home.
//
// A swipe up from the bottom edge of an app is gnome-shell-mobile's overview gesture.
// We keep that gesture and its state machine (ControlsManager._stateAdjustment, 0 =
// app, 2 = home) but draw our own thing for it: the app shrinks into a card over the
// dimmed wallpaper, older tasks line up to its left (state 1), and the home fades in
// over state 1→2. A quick flick lands on the home, a slow drag or a pause lands on
// the task list — the Android split. In the list: slide left/right between tasks,
// tap one to return to it, swipe it up to close it, "Close all" at the bottom.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
const {iconActor} = await import(`${import.meta.url.replace(/\/[^/]*$/, '')}/iconpack.js?gen=${(import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0'}`);

const gen = (import.meta.url.match(/[?&]gen=(\d+)/) ?? [])[1] ?? '0';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Android "Large Phone" recents metrics measured on the One UI reference (dp == px)
const R = {
    cardScale: 0.63,        // card = 63 % of the screen (both axes, aspect kept)
    gap: 28,                // between cards
    topInset: 80,           // below the status bar
    radius: 24,             // card corner radius (renders ~15 % smaller than nominal through the offscreen effect)
    chipGap: 8,             // app chip (icon · name · memory) centred above the card
    closeAllY: 0.826,       // "Close all" pill centre (fraction of the screen height)
    dragDistance: 0.5,      // screen heights of finger travel for one state unit
    edgeZone: 32,           // logical px at the bottom where a swipe on the home is the recents/home gesture: below the dock icons (they end ~41 px above the edge)
    armSpeed: 2.5,          // state units/s: slower than this (after minTravel) = the task list, faster = a fling = home
    minTravel: 0.4,         // state units (20 % of the screen height) the finger must travel before the list can open — 15 % caught ordinary home swipes
    dismissFraction: 0.25,  // card travel (of its own height) that counts as a close
    dismissVelocity: 0.8,   // px/ms upward that counts as a close
    shrinkToHome: 0.35,     // extra shrink of the cards while the home fades in
};

/** Fragment shader that fades everything outside a rounded rectangle (offscreen effect). */
export const RoundedClip = GObject.registerClass({GTypeName: `NeoRoundedClip_${gen}`},
class RoundedClip extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            'uniform vec2 neo_size; uniform float neo_radius;',
            `vec2 neo_p = cogl_tex_coord0_in.xy * neo_size;
             vec2 neo_q = abs(neo_p - neo_size * 0.5) - (neo_size * 0.5 - vec2(neo_radius));
             float neo_d = length(max(neo_q, 0.0)) + min(max(neo_q.x, neo_q.y), 0.0) - neo_radius;
             cogl_color_out *= 1.0 - smoothstep(-0.7, 0.7, neo_d);`, false);
    }
    setGeometry(w, h, r) {
        this.set_uniform_float(this.get_uniform_location('neo_size'), 2, [w, h]);
        this.set_uniform_float(this.get_uniform_location('neo_radius'), 1, [r]);
    }
});

export const Recents = GObject.registerClass({
    GTypeName: `NeoRecents_${gen}`,
    Properties: {scroll: GObject.ParamSpec.double('scroll', 'scroll', 'scroll', GObject.ParamFlags.READWRITE, -1e6, 1e6, 0)},
}, class Recents extends St.Widget {
    _init(home) {
        super._init({name: 'neoRecents', style_class: 'neo-recents', reactive: true, visible: false, x_expand: true, y_expand: true, layout_manager: new Clutter.BinLayout()});
        this.home = home; this.log = home.log;
        this._controls = Main.overview._overview.controls;
        this._adj = this._controls._stateAdjustment;
        this._tasks = []; this._scroll = 0; this._active = false; this._gesture = false; this._primary = null; this._samples = [];

        this._scrim = new St.Widget({style_class: 'neo-recents-scrim', x_expand: true, y_expand: true});
        // a plain dim, no background blur: the blur re-rendered the whole wallpaper every frame and made the list sluggish
        this.add_child(this._scrim);
        this._layer = new St.Widget({layout_manager: new Clutter.FixedLayout(), x_expand: true, y_expand: true, reactive: true});
        this.add_child(this._layer);
        this._empty = new St.Label({style_class: 'neo-recents-empty', text: 'No recent apps', visible: false});
        this._layer.add_child(this._empty);
        this._closeAll = new St.Button({style_class: 'neo-recents-button', label: 'Close all', reactive: true, can_focus: true});
        this._closeAll.connect('clicked', () => this.closeAll());
        this._layer.add_child(this._closeAll);
        // the "recents armed" hint: an up arrow in the back-gesture pill, shown once the swipe is long enough
        this._armPill = new St.Widget({style_class: 'neo-back-pill', width: 44, height: 44, opacity: 0, reactive: false, layout_manager: new Clutter.BinLayout()});
        this._armPill.add_child(new St.Icon({icon_name: 'go-up-symbolic', icon_size: 20, style_class: 'neo-back-arrow', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true}));
        this._armPill.set_pivot_point(0.5, 0.5);
        this.add_child(this._armPill);
        this._mix = 1;

        this._adjId = this._adj.connect('notify::value', () => {
            const v = this._adj.value;
            if ((v < 0 || v > 2) && !this._rangeLogged) { this._rangeLogged = true; console.warn(`[neolauncher] overview state out of range: ${v}\n${new Error().stack}`); }
            this._onState();
        });
        Main.overview.connectObject('hidden', () => this._deactivate(), 'shown', () => { if (this._adj.value >= 1.99) this._deactivate(); }, this);
        this._installHooks();
        this._setupGestures();
        this.connect('destroy', () => this._onDestroy());
    }

    _onDestroy() {
        if (this._mixId) { GLib.source_remove(this._mixId); this._mixId = 0; }
        if (this._armTick) { GLib.source_remove(this._armTick); this._armTick = 0; }
        if (this._touchId) { global.stage.disconnect(this._touchId); this._touchId = 0; }
        if (this._edge) { global.stage.remove_action(this._edge); this._edge = null; }
        if (this._closeAllTimer) { GLib.source_remove(this._closeAllTimer); this._closeAllTimer = 0; }
        this._inj?.clear(); this._inj = null;
        if (this._adjId) { this._adj.disconnect(this._adjId); this._adjId = 0; }
        Main.overview.disconnectObject(this);
        this._clearTasks();
        // give the picker back (a newer generation hides it again on its first gesture, _hidePicker); the shell's
        // swipes are given back by home (_onDestroy), which saved them before the launcher took them over
        if (this._controls?._workspacesDisplay) this._controls._workspacesDisplay.opacity = 255;
    }

    // ---------------- the overview gesture, re-pointed at us ----------------
    _installHooks() {
        const recents = this;
        this._inj = new InjectionManager();
        const proto = Object.getPrototypeOf(this._controls);
        this._inj.overrideMethod(proto, 'overviewGestureBegin', original => function (tracker) {
            recents.home.log?.(`recents: overviewGestureBegin state=${this._stateAdjustment.value.toFixed(2)} ovVisible=${Main.overview.visible}`);
            original.call(this, tracker);
            const progress = this._stateAdjustment.value;
            const distance = Main.layoutManager.primaryMonitor.height * R.dragDistance;
            // From the home (state 2) the shell's tracker can only move "up" past its last point, so the swipe is
            // confirmed on a private 0→1 scale that maps to 2→1: swipe up on the home = into the task list.
            recents._fromHome = progress >= 1.99;
            // On the home only a swipe that starts in the bottom edge zone is the recents/home gesture; one that
            // starts higher is the launcher's own swipe-up-for-drawer, so the shell's tracker gets a single snap
            // point and does nothing.
            recents._inert = recents._fromHome && !recents._touchFromEdge();
            if (recents._inert) { tracker.confirmSwipe(distance, [2], 2, 2); return; }
            if (recents._fromHome) tracker.confirmSwipe(distance, [0, 1], 0, 0);
            else tracker.confirmSwipe(distance, [0, 1, 2], progress, Math.round(progress));
            tracker.allowLongSwipes = true;
            recents.gestureBegin(recents._fromHome ? 2 : progress);
        });
        this._inj.overrideMethod(proto, 'overviewGestureProgress', () => function (tracker, progress) {
            if (recents._inert) return;
            if (recents._fromHome) progress = 2 - Math.max(0, Math.min(1, progress));
            progress = Math.max(0, Math.min(2, progress));      // the layout only has boxes for states 0..2
            this._stateAdjustment.value = progress;
            recents.gestureProgress(progress);
        });
        this._inj.overrideMethod(proto, 'overviewGestureEnd', original => function (target, duration, onStopped) {
            if (recents._inert) { recents._inert = false; recents._fromHome = false; original.call(this, 2, 0, onStopped); return; }
            const fromHome = recents._fromHome; recents._fromHome = false;
            if (fromHome) target = target >= 0.5 ? 1 : 2;
            const chosen = recents.gestureEnd(target, fromHome);
            if (chosen !== target) { target = chosen; duration = 300; }
            original.call(this, target, duration, onStopped);
        });
        // where the last touch began: the home accepts the recents swipe only from the bottom edge zone
        // On the home a touch that does not start in the edge zone belongs to the launcher (drawer, dock, pages):
        // the shell's single-finger overview tracker is switched off for that touch so it cannot claim it.
        this._touchId = global.stage.connect('captured-event', (_a, ev) => {
            const t = ev.type();
            if (t === Clutter.EventType.TOUCH_BEGIN || t === Clutter.EventType.BUTTON_PRESS) {
                this._touchY = ev.get_coords()[1];
                const ov = Main.overview._singleFingerOverviewGesture;
                const onHome = Main.overview.visible && this._adj.value >= 1.99 && !this._active;
                if (ov && onHome && !this._touchFromEdge() && ov.enabled) { ov.enabled = false; this._ovHeld = true; }
            } else if ((t === Clutter.EventType.TOUCH_END || t === Clutter.EventType.TOUCH_CANCEL || t === Clutter.EventType.BUTTON_RELEASE) && this._ovHeld) {
                this._ovHeld = false;
                const ov = Main.overview._singleFingerOverviewGesture; if (ov) ov.enabled = true;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // the shell's own window picker stays allocated (the overview relies on it) but never shows
        this._controls._workspacesDisplay.opacity = 0;
        // horizontal stage swipes would switch workspaces behind our back while dragging
        if (Main.overview._singleFingerWorkspacesGesture) Main.overview._singleFingerWorkspacesGesture.enabled = false;
    }

    _touchFromEdge() {
        const mon = Main.layoutManager.primaryMonitor;
        return this._touchY === undefined || this._touchY >= mon.y + mon.height - R.edgeZone;
    }

    /** The shell's own window picker (the old small-thumbnail recents) must never show. Re-asserted on every
     *  gesture: an outgoing launcher generation (reload, lock-screen re-enable) restores it in its destroy. */
    _hidePicker() { const w = this._controls?._workspacesDisplay; if (w && w.opacity !== 0) w.opacity = 0; }

    gestureBegin(progress) {
        this._hidePicker();
        this.home.log?.(`recents: gestureBegin progress=${progress.toFixed(2)} active=${this._active} gesture=${this._gesture} fromHome=${this._fromHome}`);
        this._refreshTasks();
        const focus = global.display.focus_window;
        this._primary = this._tasks.find(t => t.win === focus) ?? this._tasks[0] ?? null;
        this._scroll = this._primary ? this._primaryIndex() * this._step() : 0;
        this._samples = [{t: GLib.get_monotonic_time() / 1000, p: progress}];
        this._gestureFromHome = progress >= 1.99;
        this._gesture = true; this._active = true; this._armed = false; this._setMix(0, true);
        // a resting finger sends no motion: re-check every 50 ms so the arrow appears on a pause too
        if (this._armTick) GLib.source_remove(this._armTick);
        this._armTick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._gesture) { this._armTick = 0; return GLib.SOURCE_REMOVE; }
            const s = this._samples; if (s?.length) this._updateArm(s[s.length - 1].p);
            return GLib.SOURCE_CONTINUE;
        });
        this.show(); this._onState();
    }
    /** Travel along the swipe in state units: from an app 0 → 2, from the home 2 → 1. */
    _travel(v) { return this._gestureFromHome ? 2 - v : v; }
    /** 0 = still a "home button" swipe (no task list shown), 1 = armed for recents; animated over 160 ms. */
    _setMix(target, now = false) {
        if (this._mixId) { GLib.source_remove(this._mixId); this._mixId = 0; }
        if (now) { this._mix = target; return; }
        const from = this._mix, t0 = GLib.get_monotonic_time();
        this._mixId = GLib.timeout_add(GLib.PRIORITY_HIGH, 8, () => {
            const k = Math.min(1, (GLib.get_monotonic_time() - t0) / 160000);
            this._mix = from + (target - from) * (1 - Math.pow(1 - k, 3));
            this._onState();
            if (k >= 1) { this._mixId = 0; return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        });
    }
    _showArmPill(on) {
        const mon = Main.layoutManager.primaryMonitor;
        this._armPill.set_position(Math.round((mon.width - 44) / 2), Math.round(mon.height - 44 - 72));
        this._armPill.remove_all_transitions();
        this._armPill.ease({opacity: on ? 255 : 0, scale_x: on ? 1 : 0.6, scale_y: on ? 1 : 0.6, duration: on ? 140 : 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
    /** Speed along the swipe in state units per second over the last ~100 ms of samples. */
    _speed(now) {
        const s = this._samples; if (!s || s.length < 2) return 0;
        const last = s[s.length - 1], ref = s.find(x => last.t - x.t <= 100) ?? s[0];
        if (now - last.t > 90) return 0;                                  // finger has stopped
        return (this._gestureFromHome ? -1 : 1) * (last.p - ref.p) / Math.max(1, last.t - ref.t) * 1000;
    }
    _updateArm(progress) {
        const armed = this._travel(progress) >= R.minTravel && this._speed(GLib.get_monotonic_time() / 1000) < R.armSpeed;
        if (armed !== this._armed) { this._armed = armed; this._setMix(armed ? 1 : 0); this._showArmPill(armed); }
    }
    gestureProgress(progress) {
        // Armed for recents = far enough AND the finger has slowed down: a fast flick is always the home button.
        this._updateArm(progress);
        const now = GLib.get_monotonic_time() / 1000;
        this._samples.push({t: now, p: progress});
        while (this._samples.length > 10 || (this._samples.length > 2 && now - this._samples[0].t > 150)) this._samples.shift();
    }
    /** Two actions on the bottom swipe, decided by distance: a short swipe is the home button, a longer
     *  swipe (or a pause before lifting) opens the task list. From the home the finger travels 2 → 1 and
     *  the resting state is 2; from an app it travels 0 → 2 and a short swipe lands on the home as well. */
    gestureEnd(target, fromHome = false) {
        this.home.log?.(`recents: gestureEnd target=${target} samples=${this._samples?.length} adj=${this._adj.value.toFixed(2)} fromHome=${fromHome}`);
        this._gesture = false;
        this._showArmPill(false);
        const result = this._decide(target, fromHome);
        this._setMix(1, result !== 1);   // into the list: finish the fade-in; home or app: nothing to fade
        if (result === 2) this._homeButton();
        return result;
    }
    /** The home button also returns the launcher to its first page, as on Android. */
    _homeButton() { if (this.home.currentPage !== 0) this.home.snapToPage?.(0); }
    _decide(target, fromHome) {
        if (target === 0 || !this._tasks.length) return target === 0 ? 0 : 2;
        const s = this._samples, last = s[s.length - 1], now = GLib.get_monotonic_time() / 1000;
        const travel = fromHome ? 2 - last.p : last.p;                     // state units the finger covered
        const rest = 2;                                                    // a short swipe is the home button (a nudge back to the app returned 0 above)
        const ref = s.find(x => last.t - x.t <= 120) ?? s[0];
        const dt = Math.max(1, last.t - ref.t);
        const vel = (fromHome ? -1 : 1) * (last.p - ref.p) / dt * 1000;   // state units per second, along the swipe
        const paused = now - last.t > 90;
        this.log(`recents: release vel=${vel.toFixed(2)}/s travel=${travel.toFixed(2)} paused=${paused} tracker=${target} rest=${rest}`);
        // Android's rule: a fling up is the home button however far it went; the task list needs the swipe to be
        // long enough AND to end slowly (or with the finger resting). Measured on a phone: home flicks end at
        // 5–13 units/s, deliberate recents swipes at 0–0.1.
        if (travel < R.minTravel) return rest;
        return (paused || vel < R.armSpeed) ? 1 : rest;                            // short swipe = home, longer swipe = list
    }

    /** Swipe up from the home's nav zone: 2 → 1 under the finger. */
    homeDragBegin() {
        this.home.log?.(`recents: homeDragBegin active=${this._active} adj=${this._adj.value.toFixed(2)}`);
        this._refreshTasks();
        if (!this._tasks.length) return false;
        this._primary = this._tasks[0]; this._scroll = 0;
        this._adj.remove_transition('value');
        this._gesture = true; this._active = true; this.show(); this._onState();
        return true;
    }
    homeDragUpdate(dyUp) {
        const distance = Main.layoutManager.primaryMonitor.height * R.dragDistance;
        this._adj.value = 2 - clamp(dyUp / distance, 0, 1);
    }
    homeDragEnd(dyUp, velUp /* px/ms */) {
        this._gesture = false;
        const H = Main.layoutManager.primaryMonitor.height;
        const open = dyUp > H * R.dragDistance * R.minTravel && velUp > -0.3;
        if (!open) this._homeButton();
        this.log(`recents: homeDragEnd dyUp=${dyUp.toFixed(0)} vel=${velUp.toFixed(2)}px/ms open=${open}`);
        this._easeState(open ? 1 : 2);
    }
    _easeState(v, duration = 260) {
        v = Math.max(0, Math.min(2, v));
        this._adj.remove_transition('value');
        this._adj.ease(v, {duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // ---------------- tasks ----------------
    /** Proportional set size of the window's process, like Android's "memory" column in the task list.
     *  Read asynchronously: smaps_rollup costs 10–13 ms per process on a phone, which on the shell's
     *  main thread stalled the start of every swipe. The last value stays on the chip until the new one lands. */
    _updateMem(t) {
        const pid = t.win.get_pid?.(); if (!pid || pid <= 0) { t.mem.text = ''; return; }
        if (t._memPending) return;
        const now = GLib.get_monotonic_time();
        if (t._memAt && now - t._memAt < 5e6) return;            // at most every 5 s per task
        t._memPending = true;
        const show = text => { t._memPending = false; t._memAt = GLib.get_monotonic_time(); if (text !== null && t.mem && !t.mem._destroyed) try { t.mem.text = text; } catch (_) {} };
        const fmt = kb => { const mb = kb / 1024; return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`; };
        Gio.File.new_for_path(`/proc/${pid}/smaps_rollup`).load_contents_async(null, (f, res) => {
            try {
                const [, bytes] = f.load_contents_finish(res);
                const m = new TextDecoder().decode(bytes).match(/^Pss:\s+(\d+)/m);
                show(m ? fmt(Number(m[1])) : '');
            } catch (_) { show(''); }
        });
    }
    _refreshTasks() {
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .filter(w => !w.is_skip_taskbar() && !w.get_transient_for() && w.get_compositor_private());
        const keep = new Set(wins);
        for (const t of [...this._tasks]) if (!keep.has(t.win)) this._removeTask(t, false);
        const known = new Map(this._tasks.map(t => [t.win, t]));
        this._tasks = wins.map(w => known.get(w) ?? this._makeTask(w));     // MRU: index 0 = most recent (rightmost)
        for (const t of this._tasks) if (known.has(t.win)) this._updateMem(t);
        this._empty.visible = !this._tasks.length;
    }
    _makeTask(win) {
        const actor = win.get_compositor_private();
        const wf = win.get_frame_rect();
        // Every card is the same screen-shaped box (the work area under the panel), as Android's task cards are;
        // the window is fitted inside, so a window smaller than the screen does not make a smaller card.
        const mon = Main.layoutManager.primaryMonitor;
        const frame = {x: 0, y: Main.panel.height, width: mon.width, height: mon.height - Main.panel.height};
        const fit = Math.min(frame.width / Math.max(1, wf.width), frame.height / Math.max(1, wf.height));
        const card = new St.Widget({style_class: 'neo-task', reactive: true, clip_to_allocation: true, width: frame.width, height: frame.height, layout_manager: new Clutter.FixedLayout()});
        card.set_pivot_point(0, 0);
        // The window actor is larger than its frame (invisible borders, the panel area);
        // an inner clipped box keeps the offscreen effect's texture to the frame only.
        const inner = new Clutter.Actor({clip_to_allocation: true, width: Math.round(wf.width * fit), height: Math.round(wf.height * fit),
            x: Math.round((frame.width - wf.width * fit) / 2), y: Math.round((frame.height - wf.height * fit) / 2)});
        const clone = new Clutter.Clone({source: actor, x: Math.round((actor.x - wf.x) * fit), y: Math.round((actor.y - wf.y) * fit)});
        clone.set_scale(fit, fit);
        clone.set_clip(wf.x - actor.x, wf.y - actor.y, wf.width, wf.height);   // an explicit clip is what bounds the paint volume
        inner.add_child(clone);
        card.add_child(inner);
        const clip = new RoundedClip(); card.add_effect(clip);
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const chip = new St.BoxLayout({style_class: 'neo-task-chip', reactive: false});
        chip.add_child(iconActor(app, 24));
        chip.add_child(new St.Label({text: app?.get_name() ?? win.get_title() ?? '', y_align: Clutter.ActorAlign.CENTER}));
        const mem = new St.Label({style_class: 'neo-task-mem', text: '', y_align: Clutter.ActorAlign.CENTER});
        chip.add_child(mem);
        this._layer.insert_child_below(card, this._closeAll);
        this._layer.insert_child_below(chip, this._closeAll);
        const t = {win, actor, frame, card, chip, clip, app, mem};
        // The offscreen effect renders an empty (black) texture once the card extends above the stage's top edge
        // (not at the sides): rounded corners are switched off while the card is up there, i.e. while it flies off.
        card.connect('notify::y', () => { const on = card.y >= 0; if (clip.enabled !== on) clip.enabled = on; });
        // A moving card with an offscreen effect misreports the area it vacated: the compositor's partial update then
        // leaves striped remains of the old frame on the panel (visible on the display, never in a screenshot). A full
        // stage redraw per change is cheap at this size and removes the damage-tracking question entirely.
        for (const prop of ['x', 'y', 'opacity', 'scale-x', 'scale-y']) card.connect(`notify::${prop}`, () => global.stage.queue_redraw());
        this._updateMem(t);
        t.destroyId = actor.connect('destroy', () => { t.destroyId = 0; this._removeTask(t, true); });
        return t;
    }
    _removeTask(t, animate) {
        if (t.destroyId) { t.actor.disconnect(t.destroyId); t.destroyId = 0; }
        this._tasks = this._tasks.filter(x => x !== t);
        t.chip.destroy();
        if (animate && this.visible) t.card.ease({opacity: 0, duration: 150, onComplete: () => t.card.destroy()}); else t.card.destroy();
        if (this._primary === t) this._primary = this._tasks[0] ?? null;
        this._empty.visible = !this._tasks.length;
        if (this._active && this.visible) {
            this._scroll = clamp(this._scroll, 0, Math.max(0, this._tasks.length - 1) * this._step());
            this._relayoutAnimated();
            if (!this._tasks.length && !this._gesture) this.goHome();
        }
    }
    _clearTasks() { for (const t of [...this._tasks]) { if (t.destroyId) t.actor.disconnect(t.destroyId); t.chip.destroy(); t.card.destroy(); } this._tasks = []; this._primary = null; }
    _primaryIndex() { const i = this._tasks.indexOf(this._primary); return i < 0 ? 0 : i; }
    _step() { return Main.layoutManager.primaryMonitor.width * R.cardScale + R.gap; }

    get scroll() { return this._scroll; }
    set scroll(v) { if (v === this._scroll) return; this._scroll = v; this.notify('scroll'); this._onState(); }

    // ---------------- layout = f(state, scroll) ----------------
    _rest(k, t) {
        const mon = Main.layoutManager.primaryMonitor;
        const s = R.cardScale;
        const cx = mon.width / 2 - k * this._step() + this._scroll;
        return {x: cx - t.frame.width * s / 2, y: Main.panel.height + R.topInset, scale: s};
    }
    _place(t, k, v, animate = false) {
        const p = clamp(v, 0, 1), q = clamp(v - 1, 0, 1);
        const rest = this._rest(k, t);
        let x, y, sc, op = 255;
        if (t === this._primary) { x = lerp(t.frame.x, rest.x, p); y = lerp(t.frame.y, rest.y, p); sc = lerp(1, rest.scale, p); }
        else { const side = k > this._primaryIndex() ? -1 : 1; x = rest.x + side * (1 - p) * Main.layoutManager.primaryMonitor.width * 0.3; y = rest.y; sc = rest.scale; op = 255 * p; }
        if (q > 0) {   // shrinking towards the home, centre kept
            const cxc = x + t.frame.width * sc / 2, cyc = y + t.frame.height * sc / 2;
            sc *= 1 - R.shrinkToHome * q; x = cxc - t.frame.width * sc / 2; y = cyc - t.frame.height * sc / 2;
        }
        t.clip.setGeometry(t.frame.width, t.frame.height, Math.min(R.radius / sc, t.frame.width / 2) * p);
        const props = {x, y, scale_x: sc, scale_y: sc, opacity: op};
        if (animate) t.card.ease({...props, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_CUBIC}); else { t.card.remove_all_transitions(); t.card.set(props); }
        const [, chipW] = t.chip.get_preferred_width(-1), [, chipH] = t.chip.get_preferred_height(-1);
        const chipProps = {x: Math.round(x + (t.frame.width * sc - chipW) / 2), y: Math.round(y - chipH - R.chipGap), opacity: Math.round(255 * p * (1 - q))};
        if (animate) t.chip.ease({...chipProps, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_CUBIC}); else t.chip.set(chipProps);
    }
    _onState() {
        this._hidePicker();
        if (!this._active) return;
        let v = this._adj.value;
        const ov = Main.overview._singleFingerOverviewGesture; if (ov) { const inList = Math.abs(v - 1) < 0.01 && !this._gesture; if (ov.enabled === inList) ov.enabled = !inList; }
        if (v >= 1.995 && !this._gesture) { this._deactivate(); return; }   // a drag that begins on the home starts at 2
        if (v <= 0.005 && !this._gesture) { this.hide(); return; }
        this.show();
        // Until the swipe qualifies as recents nothing of it shows: the app (or the home) stays put. _mix blends to the real state once armed.
        const m = this._gesture || this._mixId ? this._mix : 1;
        const vReal = v;
        v = this._gestureFromHome ? lerp(2, vReal, m) : lerp(0, vReal, m);   // unarmed: the app stays exactly where it is
        const p = clamp(v, 0, 1), q = clamp(v - 1, 0, 1);
        this._scrim.opacity = Math.round(255 * p * (1 - q) * m);
        this.home.setContentOpacity(Math.round(255 * q));
        this._tasks.forEach((t, k) => {
            this._place(t, k, v);
            // from the home, nothing of the list shows until armed — the last app's card included
            const cm = (t !== this._primary || this._gestureFromHome) ? m : 1;
            t.card.opacity = Math.round(t.card.opacity * cm * (1 - q));    // and every card is gone once the home is reached
            t.chip.opacity = Math.round(t.chip.opacity * m);
        });
        const mon = Main.layoutManager.primaryMonitor;
        const [, bw] = this._closeAll.get_preferred_width(-1), [, bh] = this._closeAll.get_preferred_height(-1);
        this._closeAll.set_position(Math.round((mon.width - bw) / 2), Math.round(mon.height * R.closeAllY - bh / 2));
        this._closeAll.opacity = Math.round(255 * clamp((p - 0.6) / 0.4, 0, 1) * (1 - q) * m);
        this._closeAll.visible = this._tasks.length > 0;
        const [, ew] = this._empty.get_preferred_width(-1);
        this._empty.set_position(Math.round((mon.width - ew) / 2), Math.round(mon.height * 0.45));
        this._empty.opacity = this._scrim.opacity;
    }
    _relayoutAnimated() { const v = this._adj.value; this.home.log?.(`recents: relayout v=${v.toFixed(2)} tasks=${this._tasks.map(t => t.app?.get_name()).join(',')} scroll=${Math.round(this._scroll)}`); this._tasks.forEach((t, k) => this._place(t, k, v, true)); }
    _deactivate() {
        this._active = false; this._gesture = false;
        const ov = Main.overview._singleFingerOverviewGesture; if (ov) ov.enabled = !Main.wm.workspaceTracker?.zeroOpenWindows;
        this.hide();
        this.home.setContentOpacity(255);
        for (const t of this._tasks) t.card.remove_all_transitions();
    }

    // ---------------- interaction in the list ----------------
    _hitTask(x, y) {
        for (const t of this._tasks) {
            const sx = t.card.scale_x, sy = t.card.scale_y;
            if (x >= t.card.x && x <= t.card.x + t.frame.width * sx && y >= t.card.y && y <= t.card.y + t.frame.height * sy) return t;
        }
        return null;
    }
    get active() { return this._active; }
    _inList() { return this._active && !this._gesture && Math.abs(this._adj.value - 1) < 0.01 && !this._adj.get_transition('value'); }
    _setupGestures() {
        const pan = new Clutter.PanGesture();
        let dir = null, hit = null, scroll0 = 0, cardY0 = 0;
        pan.connect('may-recognize', () => this._inList());
        let fromNav = false;
        pan.connect('recognize', g => {
            const [cx, cy] = firstBegin(g); const [ax, ay] = this.get_transformed_position();
            fromNav = cy > Main.layoutManager.primaryMonitor.height - 48;      // the nav zone: swipe up = home
            hit = this._hitTask(cx - ax, cy - ay); dir = null; scroll0 = this._scroll; cardY0 = hit?.card.y ?? 0;
            this.home.log?.(`recents pan: recognize at ${Math.round(cx)},${Math.round(cy)} hit=${hit?.app?.get_name()} cardY0=${Math.round(cardY0)} fromNav=${fromNav}`);
            this.remove_transition('scroll');
        });
        pan.connect('pan-update', g => {
            const [dx, dy] = firstDelta(g);
            if (fromNav) return;
            if (!dir) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'; if (dir === 'v' && (!hit || dy > 0)) dir = 'x'; }
            if (dir === 'h') {
                const max = Math.max(0, this._tasks.length - 1) * this._step();
                let s = scroll0 + dx;
                if (s < 0) s = s * 0.25; if (s > max) s = max + (s - max) * 0.25;
                this.scroll = s;
            } else if (dir === 'v') {
                const y = cardY0 + Math.min(0, dy);
                const [, chipH] = hit.chip.get_preferred_height(-1);
                hit.card.y = y; hit.chip.y = Math.round(y - chipH - R.chipGap);
                hit.card.opacity = Math.round(255 * (1 - clamp(-dy / (hit.frame.height * hit.card.scale_y), 0, 1) * 0.6));
            }
        });
        pan.connect('end', g => {
            const [dx, dy] = firstDelta(g);
            if (fromNav) { fromNav = false; if (dy < -40 || g.get_velocity().get_y() < -0.5) this.goHome(); return; }
            const vel = g.get_velocity();
            if (dir === 'h') {
                const step = this._step(); const vx = vel.get_x();
                let idx = Math.round((this._scroll + vx * 180) / step);
                idx = clamp(idx, 0, Math.max(0, this._tasks.length - 1));
                this.ease_property('scroll', idx * step, {duration: 320, mode: Clutter.AnimationMode.EASE_OUT_QUINT});
            } else if (dir === 'v' && hit) {
                const travel = -dy / (hit.frame.height * hit.card.scale_y);
                this.home.log?.(`recents pan: end dir=v dy=${Math.round(dy)} travel=${travel.toFixed(2)} vy=${vel.get_y().toFixed(2)} → ${travel > R.dismissFraction || -vel.get_y() > R.dismissVelocity ? 'dismiss' : 'restore'} ${hit.app?.get_name()}`);
                if (travel > R.dismissFraction || -vel.get_y() > R.dismissVelocity) this.dismiss(hit); else this._place(hit, this._tasks.indexOf(hit), 1, true);
            }
            dir = null; hit = null;
        });
        pan.connect('cancel', () => { this.home.log?.(`recents pan: cancel dir=${dir} hit=${hit?.app?.get_name()}`); if (dir === 'v' && hit) this._place(hit, this._tasks.indexOf(hit), 1, true); dir = null; hit = null; });
        this.home.guardBack?.(pan); this._layer.add_action(pan);

        const click = new Clutter.ClickGesture();
        click.connect('may-recognize', () => this._inList());
        click.connect('recognize', g => {
            const c = g.get_point_coords_abs(0); const [ax, ay] = this.get_transformed_position();
            const t = this._hitTask(c.x - ax, c.y - ay);
            if (t) this.activate(t); else this.goHome();
        });
        this._layer.add_action(click);
        // The bottom 18 px belong to the shell's bottomPanelBox, so a stage-level edge drag (capture phase) is what sees
        // a swipe up from the very edge while the list is shown: home, as Android's nav-bar swipe in Overview.
        this._edge = new Shell.EdgeDragGesture({side: St.Side.BOTTOM});
        this._edge.connect('may-recognize', () => this._inList());
        this._edge.connect('recognize', () => this.goHome());
        global.stage.add_action_full('neo-recents-edge', Clutter.EventPhase.CAPTURE, this._edge);
    }

    activate(t) {
        this._primary = t;
        this.log(`recents: activate ${t.win.get_title()}`);
        Main.activateWindow(t.win);
    }
    /** TaskView.dismiss: the card leaves the list at once (the neighbours slide into the gap) while it flies off;
     *  the window is closed only when the card is gone, so the shell's own close animation never shows inside it. */
    dismiss(t) {
        this.home.log?.(`recents: dismiss ${t.app?.get_name()} tasks=${this._tasks.length} adj=${this._adj.value.toFixed(2)}`);
        const H = Main.layoutManager.primaryMonitor.height;
        this._detachTask(t);
        t.chip.ease({opacity: 0, duration: 120});
        t.card.ease({y: -H * 0.6, opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => {
            const win = t.win; t.chip.destroy(); t.card.destroy();
            win.delete(global.get_current_time());
            if (!this._tasks.length && !this._gesture) this.goHome();
        }});
    }
    /** Take a task out of the list and bookkeeping without touching its actors. */
    _detachTask(t) {
        if (t.destroyId) { t.actor.disconnect(t.destroyId); t.destroyId = 0; }
        this._tasks = this._tasks.filter(x => x !== t);
        if (this._primary === t) this._primary = this._tasks[0] ?? null;
        this._empty.visible = !this._tasks.length;
        if (this._active && this.visible) {
            this._scroll = clamp(this._scroll, 0, Math.max(0, this._tasks.length - 1) * this._step());
            this._relayoutAnimated();
        }
    }
    closeAll() {
        const H = Main.layoutManager.primaryMonitor.height;
        const tasks = [...this._tasks];
        tasks.forEach((t, k) => {
            this._detachTask(t);
            t.chip.ease({opacity: 0, duration: 120});
            t.card.ease({y: -H * 0.6, opacity: 0, duration: 200, delay: k * 40, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => { const win = t.win; t.chip.destroy(); t.card.destroy(); win.delete(global.get_current_time()); }});
        });
        if (this._closeAllTimer) GLib.source_remove(this._closeAllTimer);
        this._closeAllTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200 + tasks.length * 40 + 50, () => { this._closeAllTimer = 0; this.goHome(); return GLib.SOURCE_REMOVE; });
    }
    goHome() { this._easeState(2); }
});
