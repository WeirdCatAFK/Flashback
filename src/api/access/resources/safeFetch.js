/**
 * Fetches only public http and https addresses, and follows each redirect by hand to check it.
 * shortcut: the check and the fetch resolve DNS separately, so DNS rebinding passes. Pin the connection with an undici dispatcher to close it.
 */
import net from "node:net";
import dns from "node:dns/promises";

const MAX_REDIRECTS = 5;

const PRIVATE_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

function refuse(message) {
    return Object.assign(new Error(message), { status: 400, code: "blocked_address" });
}

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
