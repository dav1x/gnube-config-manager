import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { execCommunicateAsync } from './commandLineUtil.js';
import { expandPath, resolvePaths } from './kubeEnv.js';

/**
 * @typedef {{
 *   name: string,
 *   server: string,
 *   defaultLabel: string,
 *   kubeconfig: string,
 *   contexts: string[],
 *   currentContext: string,
 *   duplicateName: boolean,
 * }} ClusterEntry
 */

/**
 * Stable settings key for a cluster entry.
 *
 * @param {string} name kubeconfig cluster name
 * @param {string} kubeconfig absolute path
 * @returns {string}
 */
export function clusterEntryKey(name, kubeconfig) {
    return `${name}\n${expandPath(kubeconfig)}`;
}

/**
 * Derive a display label from a kubeconfig server URL.
 * `https://api.citrine.jade.bos2.lab:6443` → `api.citrine.jade.bos2.lab`
 *
 * @param {string} server
 * @returns {string}
 */
export function labelFromServerUrl(server) {
    if (!server)
        return '';

    let host = server.trim();
    host = host.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    // strip path/query/fragment
    host = host.split('/')[0].split('?')[0].split('#')[0];
    // strip userinfo
    const at = host.lastIndexOf('@');
    if (at >= 0)
        host = host.slice(at + 1);
    // strip port (handle [ipv6]:port)
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        host = end >= 0 ? host.slice(1, end) : host;
    } else {
        const colon = host.lastIndexOf(':');
        if (colon >= 0 && /^\d+$/.test(host.slice(colon + 1)))
            host = host.slice(0, colon);
    }
    return host;
}

/**
 * @returns {string|null}
 */
export function findKubectlExe() {
    for (const exe of ['kubectl', 'oc']) {
        const found = GLib.find_program_in_path(exe);
        if (found)
            return found;
    }
    return null;
}

/**
 * @param {string} kubectlExe
 * @param {string|null} kubeconfig
 * @param {string[]} args
 * @returns {string[]}
 */
function argv(kubectlExe, kubeconfig, ...args) {
    const out = [kubectlExe];
    if (kubeconfig)
        out.push('--kubeconfig', kubeconfig);
    out.push(...args);
    return out;
}

/**
 * @param {string} kubectlExe
 * @param {string} path
 * @returns {Promise<{
 *   path: string,
 *   currentContext: string,
 *   contexts: {name: string, cluster: string}[],
 *   clusters: {name: string, server: string, defaultLabel: string}[],
 * }|null>}
 */
export async function getConfigSummary(kubectlExe, path) {
    if (!kubectlExe || !path)
        return null;

    try {
        const output = await execCommunicateAsync(
            argv(kubectlExe, path, 'config', 'view', '-o', 'json'));
        const data = JSON.parse(output);
        const contexts = (data.contexts || []).map(c => ({
            name: c.name,
            cluster: c.context?.cluster || '',
        })).filter(c => c.name);

        /** @type {Map<string, {name: string, server: string, defaultLabel: string}>} */
        const clusterMap = new Map();
        for (const c of data.clusters || []) {
            if (!c?.name)
                continue;
            const server = c.cluster?.server || '';
            clusterMap.set(c.name, {
                name: c.name,
                server,
                defaultLabel: labelFromServerUrl(server) || c.name,
            });
        }
        for (const ctx of contexts) {
            if (!ctx.cluster || clusterMap.has(ctx.cluster))
                continue;
            clusterMap.set(ctx.cluster, {
                name: ctx.cluster,
                server: '',
                defaultLabel: ctx.cluster,
            });
        }

        return {
            path,
            currentContext: data['current-context'] || '',
            contexts,
            clusters: [...clusterMap.values()],
        };
    } catch (e) {
        console.error(`cannot read kubeconfig ${path}: ${e}`);
        return null;
    }
}

/**
 * @param {ClusterEntry[]} entries
 * @returns {string[]}
 */
export function findDuplicateClusterNames(entries) {
    const counts = new Map();
    for (const entry of entries)
        counts.set(entry.name, (counts.get(entry.name) || 0) + 1);

    return [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name)
        .sort();
}

/**
 * @param {string} path
 * @returns {number} unix mtime seconds, or 0
 */
