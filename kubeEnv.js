import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { execCommunicateAsync } from './commandLineUtil.js';

const ENV_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'environment.d']);
const ENV_FILE = GLib.build_filenamev([ENV_DIR, '99-gnube-config-manager.conf']);
const STATE_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'gnube-config-manager']);
const SHELL_ENV_FILE = GLib.build_filenamev([STATE_DIR, 'env.sh']);
/** Fedora/bashrc.d hook so Ptyxis and other non-shell-child terminals get KUBECONFIG. */
const BASHRC_D_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.bashrc.d']);
const BASHRC_D_SNIPPET = GLib.build_filenamev([BASHRC_D_DIR, '99-gnube-config-manager.sh']);
/** Stable path that shells should export; retargeted on each switch. */
export const MANAGED_KUBECONFIG = GLib.build_filenamev([STATE_DIR, 'kubeconfig']);

/**
 * Expand ~ and resolve a kubeconfig path.
 *
 * @param {string} path
 * @returns {string}
 */
export function expandPath(path) {
    if (!path)
        return '';
    if (path.startsWith('~/') || path === '~')
        return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
    return path;
}

/**
 * Whether a path is a directory.
 *
 * @param {string} path absolute path
 * @returns {boolean}
 */
export function isDirectory(path) {
    const file = Gio.File.new_for_path(path);
    try {
        const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_file_type() === Gio.FileType.DIRECTORY;
    } catch (_e) {
        return false;
    }
}

/**
 * Collect regular files under a directory (recursive).
 * Skips hidden names (leading '.').
 *
 * @param {string} dirPath
 * @returns {string[]}
 */
export function listFilesInDirectory(dirPath) {
    const results = [];
    const dir = Gio.File.new_for_path(dirPath);

    const visit = directory => {
        let enumerator;
        try {
            enumerator = directory.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null);
        } catch (_e) {
            return;
        }

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name || name.startsWith('.'))
                continue;

            const child = directory.get_child(name);
            const type = info.get_file_type();
            if (type === Gio.FileType.DIRECTORY) {
                visit(child);
            } else if (type === Gio.FileType.REGULAR) {
                results.push(child.get_path());
            }
        }
        enumerator.close(null);
    };

    visit(dir);
    results.sort();
    return results;
}

/**
 * Resolve configured kubeconfig paths to concrete files.
 * Directory entries are expanded to every regular file beneath them.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function resolvePaths(paths) {
    const files = [];
    const seen = new Set();

    for (const raw of paths) {
        const path = expandPath(raw);
        if (!path)
            continue;

        const candidates = isDirectory(path)
            ? listFilesInDirectory(path)
            : [path];

        for (const candidate of candidates) {
            if (!candidate || seen.has(candidate))
                continue;
            seen.add(candidate);
            files.push(candidate);
        }
    }

    return files;
}

/**
 * Build the underlying kubeconfig path(s) from settings (always absolute).
 *
 * @param {string[]} paths configured paths
 * @param {boolean} merge whether to merge all paths
 * @param {string} active selected path when not merging
 * @returns {string}
 */
export function buildKubeconfigValue(paths, merge, active) {
    const resolved = resolvePaths(paths);
    if (resolved.length === 0)
        return expandPath('~/.kube/config');

    if (merge)
        return resolved.join(':');

    const activeExpanded = expandPath(active);
    if (activeExpanded && resolved.includes(activeExpanded))
        return activeExpanded;

    if (activeExpanded)
        return activeExpanded;

    return resolved[0];
}

/**
 * Point the managed kubeconfig path at `normalized` (symlink or flattened file).
 * Shells should always use MANAGED_KUBECONFIG so switches apply without re-export.
 *
 * @param {string} normalized colon-separated absolute path(s)
 * @param {string} extensionUuid
 * @returns {Promise<string>} managed path to export as KUBECONFIG
 */
