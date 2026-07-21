import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { expandPath } from './kubeEnv.js';
import {
    clusterEntryKey,
    getClusterLabelMap,
    listClusterEntries,
    setClusterLabelMap,
} from './clusterUtil.js';

export default class GnubeConfigManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();
        window.set_default_size(620, 640);

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Configure the appearance of the extension'),
        });
        page.add(appearanceGroup);

        const showContextRow = new Adw.SwitchRow({
            title: _('Show current cluster'),
            subtitle: _('Show the cluster label next to the panel icon'),
        });
        appearanceGroup.add(showContextRow);
        window._settings.bind('show-current-context', showContextRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        const iconModel = new Gtk.StringList();
        iconModel.append(_('White emblem'));
        iconModel.append(_('Color emblem'));

        const iconRow = new Adw.ComboRow({
            title: _('Panel icon'),
            subtitle: _('Kubernetes emblem used in the top bar'),
            model: iconModel,
        });
        appearanceGroup.add(iconRow);

        const iconValues = ['white', 'color'];
        const currentIcon = window._settings.get_string('panel-icon');
        iconRow.selected = Math.max(0, iconValues.indexOf(currentIcon));
        iconRow.connect('notify::selected', () => {
            const value = iconValues[iconRow.selected];
            if (value)
                window._settings.set_string('panel-icon', value);
        });
        window._settings.connect('changed::panel-icon', () => {
            const selected = iconValues.indexOf(window._settings.get_string('panel-icon'));
            if (selected >= 0 && iconRow.selected !== selected)
                iconRow.selected = selected;
        });

        const kubeGroup = new Adw.PreferencesGroup({
            title: _('Kubeconfig paths'),
            description: _('Add kubeconfig files and/or directories. Directories are scanned recursively for kubeconfig files.'),
        });
        page.add(kubeGroup);

        const mergeRow = new Adw.SwitchRow({
            title: _('Merge kubeconfigs'),
            subtitle: _('Export KUBECONFIG as all listed paths joined with colons (kubectl merge behavior)'),
        });
        kubeGroup.add(mergeRow);
        window._settings.bind('merge-kubeconfigs', mergeRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        const pathsBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 6,
        });
        const pathsRow = new Adw.PreferencesRow();
        pathsRow.set_child(pathsBox);
        kubeGroup.add(pathsRow);

        const rebuildPathList = () => {
            while (pathsBox.get_first_child())
                pathsBox.remove(pathsBox.get_first_child());

            const paths = window._settings.get_strv('kubeconfig-paths');
            if (paths.length === 0) {
                const empty = new Gtk.Label({
                    label: _('No kubeconfig paths configured'),
                    xalign: 0,
                    margin_start: 12,
                    margin_end: 12,
                    margin_top: 6,
                    margin_bottom: 6,
                });
                empty.add_css_class('dim-label');
                pathsBox.append(empty);
            } else {
                for (let i = 0; i < paths.length; i++) {
                    const index = i;
                    const path = paths[i];
                    const expanded = expandPath(path);
                    const isDir = (() => {
                        try {
                            const info = Gio.File.new_for_path(expanded).query_info(
                                'standard::type', Gio.FileQueryInfoFlags.NONE, null);
                            return info.get_file_type() === Gio.FileType.DIRECTORY;
                        } catch (_e) {
                            return path.endsWith('/');
                        }
                    })();
                    const row = new Adw.ActionRow({
                        title: path,
                        subtitle: isDir
                            ? _(`${expanded} (directory)`)
                            : expanded,
                    });

                    const removeBtn = new Gtk.Button({
                        icon_name: 'user-trash-symbolic',
                        valign: Gtk.Align.CENTER,
                        tooltip_text: _('Remove'),
                    });
                    removeBtn.add_css_class('flat');
                    removeBtn.connect('clicked', () => {
                        const next = window._settings.get_strv('kubeconfig-paths');
                        next.splice(index, 1);
                        window._settings.set_strv('kubeconfig-paths', next);

                        const active = window._settings.get_string('active-kubeconfig');
                        if (expandPath(active) === expanded)
                            window._settings.set_string('active-kubeconfig', next[0] || '');
                    });
                    row.add_suffix(removeBtn);
                    pathsBox.append(row);
                }
            }

            const buttons = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                margin_start: 12,
                margin_end: 12,
                margin_top: 6,
                margin_bottom: 6,
            });

            const addFileBtn = new Gtk.Button({ label: _('Add file…') });
            addFileBtn.connect('clicked', () => this._addKubeconfig(window, false));
            buttons.append(addFileBtn);

            const addDirBtn = new Gtk.Button({ label: _('Add directory…') });
            addDirBtn.connect('clicked', () => this._addKubeconfig(window, true));
            buttons.append(addDirBtn);

            pathsBox.append(buttons);
        };

        rebuildPathList();
        window._settings.connect('changed::kubeconfig-paths', rebuildPathList);

        const labelsGroup = new Adw.PreferencesGroup({
            title: _('Cluster labels'),
            description: _('Defaults come from the kubeconfig server hostname (without https:// or port). Leave blank to use the default.'),
        });
        page.add(labelsGroup);

        const labelsBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 6,
        });
        const labelsRow = new Adw.PreferencesRow();
        labelsRow.set_child(labelsBox);
        labelsGroup.add(labelsRow);

        const rebuildLabelList = () => {
            while (labelsBox.get_first_child())
                labelsBox.remove(labelsBox.get_first_child());

            const loading = new Gtk.Label({
                label: _('Loading clusters…'),
                xalign: 0,
                margin_start: 12,
                margin_end: 12,
                margin_top: 6,
                margin_bottom: 6,
            });
            loading.add_css_class('dim-label');
            labelsBox.append(loading);

            listClusterEntries(window._settings.get_strv('kubeconfig-paths'))
                .then(entries => {
                    while (labelsBox.get_first_child())
                        labelsBox.remove(labelsBox.get_first_child());

                    if (entries.length === 0) {
                        const empty = new Gtk.Label({
                            label: _('No clusters found in configured kubeconfig paths'),
                            xalign: 0,
                            margin_start: 12,
                            margin_end: 12,
                            margin_top: 6,
                            margin_bottom: 6,
                        });
                        empty.add_css_class('dim-label');
                        labelsBox.append(empty);
                        return;
                    }

                    const labelMap = getClusterLabelMap(window._settings);
                    for (const entry of entries) {
                        const key = clusterEntryKey(entry.name, entry.kubeconfig);
                        const home = expandPath('~');
                        let path = entry.kubeconfig;
                        if (path.startsWith(`${home}/`))
                            path = `~/${path.slice(home.length + 1)}`;

                        const row = new Adw.EntryRow({
                            title: entry.defaultLabel || entry.name,
                            text: labelMap[key] || '',
                        });
                        row.set_tooltip_text(
                            `${entry.name}\n${entry.server || _('(no server)')}\n${path}`);

                        const hint = new Gtk.Label({
                            label: entry.server
                                ? `${_('Default')}: ${entry.defaultLabel}`
                                : `${_('Default')}: ${entry.name}`,
                            xalign: 0,
                            margin_start: 12,
                            margin_end: 12,
                        });
                        hint.add_css_class('dim-label');
                        hint.add_css_class('caption');

                        const applyLabel = () => {
                            const map = getClusterLabelMap(window._settings);
                            const value = row.get_text().trim();
                            if (value)
                                map[key] = value;
                            else
                                delete map[key];
                            setClusterLabelMap(window._settings, map);
                        };
                        row.connect('changed', applyLabel);
                        row.connect('entry-activated', applyLabel);

                        labelsBox.append(row);
                        labelsBox.append(hint);
                    }
                })
                .catch(e => {
                    while (labelsBox.get_first_child())
                        labelsBox.remove(labelsBox.get_first_child());
                    const err = new Gtk.Label({
                        label: _(`Failed to load clusters: ${e}`),
                        xalign: 0,
                        margin_start: 12,
                        margin_end: 12,
                        margin_top: 6,
                        margin_bottom: 6,
                    });
                    err.add_css_class('dim-label');
                    labelsBox.append(err);
                });
        };

        rebuildLabelList();
        window._settings.connect('changed::kubeconfig-paths', rebuildLabelList);

        const instrumentationGroup = new Adw.PreferencesGroup({
            title: _('Instrumentation'),
            description: _('Configure extension tools'),
        });
        page.add(instrumentationGroup);

        const clusterReachability = new Adw.SpinRow({
            title: _('Poll context cluster every (sec)'),
            subtitle: _('Cluster context reachability poll interval'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 3600,
                step_increment: 5,
            }),
        });
        instrumentationGroup.add(clusterReachability);
        window._settings.bind('cluster-poll-interval-seconds', clusterReachability,
            'value', Gio.SettingsBindFlags.DEFAULT);
    }

    /**
     * @param {Adw.PreferencesWindow} window
     * @param {boolean} selectDirectory
     */
    _addKubeconfig(window, selectDirectory = false) {
        const dialog = new Gtk.FileDialog({
            title: selectDirectory
                ? _('Select kubeconfig directory')
                : _('Select kubeconfig file'),
            modal: true,
        });

        const homeKube = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_home_dir(), '.kube']));
        const homeConfigs = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_home_dir(), 'k8s-kubeconfigs']));
        if (selectDirectory && homeConfigs.query_exists(null))
            dialog.set_initial_folder(homeConfigs.get_parent());
        else if (homeKube.query_exists(null))
            dialog.set_initial_folder(homeKube);

        const finish = (_dlg, result) => {
            try {
                const file = selectDirectory
                    ? dialog.select_folder_finish(result)
                    : dialog.open_finish(result);
                if (!file)
                    return;

                let path = file.get_path();
                const home = GLib.get_home_dir();
                if (path.startsWith(`${home}/`))
                    path = `~/${path.slice(home.length + 1)}`;

                const paths = window._settings.get_strv('kubeconfig-paths');
                const expanded = expandPath(path);
                if (paths.some(p => expandPath(p) === expanded))
                    return;

                paths.push(path);
                window._settings.set_strv('kubeconfig-paths', paths);

                if (!window._settings.get_string('active-kubeconfig') && !selectDirectory)
                    window._settings.set_string('active-kubeconfig', path);
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                    !e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                    console.error(`Failed to add kubeconfig path: ${e}`);
            }
        };

        if (selectDirectory)
            dialog.select_folder(window, null, finish);
        else
            dialog.open(window, null, finish);
    }
}
