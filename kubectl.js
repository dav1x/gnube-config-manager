import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { execCommunicateAsync } from './commandLineUtil.js';

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
 * @typedef {{ name: string, cluster: string }} ContextInfo
 * @typedef {{
 *   path: string,
 *   currentContext: string,
 *   contexts: ContextInfo[],
 *   clusters: string[],
 * }} KubeconfigSummary
 * @typedef {{
 *   name: string,
 *   kubeconfig: string,
 *   contexts: string[],
 *   currentContext: string,
 * }} ClusterEntry
 */

export class Kubectl extends BaseKubectl {
    /**
     * @param {string} path
     * @returns {Promise<KubeconfigSummary|null>}
     */
    static async getConfigSummary(path) {
        if (this._kubectlExe === null || !path)
            return null;

        try {
            const output = await execCommunicateAsync(
                this._argv(path, 'config', 'view', '-o', 'json'));
            const data = JSON.parse(output);
            const contexts = (data.contexts || []).map(c => ({
                name: c.name,
                cluster: c.context?.cluster || '',
            })).filter(c => c.name);

            const clusters = [...new Set([
                ...(data.clusters || []).map(c => c.name).filter(Boolean),
                ...contexts.map(c => c.cluster).filter(Boolean),
            ])];

            return {
                path,
                currentContext: data['current-context'] || '',
                contexts,
                clusters,
            };
        } catch (e) {
            console.error(`${this._extensionUUID}: cannot read kubeconfig ${path}: ${e}`);
            return null;
        }
    }

    /**
     * Collect unique clusters across kubeconfig files.
     * Duplicate cluster names from different files get a path suffix in `id`.
     *
     * @param {string[]} paths
     * @returns {Promise<ClusterEntry[]>}
     */
    static async listClusters(paths) {
        /** @type {ClusterEntry[]} */
        const entries = [];
        const seenNames = new Map();

        for (const path of paths) {
            const summary = await this.getConfigSummary(path);
            if (!summary)
                continue;

            for (const clusterName of summary.clusters) {
                const contexts = summary.contexts
                    .filter(c => c.cluster === clusterName)
                    .map(c => c.name);

                if (contexts.length === 0)
                    continue;

                const count = (seenNames.get(clusterName) || 0) + 1;
                seenNames.set(clusterName, count);

                const currentForCluster = contexts.includes(summary.currentContext)
                    ? summary.currentContext
                    : contexts[0];

                entries.push({
                    name: clusterName,
                    kubeconfig: path,
                    contexts,
                    currentContext: currentForCluster,
                });
            }
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
