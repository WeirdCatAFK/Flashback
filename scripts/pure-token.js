#!/usr/bin/env node

import path from "path";

const args = process.argv.slice(2);

function flag(name) {
    return args.includes(`--${name}`);
}

function option(name) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

if (flag("help") || flag("h")) {
    console.log(`
Flashback — pure token recovery

  npm run pure-token                 Mint a new author token; revokes every previous one.
  npm run pure-token -- --list       List accounts and tokens. Changes nothing.
  npm run pure-token -- --data DIR   Use DIR as the data directory instead of USER_DATA_PATH.

The new token is printed once and cannot be recovered afterwards.
`);
    process.exit(0);
}

const dataDir = option("data");
if (dataDir) process.env.USER_DATA_PATH = path.resolve(dataDir);
if (!process.env.USER_DATA_PATH) process.env.USER_DATA_PATH = path.join(process.cwd(), "data");

const {
    getAccountsPath, listAccounts, getAuthorAccount, rotatePureToken, closeAccounts,
} = await import("../src/api/access/primitives/accounts.js");

console.log(`Accounts store: ${getAccountsPath()}\n`);

try {
    if (flag("list")) {
        const accounts = await listAccounts();
        if (!accounts.length) {
            console.log("No accounts yet. Start the app or the server once to provision the Author.");
        }
        for (const account of accounts) {
            const state = account.active ? "" : "  (deactivated)";
            console.log(`${account.role.padEnd(13)} ${account.name} <${account.email}>${state}`);
            if (!account.tokens.length) console.log("              no tokens");
            for (const token of account.tokens) {
                const used = token.lastUsedAt ? `last used ${token.lastUsedAt}` : "never used";
                const status = token.revokedAt ? `REVOKED ${token.revokedAt}` : "active";
                console.log(`              ${token.id}  ${status.padEnd(34)} ${used}  ${token.label || ""}`);
            }
        }
        process.exit(0);
    }

    const author = await getAuthorAccount();
    if (!author) {
        console.error(
            "This store has no Author yet, so there is nothing to recover.\n" +
            "Start the app or the server once — it provisions the Author on first boot.",
        );
        process.exit(1);
    }

    const { token, revoked } = await rotatePureToken("Pure token (terminal)");

    console.log(`Author: ${author.name} <${author.email}>`);
    console.log(`Revoked ${revoked} previous author token(s) — they stopped working just now.\n`);
    console.log("  New pure token:\n");
    console.log(`      ${token}\n`);
    console.log("Copy it now. It is stored only as a hash and cannot be shown again.");
    if (revoked > 0) {
        console.log(
            "\nIf this is a DESKTOP install, the app's own token was among those revoked; it\n" +
            "re-adopts the one in config.json the next time it starts, so restart the app.",
        );
    }
} finally {
    closeAccounts();
}
