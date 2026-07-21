# Gnube Config Manager

GNOME Shell extension for switching Kubernetes kubeconfig files and contexts from the top bar.

## Features

- Panel icon (or current context label) in the top bar
- Switch kubectl contexts from the menu
- Configure multiple kubeconfig file or directory paths in preferences
- Directories are scanned recursively; every regular file is treated as a kubeconfig
- Select a single kubeconfig, or merge all (colon-separated `KUBECONFIG`)
- Exports `KUBECONFIG` via:
  - the gnome-shell process environment
  - `systemctl --user set-environment`
  - `~/.config/environment.d/99-gnube-config-manager.conf` (picked up on next login)

## Dependencies

- `kubectl` or `oc` on `PATH`
- GNOME Shell 45+ (including 49)

## Install from git

```bash
make install
```

Then reload GNOME Shell (log out/in on Wayland) and enable the extension:

```bash
gnome-extensions enable gnube-config-manager@dav1x
```

Open preferences to add kubeconfig paths:

```bash
gnome-extensions prefs gnube-config-manager@dav1x
```

## Notes

- Both `kubectl` and `oc` read `KUBECONFIG`.
- The extension exports a **stable** path:
  `~/.config/gnube-config-manager/kubeconfig`
  (symlink to the active file, or a flattened merge). Cluster switches retarget
  that path, so existing shells pick up the new cluster on the next command.
- Add this once to `~/.bashrc` (or equivalent):

```bash
[ -f ~/.config/gnube-config-manager/env.sh ] && . ~/.config/gnube-config-manager/env.sh
```

- Then open a new terminal (or `source ~/.bashrc`). After that, switching
  clusters in the panel is enough — no need to re-export `KUBECONFIG` each time.
- `environment.d` / systemd updates cover newly launched apps from the session.
