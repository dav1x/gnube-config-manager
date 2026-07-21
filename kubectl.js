import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { execCommunicateAsync } from './commandLineUtil.js';
import {
    findDuplicateClusterNames,
    listClusterEntries,
} from './clusterUtil.js';

class BaseKubectl {
    static _kubectlExes = ['kubectl', 'oc'];
    static _kubectlExe = null;
    static _extensionUUID = '';

    /**
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
     */
    static init(extension) {
        this._extensionUUID = extension.metadata.uuid;

        for (const exe of this._kubectlExes) {
            const found = GLib.find_program_in_path(exe);
            if (found !== null) {
                this._kubectlExe = found;
                return;
            }
        }

        Main.notifyError(this._extensionUUID, _(`${this._kubectlExes.join(' or ')} not in PATH`));
    }

    /**
     * @param {string|null} kubeconfig
     * @param {string[]} args
     * @returns {string[]}
     */
    static _argv(kubeconfig, ...args) {
        const argv = [this._kubectlExe];
        if (kubeconfig)
            argv.push('--kubeconfig', kubeconfig);
        argv.push(...args);
        return argv;
    }
}

/**
 * @typedef {import('./clusterUtil.js').ClusterEntry} ClusterEntry
 */

export class Kubectl extends BaseKubectl {
    /**
     * Names that appear more than once across kubeconfig files.
     *
     * @param {ClusterEntry[]} entries
     * @returns {string[]}
     */
    static findDuplicateClusterNames(entries) {
        return findDuplicateClusterNames(entries);
    }

    /**
     * Collect clusters across kubeconfig files.
     * Exact duplicates (same name + same file) are skipped.
     * Same name from different files are kept and marked `duplicateName`.
     *
     * @param {string[]} paths
     * @returns {Promise<ClusterEntry[]>}
     */
    static async listClusters(paths) {
        const entries = await listClusterEntries(paths, this._kubectlExe);
        const dups = findDuplicateClusterNames(entries);
        if (dups.length > 0) {
            console.warn(
                `${this._extensionUUID}: duplicate cluster names across kubeconfigs: ` +
                `${dups.join(', ')}`);
        }
        return entries;
    }

    /**
     * @param {string|undefined} context
     * @param {string|null} [kubeconfig]
     * @returns {Promise<string>}
     */
    static async version(context, kubeconfig = null) {
        if (this._kubectlExe === null)
            return '';

        const argv = this._argv(kubeconfig, '--request-timeout=3');
        if (context)
            argv.push(`--context=${context}`);
        argv.push('version');

        try {
            return await execCommunicateAsync(argv);
        } catch (_e) {
            return '';
        }
    }

    /**
     * @param {string|undefined} context
     * @param {string|null} [kubeconfig]
     * @returns {Promise<boolean>}
     */
    static async clusterIsReachable(context, kubeconfig = null) {
        if (this._kubectlExe === null)
            return false;
        const v = await Kubectl.version(context, kubeconfig);
        return v !== '';
    }

    /**
     * @param {string|null} [kubeconfig]
     * @returns {Promise<string[]>}
     */
    static async getContexts(kubeconfig = null) {
        if (this._kubectlExe === null)
            return [];

        try {
            const output = await execCommunicateAsync(
                this._argv(kubeconfig, 'config', 'get-contexts', '-oname'));
            return output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        } catch (e) {
            Main.notifyError(this._extensionUUID, _(`cannot retrieve kubeconfig contexts: ${e}`));
            return [];
        }
    }

    /**
     * @param {string|null} [kubeconfig]
     * @returns {Promise<string>}
     */
    static async getCurrentContext(kubeconfig = null) {
        if (this._kubectlExe === null)
            return '';

        try {
            return await execCommunicateAsync(
                this._argv(kubeconfig, 'config', 'current-context'));
        } catch (e) {
            console.error(`${this._extensionUUID}: cannot retrieve current context: ${e}`);
            return '';
        }
    }

    /**
     * @param {string|null} [kubeconfig]
     * @returns {Promise<string>}
     */
    static async getCurrentCluster(kubeconfig = null) {
        if (this._kubectlExe === null)
            return '';

        try {
            return await execCommunicateAsync(this._argv(
                kubeconfig, 'config', 'view', '--minify',
                '-o', 'jsonpath={.contexts[0].context.cluster}'));
        } catch (e) {
            console.error(`${this._extensionUUID}: cannot retrieve current cluster: ${e}`);
            return '';
        }
    }

    /**
     * @param {string} context
     * @param {string|null} [kubeconfig]
     * @returns {Promise<boolean>}
     */
    static async useContext(context, kubeconfig = null) {
        if (this._kubectlExe === null)
            return false;

        try {
            await execCommunicateAsync(
                this._argv(kubeconfig, 'config', 'use-context', context));
            return true;
        } catch (e) {
            Main.notifyError(this._extensionUUID, _(`cannot set kubeconfig context '${context}': ${e}`));
            return false;
        }
    }
}
