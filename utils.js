import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * @param {Function} mainFunction
 * @param {number} delayMs throttle delay in milliseconds
 * @returns {Function}
 */
export function throttle(mainFunction, delayMs) {
    let timerId = 0;

    return (...args) => {
        if (timerId !== 0)
            return;

        mainFunction(...args);
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            timerId = 0;
            return GLib.SOURCE_REMOVE;
        });
    };
}

/**
 * @param {string[]} argv
 * @param {string|null} cwd
 * @returns {string|null}
 */
function execSync(argv, cwd = null) {
    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        if (cwd)
            launcher.set_cwd(cwd);

        const proc = launcher.spawnv(argv);
        const [, stdout] = proc.communicate_utf8(null, null);
        if (proc.get_exit_status() !== 0)
            return null;
        return stdout.trim() || null;
    } catch (_e) {
        return null;
    }
}

/**
 * Resolve short git commit for an extension install/source path.
 * Prefers a live `git` lookup walking up from @extensionPath, then a
 * `commit` file written at build/install time.
 *
 * @param {string} extensionPath
 * @returns {string}
 */
export function resolveCommitHash(extensionPath) {
    let dir = extensionPath;
    for (let i = 0; i < 8 && dir; i++) {
        const gitPath = GLib.build_filenamev([dir, '.git']);
        if (GLib.file_test(gitPath, GLib.FileTest.EXISTS)) {
            const hash = execSync(['git', 'rev-parse', '--short', 'HEAD'], dir);
            if (hash)
                return hash;
        }
        const parent = GLib.path_get_dirname(dir);
        if (!parent || parent === dir)
            break;
        dir = parent;
    }

    try {
        const commitFile = Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, 'commit']));
        const [, bytes] = commitFile.load_contents(null);
        const text = new TextDecoder().decode(bytes).trim();
        if (text)
            return text;
    } catch (_e) {
        // ignore
    }

    return 'unknown';
}

/**
 * Display version like `0.1-b7b3112`.
 *
 * @param {{'version-name'?: string, version?: number|string}} metadata
 * @param {string} extensionPath
 * @returns {string}
 */
export function displayVersion(metadata, extensionPath) {
    const raw = metadata['version-name'] || String(metadata.version || '0');
    const base = String(raw).split('-')[0] || '0';
    return `${base}-${resolveCommitHash(extensionPath)}`;
}
