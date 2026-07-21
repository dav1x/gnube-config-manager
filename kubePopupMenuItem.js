import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Kubectl } from './kubectl.js';
import { throttle } from './utils.js';

export const KubePopupMenuItem = GObject.registerClass(
    {
        GTypeName: 'KubePopupMenuItem',
    },
    class extends PopupMenu.PopupMenuItem {
        /**
         * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extensionObject
         * @param {string} text
         * @param {boolean} selected
         * @param {((name: string) => void|Promise<void>)|null} [onActivate]
         * @param {string|null} [kubeconfig] kubeconfig used for reachability checks
         * @param {object} [params]
         */
        constructor(extensionObject, text, selected, onActivate = null, kubeconfig = null, params) {
            super(text.trim(), params);
            this._extensionObject = extensionObject;
            this._settings = this._extensionObject.getSettings();
            this._destroyed = false;
            this._itemName = text.trim();
            this._kubeconfig = kubeconfig;
            this._checkReachability = true;

            this.setOrnament(selected === true
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);

            this.connect('activate', () => {
                const run = onActivate
                    ? onActivate(this._itemName)
                    : Kubectl.useContext(this._itemName, this._kubeconfig);
                Promise.resolve(run).catch(e =>
                    console.error(`${this._extensionObject.metadata.uuid}: ${e}`));
            });
            this.connect('destroy', this._onDestroy.bind(this));

            this._clusterStatusIcon = null;
            this._setClusterStatusIcon('network-error-symbolic');

            this._timerid = null;
            this._bindSettingsChanges();
            this._updateClusterStatus().catch(e =>
                console.error(`${this._extensionObject.metadata.uuid}: ${e}`));
            this._restartClusterPoll();
        }

        /**
         * Disable live reachability polling (e.g. for cluster rows).
         */
        setCheckReachability(enabled) {
            this._checkReachability = enabled;
            if (!enabled) {
                this._stopClusterPoll();
                if (this._clusterStatusIcon) {
                    this.remove_child(this._clusterStatusIcon);
                    this._clusterStatusIcon = null;
                }
            }
        }

        _bindSettingsChanges() {
            const throttledClusterPoll = throttle(this._restartClusterPoll.bind(this), 500);
            this._settings.connect('changed::cluster-poll-interval-seconds', () => {
                throttledClusterPoll();
            });
        }

        _restartClusterPoll() {
            this._stopClusterPoll();
            if (!this._checkReachability)
                return;

            this._timerid = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                this._settings.get_int('cluster-poll-interval-seconds'),
                () => {
                    this._updateClusterStatus().catch(e =>
                        console.error(`${this._extensionObject.metadata.uuid}: ${e}`));
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        _stopClusterPoll() {
            if (this._timerid !== null) {
                if (GLib.source_remove(this._timerid)) {
                    this._timerid = null;
                } else {
                    console.error(`${this._extensionObject.metadata.uuid}: cannot remove timer ${this._timerid}`);
                }
            }
        }

        async _updateClusterStatus() {
            if (this._destroyed || !this._checkReachability)
                return;

            const status = await Kubectl.clusterIsReachable(this._itemName, this._kubeconfig);
            if (this._destroyed)
                return;

            this._setClusterStatusIcon(status
                ? 'network-transmit-receive-symbolic'
                : 'network-error-symbolic');
        }

        /**
         * @param {string} iconName
         */
        _setClusterStatusIcon(iconName) {
            if (this._destroyed)
                return;

            if (this._clusterStatusIcon === null) {
                this._clusterStatusIcon = new St.Icon({
                    icon_name: iconName,
                    style_class: 'popup-menu-icon',
                    x_align: Clutter.ActorAlign.END,
                    x_expand: true,
                    y_expand: true,
                });
                this.add_child(this._clusterStatusIcon);
            } else {
                this._clusterStatusIcon.set_icon_name(iconName);
            }
        }

        _onDestroy() {
            this._destroyed = true;
            this._stopClusterPoll();
        }
    });
