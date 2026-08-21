/**
 * Whether a URL can be used to REACH a Flashback Server.
 *
 * Lives in `shared/` beside `vaultName.js`, and for the same reason: it is a pure rule that
 * more than one process needs, and duplicating it is how the two drift apart.
 *
 * There is one rule and it earns the file. A server prints the interface it bound to —
 * `0.0.0.0:50501` — and that string gets pasted in as a client URL. It then *passes* the
 * handshake, because that probe runs in Electron's main process where Node's fetch resolves
 * the unspecified address to localhost. The renderer is Chromium, which refuses it outright.
 * So the app switches to a server it can never reach: the gate spins forever, the role badge
 * reads "Role unknown", and not one request arrives.
 *
 * The probe and the thing that has to use the URL are two different HTTP stacks. This is
 * where they disagree, so this is where it has to be caught rather than tested for.
 */

/**
 * Hosts that mean "every interface". Bind addresses, never destinations.
 *
 * `URL.hostname` KEEPS the brackets on an IPv6 literal and normalizes the long form, so
 * `http://[0000:0000:...:0000]/` and `http://[::]/` both arrive here as `[::]`. The bare
 * `::` is listed too, for a host string that never went through `new URL()`.
 */
const UNSPECIFIED = new Set(["0.0.0.0", "[::]", "::"]);

/**
 * @param {string} url
 * @returns {string|null} why it cannot be connected to, or null when it is usable.
 */
export function unusableUrlReason(url) {
    let host;
    try {
        host = new URL(url).hostname;   // an IPv6 literal keeps its brackets here
    } catch {
        return "That is not a valid URL.";
    }
    if (UNSPECIFIED.has(host)) {
        return `${host} is the address a server LISTENS on, not one you can connect to. ` +
            "Use the machine's own address — localhost if the server is on this computer.";
    }
    return null;
}
