import GLib from 'gi://GLib';

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
