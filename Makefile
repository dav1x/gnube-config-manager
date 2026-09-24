INSTALLBASE = $(HOME)/.local/share/gnome-shell/extensions
INSTALLNAME = gnube-config-manager@dav1x
NAME = gnube-config-manager

BASE_MODULES = extension.js metadata.json LICENSE README.md
EXTRA_MODULES = kubeIndicator.js kubePopupMenuItem.js prefs.js kubectl.js commandLineUtil.js utils.js kubeEnv.js clusterUtil.js

clean:
	rm -rf _build
	rm -f ./schemas/gschemas.compiled

install: build
	rm -rf $(INSTALLBASE)/$(INSTALLNAME)
	mkdir -p $(INSTALLBASE)/$(INSTALLNAME)
	cp -r ./_build/* $(INSTALLBASE)/$(INSTALLNAME)/

# Local convenience only — GNOME Shell 45+ compiles schemas itself; do not ship
# schemas/gschemas.compiled in packages or installs.
compile-schemas:
	glib-compile-schemas ./schemas/

build:
	rm -rf ./_build
	mkdir _build
	cp $(BASE_MODULES) $(EXTRA_MODULES) _build
	mkdir -p _build/schemas
	cp schemas/*.gschema.xml _build/schemas/
	cp -r icons _build
	cp -r lib _build

package: build
	cd _build ; \
	zip -qr "$(NAME).zip" .
	mv _build/$(NAME).zip ./
