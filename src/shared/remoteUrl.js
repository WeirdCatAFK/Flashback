const UNSPECIFIED = new Set(["0.0.0.0", "[::]", "::"]);

/** Node fetch in Electron main reaches 0.0.0.0, and the Chromium renderer refuses it. A passing handshake proves nothing for that address. */
export function unusableUrlReason(url) {
    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        return "That is not a valid URL.";
    }
    if (UNSPECIFIED.has(host)) {
        return `${host} is the address a server LISTENS on, not one you can connect to. ` +
            "Use the machine's own address — localhost if the server is on this computer.";
    }
    return null;
}