async function updateManagedKubeconfig(normalized, extensionUuid) {
    const stateDir = Gio.File.new_for_path(STATE_DIR);
    if (!stateDir.query_exists(null))
        stateDir.make_directory_with_parents(null);

    const managed = Gio.File.new_for_path(MANAGED_KUBECONFIG);
    const parts = normalized.split(':').filter(Boolean);

    // Remove existing managed path (symlink or file)
    try {
        if (managed.query_exists(null))
            managed.delete(null);
    } catch (e) {
        console.error(`${extensionUuid}: cannot replace managed kubeconfig: ${e}`);
    }

    if (parts.length === 1) {
        // Symlink so kubectl/oc always re-resolve the active file
        managed.make_symbolic_link(parts[0], null);
    } else {
        // Flatten merged configs into a real file at the managed path
        const flattened = await execCommunicateAsync([
            'env', `KUBECONFIG=${normalized}`,
            'kubectl', 'config', 'view', '--flatten', '--merge=true',
        ]);
        GLib.file_set_contents(MANAGED_KUBECONFIG, `${flattened}\n`);
    }

    return MANAGED_KUBECONFIG;
}

/**
 * Persist KUBECONFIG for kubectl and oc.
 *
 * Exports a stable managed path (~/.config/gnube-config-manager/kubeconfig).
 * Switching clusters retargets that path, so existing shells keep working
 * without re-sourcing env vars.
 *
 * @param {string} value colon-separated absolute kubeconfig path(s)
 * @param {string} [extensionUuid]
 */
export async function setKubeconfigEnv(value, extensionUuid = 'gnube-config-manager') {
    const normalized = value.split(':').map(expandPath).filter(Boolean).join(':');
    if (!normalized)
        return;

    let exportPath = normalized;
    try {
        exportPath = await updateManagedKubeconfig(normalized, extensionUuid);
    } catch (e) {
        console.error(`${extensionUuid}: managed kubeconfig update failed, using raw paths: ${e}`);
        exportPath = normalized;
    }

    GLib.setenv('KUBECONFIG', exportPath, true);
    if (GLib.getenv('KUBECONFIG') !== exportPath)
        console.error(`${extensionUuid}: GLib.setenv(KUBECONFIG) did not stick`);

    try {
        const envDir = Gio.File.new_for_path(ENV_DIR);
        if (!envDir.query_exists(null))
            envDir.make_directory_with_parents(null);

        const envContents =
            `# Managed by ${extensionUuid} — used by kubectl and oc\n` +
            `# This path is a symlink (or flattened file) updated on each cluster switch.\n` +
            `KUBECONFIG=${exportPath}\n`;
        GLib.file_set_contents(ENV_FILE, envContents);
    } catch (e) {
        console.error(`${extensionUuid}: failed to write environment.d: ${e}`);
    }

    try {
        const shellContents =
            `# Managed by ${extensionUuid}\n` +
            `# Sourced from ~/.bashrc.d/99-gnube-config-manager.sh (installed automatically).\n` +
            `# Cluster switches retarget the managed kubeconfig symlink; no re-export needed.\n` +
            `export KUBECONFIG='${exportPath.replace(/'/g, `'\\''`)}'\n`;
        GLib.file_set_contents(SHELL_ENV_FILE, shellContents);
    } catch (e) {
        console.error(`${extensionUuid}: failed to write shell env file: ${e}`);
    }

    // Ptyxis (and similar) spawn shells via an agent that does not inherit
    // gnome-shell's GLib.setenv; source env.sh from ~/.bashrc.d instead.
    try {
        const bashrcDir = Gio.File.new_for_path(BASHRC_D_DIR);
        if (!bashrcDir.query_exists(null))
            bashrcDir.make_directory_with_parents(null);

        const snippetContents =
            `# Managed by ${extensionUuid} — remove this file to disable\n` +
            `[ -f "${SHELL_ENV_FILE}" ] && . "${SHELL_ENV_FILE}"\n`;
        GLib.file_set_contents(BASHRC_D_SNIPPET, snippetContents);
    } catch (e) {
        console.error(`${extensionUuid}: failed to write bashrc.d snippet: ${e}`);
    }

    try {
        await execCommunicateAsync([
            'systemctl', '--user', 'set-environment', `KUBECONFIG=${exportPath}`,
        ]);
    } catch (e) {
        console.error(`${extensionUuid}: systemctl set-environment failed: ${e}`);
    }

    try {
        await execCommunicateAsync([
            'env', '-u', 'KUBECONFIG', `KUBECONFIG=${exportPath}`,
            'dbus-update-activation-environment', '--systemd', 'KUBECONFIG',
        ]);
    } catch (e) {
        console.error(`${extensionUuid}: dbus-update-activation-environment failed: ${e}`);
    }
}
