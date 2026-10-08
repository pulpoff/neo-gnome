// Developer-only D-Bus methods: Reload (hot reload, install.sh) and Eval (tools-eval.sh).
//
// NOT SHIPPED. Eval runs arbitrary code inside the compositor for any client on the session bus, so it
// exists only in a developer checkout: `make pack`, `make dist` and the APK exclude this file, and
// extension.js imports it only when it is present AND NEOLAUNCHER_DEV=1 or ~/.config/neolauncher/dev-mode
// says this is a development phone. extension.js merges these methods into de.yesman.NeoLauncher.

export const METHODS_XML = `
    <method name="Reload"><arg type="s" direction="out" name="result"/></method>
    <method name="Eval"><arg type="s" direction="in" name="code"/><arg type="s" direction="out" name="result"/></method>`;

/** The D-Bus handlers, bound to the extension object. */
export function methods(ext, Main) {
    return {
        Reload() { return ext.reload(); },
        /** Evaluate JS inside the shell with `ext`, `home` and `Main` in scope. */
        Eval(code) {
            try {
                const fn = new Function('ext', 'home', 'Main', 'imports', code);
                const r = fn(ext, ext.home, Main, globalThis.imports);
                return typeof r === 'string' ? r : JSON.stringify(r) ?? String(r);
            } catch (e) { return `ERROR: ${e.message}\n${e.stack}`; }
        },
    };
}
