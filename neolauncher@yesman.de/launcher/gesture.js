// Pan deltas from the FIRST contact of a Clutter.PanGesture. The gesture's own get_delta() is centroid
// based: a second contact that flickers in and out (palm, ghost touch on this digitizer) shifts the
// centroid by half its distance on every frame, and anything that followed the finger jittered.
export function firstDelta(g) {
    try {
        if (g.get_n_points() >= 1) {
            const b = g.get_point_begin_coords_abs(0), c = g.get_point_coords_abs(0);
            return [c.x - b.x, c.y - b.y];
        }
    } catch (_) {}
    const [, total] = g.get_delta(); return [total.get_x(), total.get_y()];
}
/** Absolute coordinates of the first contact right now. */
export function firstPoint(g) {
    try { if (g.get_n_points() >= 1) { const c = g.get_point_coords_abs(0); return [c.x, c.y]; } } catch (_) {}
    const c = g.get_centroid_abs(); return [c.x, c.y];
}
/** Where the first contact began. */
export function firstBegin(g) {
    try { if (g.get_n_points() >= 1) { const c = g.get_point_begin_coords_abs(0); return [c.x, c.y]; } } catch (_) {}
    const c = g.get_begin_centroid_abs(); return [c.x, c.y];
}
