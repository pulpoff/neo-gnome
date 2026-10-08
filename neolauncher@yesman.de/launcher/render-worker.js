#!/usr/bin/env -S gjs -m
// Icon render worker: one JSON job per stdin line, one result line per job on stdout:
//   ok <key>    the PNG is at job.path        none <key>    nothing custom applies (show the stock icon)
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const {Renderer} = await import(`file://${here}/iconrender.js`);
const input = new Gio.DataInputStream({base_stream: new Gio.UnixInputStream({fd: 0, close_fd: false})});
const out = new Gio.DataOutputStream({base_stream: new Gio.UnixOutputStream({fd: 1, close_fd: false})});
for (;;) {
    const [line] = input.read_line_utf8(null);
    if (line === null) break;
    if (!line.trim()) continue;
    let res = 'none', key = '?';
    try {
        const job = JSON.parse(line); key = job.key;
        const tmp = job.path + '.part';
        if (new Renderer(job).run(job.px, tmp)) { GLib.rename(tmp, job.path); res = 'ok'; }
    } catch (e) { printerr(`render: ${e.message}`); }
    out.put_string(`${res} ${key}\n`, null); out.flush(null);
}
