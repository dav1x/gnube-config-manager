import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Kubectl } from './kubectl.js';
import {
    buildKubeconfigValue,
    expandPath,
    resolvePaths,
    setKubeconfigEnv,
} from './kubeEnv.js';
import {
    displayLabelForCluster,
    getClusterLabelMap,
} from './clusterUtil.js';

export const KubeIndicator = GObject.registerClass({ GTypeName: 'GnubeConfigManagerIndicator' },
    class KubeIndicator extends PanelMenu.Button {
        _init(extensionObject) {
            super._init(null, 'GnubeConfigManager');
            this._extensionObject = extensionObject;
            this._settings = this._extensionObject.getSettings();
            this._settingsSignals = [];
            this._menuSignal = 0;
            this._busy = false;
            /** @type {import('./kubectl.js').ClusterEntry[]} */
            this._clusters = [];
            this._selectedCluster = null;

            this._buildMenu();
            this._setView();
            this._bindSettingsChanges();

            this._applyKubeconfigFromSettings().then(() => this._refreshPanelLabel())
                .catch(e => console.error(`${this._extensionObject.metadata.uuid}: ${e}`));
        }

        _buildMenu() {
            this.clustersMenuSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this.clustersMenuSection);

            this.contextsMenuSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this.contextsMenuSection);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const settingsMenuItem = new PopupMenu.PopupMenuItem(_('Preferences'));
            settingsMenuItem.connect('activate', () => {
                try {
                    this._extensionObject.openPreferences();
                } catch (e) {
                    console.error(`${this._extensionObject.metadata.uuid}: ${e}`);
                }
            });
            this.menu.addMenuItem(settingsMenuItem);

            // Rebuild only when opening — never while closing/activating
            this._menuSignal = this.menu.connect('open-state-changed', (_menu, open) => {
                if (open)
                    this._populateMenu();
            });
        }

        _configPaths() {
            const paths = resolvePaths(this._settings.get_strv('kubeconfig-paths'));
            return paths.length > 0 ? paths : [expandPath('~/.kube/config')];
        }

        _activeKubeconfigPath() {
            return buildKubeconfigValue(
                this._settings.get_strv('kubeconfig-paths'),
                this._settings.get_boolean('merge-kubeconfigs'),
                this._settings.get_string('active-kubeconfig'));
        }

        async _applyKubeconfigFromSettings() {
            await setKubeconfigEnv(
                this._activeKubeconfigPath(),
                this._extensionObject.metadata.uuid);
        }

        /**
         * @returns {import('./kubectl.js').ClusterEntry|null}
         */
        _resolveSelectedCluster() {
            if (this._clusters.length === 0)
                return null;

            const activePath = expandPath(this._settings.get_string('active-kubeconfig')) ||
                this._activeKubeconfigPath().split(':')[0];
            const activeName = this._settings.get_string('active-cluster-name');

            if (activeName && activePath) {
                const exact = this._clusters.find(c =>
                    c.name === activeName && c.kubeconfig === activePath);
                if (exact)
                    return exact;
            }

            if (activePath) {
                const onPath = this._clusters.find(c => c.kubeconfig === activePath);
                if (onPath) {
                    if (activeName) {
                        const named = this._clusters.find(c =>
                            c.name === activeName && c.kubeconfig === activePath);
                        if (named)
                            return named;
                    }
                    return onPath;
                }
            }

            if (activeName) {
                const byName = this._clusters.find(c => c.name === activeName);
                if (byName)
                    return byName;
            }

            return this._clusters[0];
        }

        /**
         * @param {import('./clusterUtil.js').ClusterEntry} entry
         * @returns {string}
         */
        _clusterLabel(entry) {
            return displayLabelForCluster(entry, getClusterLabelMap(this._settings));
        }

        async _refreshPanelLabel() {
            if (!this._settings.get_boolean('show-current-context') || !this.label)
                return;

            try {
                if (this._clusters.length === 0)
                    this._clusters = await Kubectl.listClusters(this._configPaths());
                this._selectedCluster = this._resolveSelectedCluster();

                if (this._selectedCluster) {
                    this.label.text = this._clusterLabel(this._selectedCluster);
                    return;
                }

                const kubeconfig = this._activeKubeconfigPath().split(':')[0] || null;
                const cluster = await Kubectl.getCurrentCluster(kubeconfig);
                this.label.text = cluster || _('kubectl');
            } catch (e) {
                console.error(`${this._extensionObject.metadata.uuid}: ${e}`);
            }
        }

        async _populateMenu() {
            if (this._busy)
                return;
            this._busy = true;

            try {
                this.clustersMenuSection.removeAll();
                this.contextsMenuSection.removeAll();

                const paths = this._configPaths();
                this._clusters = await Kubectl.listClusters(paths);
                this._selectedCluster = this._resolveSelectedCluster();

                const headerClusters = new PopupMenu.PopupMenuItem(_('Clusters'), {
                    reactive: false,
                    can_focus: false,
                });
                headerClusters.setSensitive(false);
                this.clustersMenuSection.addMenuItem(headerClusters);

                if (this._clusters.length === 0) {
                    const empty = new PopupMenu.PopupMenuItem(_('No clusters found'));
                    empty.setSensitive(false);
                    this.clustersMenuSection.addMenuItem(empty);
                } else {
                    for (const entry of this._clusters) {
                        const selected = this._selectedCluster &&
                            entry.name === this._selectedCluster.name &&
                            entry.kubeconfig === this._selectedCluster.kubeconfig;
                        const item = new PopupMenu.PopupMenuItem(this._clusterLabel(entry));
                        item.setOrnament(selected
                            ? PopupMenu.Ornament.DOT
                            : PopupMenu.Ornament.NONE);
                        item.connect('activate', () => {
                            const chosen = entry;
                            this.menu.close();
                            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                this._selectCluster(chosen).catch(e =>
                                    console.error(`${this._extensionObject.metadata.uuid}: ${e}`));
                                return GLib.SOURCE_REMOVE;
                            });
                        });
                        this.clustersMenuSection.addMenuItem(item);
                    }
                }

                const headerContexts = new PopupMenu.PopupMenuItem(_('Contexts'), {
                    reactive: false,
                    can_focus: false,
                });
                headerContexts.setSensitive(false);
                this.contextsMenuSection.addMenuItem(headerContexts);

                const kubeconfig = this._selectedCluster?.kubeconfig || null;
                const currentContext = kubeconfig
                    ? await Kubectl.getCurrentContext(kubeconfig)
                    : '';
                const contexts = this._selectedCluster?.contexts || [];

                if (!this._selectedCluster) {
                    const empty = new PopupMenu.PopupMenuItem(_('Select a cluster first'));
                    empty.setSensitive(false);
                    this.contextsMenuSection.addMenuItem(empty);
                } else if (contexts.length === 0) {
                    const empty = new PopupMenu.PopupMenuItem(_('No contexts for this cluster'));
                    empty.setSensitive(false);
                    this.contextsMenuSection.addMenuItem(empty);
                } else {
                    for (const context of contexts) {
                        const item = new PopupMenu.PopupMenuItem(context);
                        item.setOrnament(context === currentContext
                            ? PopupMenu.Ornament.DOT
                            : PopupMenu.Ornament.NONE);
                        item.connect('activate', () => {
                            const chosen = context;
                            const cfg = kubeconfig;
                            this.menu.close();
                            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                this._selectContext(chosen, cfg).catch(e =>
                                    console.error(`${this._extensionObject.metadata.uuid}: ${e}`));
                                return GLib.SOURCE_REMOVE;
                            });
                        });
                        this.contextsMenuSection.addMenuItem(item);
                    }
                }

                await this._refreshPanelLabel();
            } catch (e) {
                console.error(`${this._extensionObject.metadata.uuid}: populate menu failed: ${e}`);
            } finally {
                this._busy = false;
            }
        }

        /**
         * @param {import('./kubectl.js').ClusterEntry} entry
         */
        async _selectCluster(entry) {
            try {
                this._selectedCluster = entry;
                this._settings.set_boolean('merge-kubeconfigs', false);
                this._settings.set_string('active-kubeconfig', entry.kubeconfig);
                this._settings.set_string('active-cluster-name', entry.name);
                // Keep active-cluster as name only for compatibility; path is in active-kubeconfig
                this._settings.set_string('active-cluster', entry.name);

                await setKubeconfigEnv(entry.kubeconfig, this._extensionObject.metadata.uuid);

                const context = entry.currentContext || entry.contexts[0];
                if (context)
                    await Kubectl.useContext(context, entry.kubeconfig);

                if (this.label)
                    this.label.text = this._clusterLabel(entry);

                Main.notify(
                    this._extensionObject.metadata.name,
                    `${_('Switched to cluster')} ${this._clusterLabel(entry)}`);
            } catch (e) {
                console.error(`${this._extensionObject.metadata.uuid}: select cluster failed: ${e}`);
                Main.notifyError(
                    this._extensionObject.metadata.name,
                    _(`Failed to switch cluster: ${e}`));
            }
        }

        /**
         * @param {string} context
         * @param {string|null} kubeconfig
         */
        async _selectContext(context, kubeconfig) {
            try {
                const cfg = kubeconfig ||
                    this._selectedCluster?.kubeconfig ||
                    this._activeKubeconfigPath().split(':')[0];

                if (cfg) {
                    this._settings.set_boolean('merge-kubeconfigs', false);
                    this._settings.set_string('active-kubeconfig', cfg);
                    await setKubeconfigEnv(cfg, this._extensionObject.metadata.uuid);
                }

                await Kubectl.useContext(context, cfg || null);

                Main.notify(
                    this._extensionObject.metadata.name,
                    `${_('Switched to context')} ${context}`);
            } catch (e) {
                console.error(`${this._extensionObject.metadata.uuid}: select context failed: ${e}`);
            }
        }

        _panelIconPath() {
            const style = this._settings.get_string('panel-icon');
            const file = style === 'color'
                ? 'kubernetes-icon-color.svg'
                : 'kubernetes-icon-white.svg';
            return `${this._extensionObject.path}/icons/${file}`;
        }

        _setView() {
            this.remove_all_children();

            const box = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
            });

            const gicon = Gio.icon_new_for_string(this._panelIconPath());
            this.icon = new St.Icon({ gicon, style_class: 'system-status-icon' });
            box.add_child(this.icon);

            if (this._settings.get_boolean('show-current-context')) {
                this.label = new St.Label({
                    text: _('kubectl'),
                    y_align: Clutter.ActorAlign.CENTER,
                });
                box.add_child(this.label);
            } else {
                this.label = null;
            }

            this.add_child(box);
            this._refreshPanelLabel();
        }

        _bindSettingsChanges() {
            this._settingsSignals.push(
                this._settings.connect('changed::show-current-context', () => this._setView()),
                this._settings.connect('changed::panel-icon', () => this._setView()),
                this._settings.connect('changed::cluster-labels', () => this._refreshPanelLabel()),
                this._settings.connect('changed::kubeconfig-paths', () => {
                    this._applyKubeconfigFromSettings()
                        .then(() => this._refreshPanelLabel())
                        .catch(e => console.error(`${this._extensionObject.metadata.uuid}: ${e}`));
                }),
            );
        }

        destroy() {
            if (this._menuSignal) {
                this.menu.disconnect(this._menuSignal);
                this._menuSignal = 0;
            }
            for (const id of this._settingsSignals)
                this._settings.disconnect(id);
            this._settingsSignals = [];
            super.destroy();
        }
    });
