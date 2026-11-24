import os from "os";
import { readConfig, updateConfig } from "./appConfig.js";
import { identityError, defaultIdentityFrom } from "../shared/identity.js";

function suggestedIdentity() {
    let username = "";
    try {
        username = os.userInfo().username || "";
    } catch { }
    return defaultIdentityFrom(username);
}

function clean(identity) {
    return {
        name: String(identity?.name ?? "").trim(),
        email: String(identity?.email ?? "").trim(),
    };
}

export function getStoredIdentity() {
    const config = readConfig();
    const user = config.user ?? {};
    const activeVaultId = config.activeVaultId ?? null;
    const override = activeVaultId ? user.perVault?.[activeVaultId] ?? null : null;

    return {
        user: clean(user),
        override: override ? clean(override) : null,
        suggested: suggestedIdentity(),
        activeVaultId,
    };
}

export function setIdentity(identity) {
    const value = clean(identity);
    const problem = identityError(value);
    if (problem) {
        return { ok: false, error: `Invalid ${problem.field} (${problem.code}).`, ...problem };
    }

    updateConfig((c) => {
        c.user = { ...(c.user ?? {}), name: value.name, email: value.email };
    });
    return { ok: true };
}

export function setVaultIdentity(vaultId, identity) {
    if (!vaultId) return { ok: false, error: "No vault is active, so it has nothing to override." };

    if (identity === null || identity === undefined) {
        updateConfig((c) => {
            if (c.user?.perVault) {
                delete c.user.perVault[vaultId];
                if (!Object.keys(c.user.perVault).length) delete c.user.perVault;
            }
        });
        return { ok: true };
    }

    const value = clean(identity);
    const problem = identityError(value);
    if (problem) {
        return { ok: false, error: `Invalid ${problem.field} (${problem.code}).`, ...problem };
    }

    updateConfig((c) => {
        c.user = c.user ?? {};
        c.user.perVault = c.user.perVault ?? {};
        c.user.perVault[vaultId] = value;
    });
    return { ok: true };
}
