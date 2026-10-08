# Neo Launcher for GNOME Shell mobile
UUID    = neolauncher@yesman.de
SRC     = $(UUID)
ZIP     = $(UUID).shell-extension.zip

VER     = $(shell sed -n 's/^pkgver=//p' packaging/alpine/APKBUILD)
DIST    = neolauncher-gnome-shell-$(VER)

.PHONY: pack install uninstall enable phone check clean dist apk

pack:                                  ## build $(ZIP) (gnome-extensions pack when available, else a plain zip with compiled schemas)
	glib-compile-schemas --strict --dry-run $(SRC)/schemas
	rm -f $(ZIP)
	@if command -v gnome-extensions >/dev/null; then \
	  gnome-extensions pack --force --extra-source=launcher --extra-source=assets --extra-source=stylesheet.css $(SRC); \
	  zip -qd $(ZIP) 'launcher/dev.js' >/dev/null 2>&1 || true; \
	else \
	  tmp=$$(mktemp -d); cp -r $(SRC) $$tmp/ext; glib-compile-schemas $$tmp/ext/schemas; \
	  (cd $$tmp/ext && zip -qr ../$(ZIP) . -x '*.pyc' -x 'launcher/dev.js') && mv $$tmp/$(ZIP) . && rm -rf $$tmp; \
	fi
	@ls -la $(ZIP)

install: pack                          ## install for the current user (log out and in afterwards)
	gnome-extensions install --force $(ZIP)

enable:
	gnome-extensions enable $(UUID)

uninstall:
	gnome-extensions uninstall $(UUID)

phone:                                 ## development: rsync to the phone and hot-reload (see install.sh)
	./install.sh

check:                                 ## parse every module (node --check understands the ESM syntax; gi:// imports are not resolved)
	@for f in $(SRC)/launcher/*.js $(SRC)/extension.js $(SRC)/prefs.js; do \
	  cp $$f /tmp/neo-check.mjs && node --check /tmp/neo-check.mjs && echo "ok  $$f" || { echo "FAIL $$f"; exit 1; }; \
	done

dist:                                  ## source tarball for distribution packages ($(DIST).tar.gz)
	rm -rf /tmp/$(DIST) && mkdir -p /tmp/$(DIST)
	cp -r $(SRC) tools README.md LICENSE Makefile /tmp/$(DIST)/
	find /tmp/$(DIST) -name '__pycache__' -prune -exec rm -rf {} +
	rm -f /tmp/$(DIST)/$(UUID)/launcher/dev.js        # developer-only (Eval/Reload over D-Bus)
	tar -C /tmp -czf $(DIST).tar.gz $(DIST) && rm -rf /tmp/$(DIST)
	@ls -la $(DIST).tar.gz

apk: check                             ## Alpine package, built on the phone (see packaging/alpine/)
	packaging/alpine/build-on-device.sh

clean:
	rm -f $(ZIP) $(DIST).tar.gz
