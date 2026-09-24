import GLib from 'gi://GLib';

/**
 * Leading-edge throttle. Call `.cancel()` from destroy/disable to remove any
 * pending GLib timeout source.
 *
 * @param {Function} mainFunction
 * @param {number} delayMs throttle delay in milliseconds
 * @returns {Function & {cancel: () => void}}
 */
export function throttle(mainFunction, delayMs) {
    let timerId = 0;

    const throttled = (...args) => {
        if (timerId !== 0)
            return;

        mainFunction(...args);
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            timerId = 0;
            return GLib.SOURCE_REMOVE;
        });
    };

    throttled.cancel = () => {
        if (timerId !== 0) {
            GLib.source_remove(timerId);
            timerId = 0;
        }
    };

    return throttled;
}
