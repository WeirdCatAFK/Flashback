export const ROLES = {
    READER: "reader",
    COLLABORATOR: "collaborator",
    ADMIN: "admin",
    AUTHOR: "author",
};

export const ROLE_ORDER = [ROLES.READER, ROLES.COLLABORATOR, ROLES.ADMIN, ROLES.AUTHOR];

export function roleRank(role) {
    return ROLE_ORDER.indexOf(role);
}

export function isRole(role) {
    return roleRank(role) !== -1;
}

/** An unknown role never reaches any minimum, so a corrupt account row gets no access. */
export function atLeast(role, minimum) {
    const have = roleRank(role);
    const need = roleRank(minimum);
    if (have === -1 || need === -1) return false;
    return have >= need;
}


export const CAPABILITIES = {
    readVault:        { minimum: ROLES.READER, guards: [["documents", "GET", "/list"], ["search", "GET", "/"]] },
    study:            { minimum: ROLES.READER, guards: [["srs", "POST", "/review"], ["srs", "GET", "/due"]] },
    optimizeSchedule: { minimum: ROLES.READER, guards: [["srs", "POST", "/optimize"]],
        note: "Fitted FSRS weights model one person's forgetting and are stored per account." },
    dismissCardFlag:  { minimum: ROLES.READER, guards: [["flashcards", "POST", "/abc123/flags/mouthful/dismiss"]] },
    readLogs:         { minimum: ROLES.READER, guards: [["diary", "GET", "/"]] },

    annotate:         { minimum: ROLES.COLLABORATOR, guards: [["highlights", "POST", "/"], ["documents", "PUT", "/metadata"], ["documents", "POST", "/cover"]],
        note: "Highlights, tags and cards all live in the sidecar, so annotating IS a metadata write." },
    attachMedia:      { minimum: ROLES.COLLABORATOR, guards: [["media", "POST", "/vanilla"], ["media", "POST", "/custom"]] },

    createDocuments:  { minimum: ROLES.ADMIN, guards: [["documents", "POST", "/file"], ["documents", "POST", "/folder"]] },
    editDocumentBody: { minimum: ROLES.ADMIN, guards: [["documents", "PUT", "/file"]] },
    changeVaultShape: { minimum: ROLES.ADMIN, guards: [["documents", "POST", "/move"], ["documents", "DELETE", "/"]] },
    importDocuments:  { minimum: ROLES.ADMIN, guards: [["documents", "POST", "/import"], ["subscriptions", "POST", "/import"]] },
    editCards:        { minimum: ROLES.ADMIN, guards: [["flashcards", "POST", "/"], ["flashcards", "DELETE", "/abc123"]] },
    manageDecks:      { minimum: ROLES.ADMIN, guards: [["decks", "POST", "/"], ["decks", "DELETE", "/abc123"], ["decks", "POST", "/abc123/cover"]] },
    manageCategories: { minimum: ROLES.ADMIN, guards: [["categories", "POST", "/"], ["categories", "PUT", "/1"]] },
    manageTags:       { minimum: ROLES.ADMIN, guards: [["documents", "POST", "/tags/rename"]] },
    manageMedia:      { minimum: ROLES.ADMIN, guards: [["media", "POST", "/reconcile"], ["media", "DELETE", "/"]] },
    viewHistory:      { minimum: ROLES.ADMIN, guards: [["seal", "GET", "/log"]] },
    checkIndex:       { minimum: ROLES.ADMIN, guards: [["doctor", "GET", "/check"]] },
    manageAccounts:   { minimum: ROLES.ADMIN, guards: [["accounts", "GET", "/"], ["accounts", "POST", "/"]] },
    viewAllProgress:  { minimum: ROLES.ADMIN, guards: [["accounts", "GET", "/abc123/progress"], ["accounts", "GET", "/abc123/graph"]] },

    rollbackHistory:  { minimum: ROLES.AUTHOR, guards: [["seal", "POST", "/rollback"]] },
    rebuildIndex:     { minimum: ROLES.AUTHOR, guards: [["doctor", "POST", "/rebuild"], ["doctor", "POST", "/sync"]] },
    switchVault:      { minimum: ROLES.AUTHOR, guards: [["vault", "POST", "/switch"]] },
    manageRemotes:    { minimum: ROLES.AUTHOR, guards: [["remotes", "GET", "/"]] },
    rotatePureToken:  { minimum: ROLES.AUTHOR, guards: [["accounts", "POST", "/pure-token"]] },
    readAllLogs:      { minimum: ROLES.AUTHOR, guards: [["accounts", "GET", "/abc123/logs"], ["accounts", "GET", "/abc123/logs/entry/2026-01-01"]],
        note: "Logs hold private writing; only the server's owner is told they may read them." },
};

export function can(role, capability) {
    const entry = CAPABILITIES[capability];
    if (!entry) return false;
    return atLeast(role, entry.minimum);
}