function fileMtime(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'time::modified', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_modification_date_time()?.to_unix() ?? 0;
    } catch (_e) {
        return 0;
    }
}

/**
 * @param {string[]} paths absolute or ~/ kubeconfig paths/dirs
 * @param {string|null} [kubectlExe]
 * @returns {Promise<ClusterEntry[]>}
 */
export async function listClusterEntries(paths, kubectlExe = null) {
    const exe = kubectlExe || findKubectlExe();
    if (!exe)
        return [];

    const files = resolvePaths(paths);
    /** @type {(ClusterEntry & { _mtime: number, _order: number })[]} */
    const candidates = [];
    const seenExact = new Set();
    let order = 0;

    for (const path of files) {
        const summary = await getConfigSummary(exe, path);
        if (!summary)
            continue;

        const mtime = fileMtime(path);

        for (const cluster of summary.clusters) {
            const key = clusterEntryKey(cluster.name, path);
            if (seenExact.has(key))
                continue;
            seenExact.add(key);

            const contexts = summary.contexts
                .filter(c => c.cluster === cluster.name)
                .map(c => c.name);
            if (contexts.length === 0)
                continue;

            const currentForCluster = contexts.includes(summary.currentContext)
                ? summary.currentContext
                : contexts[0];

            candidates.push({
                name: cluster.name,
                server: cluster.server,
                defaultLabel: cluster.defaultLabel || cluster.name,
                kubeconfig: path,
                contexts,
                currentContext: currentForCluster,
                duplicateName: false,
                _mtime: mtime,
                _order: order++,
            });
        }
    }

    // Same default server hostname ⇒ keep oldest (earliest mtime / scan order), drop newer
    /** @type {Map<string, typeof candidates[0]>} */
    const byLabel = new Map();
    const dropped = [];

    for (const entry of candidates) {
        const label = entry.defaultLabel || entry.name;
        const existing = byLabel.get(label);
        if (!existing) {
            byLabel.set(label, entry);
            continue;
        }

        const entryIsNewer = entry._mtime > existing._mtime ||
            (entry._mtime === existing._mtime && entry._order > existing._order);

        if (entryIsNewer) {
            dropped.push(entry);
        } else {
            dropped.push(existing);
            byLabel.set(label, entry);
        }
    }

    if (dropped.length > 0) {
        console.debug(
            `dropping ${dropped.length} duplicate cluster(s) by server label: ` +
            dropped.map(e => `${e.defaultLabel} (${e.name} @ ${e.kubeconfig})`).join('; '));
    }

    /** @type {ClusterEntry[]} */
    const entries = [...byLabel.values()]
        .sort((a, b) => a._order - b._order)
        .map(({ _mtime, _order, ...entry }) => entry);

    const duplicateNames = new Set(findDuplicateClusterNames(entries));
    for (const entry of entries)
        entry.duplicateName = duplicateNames.has(entry.name);

    return entries;
}

/**
 * @param {Gio.Settings} settings
 * @returns {Record<string, string>}
 */
export function getClusterLabelMap(settings) {
    try {
        return settings.get_value('cluster-labels').deep_unpack();
    } catch (_e) {
        return {};
    }
}

/**
 * @param {Gio.Settings} settings
 * @param {Record<string, string>} map
 */
export function setClusterLabelMap(settings, map) {
    settings.set_value('cluster-labels', new GLib.Variant('a{ss}', map));
}

/**
 * Resolve the label to show for a cluster.
 *
 * @param {ClusterEntry} entry
 * @param {Record<string, string>} labelMap
 * @returns {string}
 */
export function displayLabelForCluster(entry, labelMap) {
    const key = clusterEntryKey(entry.name, entry.kubeconfig);
    const custom = (labelMap[key] || '').trim();
    if (custom)
        return custom;

    const base = (entry.defaultLabel || entry.name || '').trim() || entry.name;
    if (!entry.duplicateName)
        return base;

    const home = expandPath('~');
    let path = entry.kubeconfig;
    if (path.startsWith(`${home}/`))
        path = `~/${path.slice(home.length + 1)}`;

    if (entry.name && entry.name !== base)
        return `${base} (${entry.name}) — ${path}`;
    return `${base} — ${path}`;
}
