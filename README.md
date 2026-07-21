# Gnube Config Manager

GNOME Shell extension for switching Kubernetes kubeconfig files and contexts from the top bar.

## Features

- Panel icon (or current context label) in the top bar
- Switch kubectl contexts from the menu
- Configure multiple kubeconfig file or directory paths in preferences
- Directories are scanned one level deep; every regular file is treated as a kubeconfig
- Select a single kubeconfig, or merge all (colon-separated `KUBECONFIG`)
- Exports `KUBECONFIG` via:
  - the gnome-shell process environment (inherited by apps like Kitty launched from the shell)
  - `systemctl --user set-environment`
  - `~/.config/environment.d/99-gnube-config-manager.conf` (picked up on next login)
  - `~/.config/gnube-config-manager/env.sh`, sourced by `~/.bashrc.d/99-gnube-config-manager.sh` (needed for Ptyxis)

## Dependencies

- `kubectl` or `oc` on `PATH`
- GNOME Shell 45+ (including 50 / Fedora 44)

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
- **Kitty** (and similar terminals started as children of gnome-shell) inherit
  `KUBECONFIG` from the shell process after a cluster switch.
- **Ptyxis** (the default GNOME terminal) starts shells via `ptyxis-agent`, which
  does not inherit that environment. On each cluster switch the extension
  installs `~/.bashrc.d/99-gnube-config-manager.sh`, which sources
  `~/.config/gnube-config-manager/env.sh`. Open a **new** Ptyxis tab after the
  first switch (existing tabs keep their old environment). Remove the snippet
  file to disable this hook.
- If your `~/.bashrc` does not load `~/.bashrc.d`, add once:

```bash
[ -f ~/.config/gnube-config-manager/env.sh ] && . ~/.config/gnube-config-manager/env.sh
```

- `environment.d` / systemd updates cover newly launched apps from the session.
