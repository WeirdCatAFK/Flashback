import { resolveToken, getAuthorAccount } from "../access/primitives/accounts.js";
import { runWithAccount } from "../requestContext.js";

function extractToken(req) {
    const auth = req.headers["authorization"];
    if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
    if (typeof req.query.token === "string") return req.query.token;
    return null;
}

const UNAUTHORIZED = { error: "Unauthorized: missing or invalid API token" };

export function authenticate({ tokenConfigured, requireAuth }) {
    return (req, res, next) => {
        const presented = extractToken(req);

        if (!presented) {
            if (tokenConfigured || requireAuth) return res.status(401).json(UNAUTHORIZED);
            return getAuthorAccount().then(
                (author) => {
                    if (!author) return res.status(401).json(UNAUTHORIZED);
                    req.account = author;
                    runWithAccount(author, next);
                },
                next,
            );
        }

        return resolveToken(presented).then(
            (resolved) => {
                if (!resolved) return res.status(401).json(UNAUTHORIZED);
                req.account = resolved.account;
                req.tokenId = resolved.tokenId;
                runWithAccount(resolved.account, next);
            },
            next,
        );
    };
}
