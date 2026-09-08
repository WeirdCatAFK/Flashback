/**
 * safeFetch.js — the one door out to the open web.
 *
 * Everything Flashback fetches on a user's behalf is a URL that user (or, over MCP, a model
 * acting for them) supplied: the page a clip captures, a picture inside that page. Plain
 * `fetch` on such a URL is a request issued *from wherever this process runs*, which is a
 * very different place from the browser the address was copied out of:
 *
 *   - On a Flashback Server it sits inside a private network. `http://169.254.169.254/…`
 *     is cloud instance metadata, `http://10.0.0.5:8080/` is whatever else the deployment
 *     can reach — and a clip stores the response as a document the caller then reads, so
 *     this is a read-capable SSRF, not a blind one.
 *   - On the desktop it is the user's own machine, which sounds harmless until the caller
 *     is an AI assistant over MCP: their LAN, their router's admin page, their other
 *     loopback services.
 *
 * So: http(s) only, and never an address that resolves into a private, loopback,
 * link-local or otherwise non-public range. Redirects are followed by hand, because a
 * public host is free to answer 302 with `Location: http://169.254.169.254/` — a guard
 * that checked only the URL it was handed would wave that straight through.
 *
 * **Known limit, stated rather than papered over:** the lookup here and the one the fetch
 * itself performs are two separate resolutions, so a name that answers publicly for the
 * first and privately for the second (DNS rebinding) still gets through. Closing that
 * needs the connection pinned to the address that was checked, which is an undici
 * dispatcher rather than a wrapper. This stops the whole class of *direct* attempts, which
 * is what every one of these addresses is.
 *
 * Pure: node builtins only — no config, no database, no filesystem — so
 * `tests/safeFetch.test.js` runs with no vault and no native module, like `pathLock.js`
 * and `sequencing.js`.
 */

import net from "node:net";
import dns from "node:dns/promises";

/** How many hops a redirect chain may take before we stop following it. */
const MAX_REDIRECTS = 5;

/** Host names that never legitimately name something on the public internet. */
const PRIVATE_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/** A refusal the API surfaces as a 400 rather than a 500: the address was the problem. */
function refuse(message) {
    return Object.assign(new Error(message), { status: 400, code: "blocked_address" });
}

/**
 * Whether an IP literal points somewhere that is not the public internet.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateAddress(ip) {
    const version = net.isIP(ip);

    if (version === 4) {
        const [a, b] = ip.split(".").map(Number);
        if (a === 0) return true;
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 192 && b === 0) return true;
        if (a >= 224) return true;
        return false;
    }

    if (version === 6) {
        const s = ip.toLowerCase().split("%")[0];
        if (s === "::" || s === "::1") return true;
        if (s.startsWith("::ffff:")) {
            const mapped = s.slice("::ffff:".length);
            return net.isIP(mapped) === 4 ? isPrivateAddress(mapped) : true;
        }
        if (/^f[cd]/.test(s)) return true;
        if (/^fe[89ab]/.test(s)) return true;
        if (s.startsWith("ff")) return true;
        return false;
    }

    return true;
}

/**
 * Refuses a URL that is not a plain http(s) address on the public internet.
 *
 * @param {string} rawUrl
 * @param {{ allowPrivate?: boolean }} [opts] `allowPrivate` is the escape hatch for an install that genuinely means to clip from its own intranet (config `allowPrivateNetworkFetch`). It disables the address check and nothing else — the scheme restriction stands either way.
 * @returns {Promise<URL>} the parsed, permitted URL.
 * @throws {Error & { status: number }} if the address is not one we will fetch.
 */
export async function assertFetchableUrl(rawUrl, { allowPrivate = false } = {}) {
    let url;
    try {
        url = new URL(String(rawUrl));
    } catch {
        throw refuse(`Not a valid web address: ${rawUrl}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw refuse(`Only http and https addresses can be fetched, not ${url.protocol}`);
    }

    if (allowPrivate) return url;

    const host = url.hostname.replace(/^\[|\]$/g, "");

    if (net.isIP(host)) {
        if (isPrivateAddress(host)) throw refuse(`That address is on a private network: ${host}`);
        return url;
    }

    if (PRIVATE_NAMES.test(host)) throw refuse(`That address is on a private network: ${host}`);

    let addresses = [];
    try {
        addresses = await dns.lookup(host, { all: true });
    } catch {
        return url;
    }
    for (const { address } of addresses) {
        if (isPrivateAddress(address)) throw refuse(`That address is on a private network: ${host}`);
    }

    return url;
}

/**
 * `fetch`, with every hop of the redirect chain checked by assertFetchableUrl.
 *
 * @param {string} rawUrl
 * @param {RequestInit} [init]
 * @param {{ allowPrivate?: boolean, maxRedirects?: number }} [opts]
 * @returns {Promise<Response>}
 */
export async function safeFetch(rawUrl, init = {}, opts = {}) {
    const { allowPrivate = false, maxRedirects = MAX_REDIRECTS } = opts;
    let target = String(rawUrl);

    for (let hop = 0; hop <= maxRedirects; hop++) {
        const url = await assertFetchableUrl(target, { allowPrivate });
        const response = await fetch(url.href, { ...init, redirect: "manual" });

        const location = response.status >= 300 && response.status < 400
            ? response.headers.get("location")
            : null;
        if (!location) return response;

        try {
            target = new URL(location, url.href).href;
        } catch {
            throw refuse(`That site redirected to an address we cannot read: ${location}`);
        }
    }

    throw refuse(`That address redirected more than ${maxRedirects} times`);
}

export default safeFetch;
