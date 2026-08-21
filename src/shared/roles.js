/**
 * The four roles, shared by everything that has to reason about them.
 *
 * Lives in `shared/` beside `identity.js` because three separate places need the same
 * ordering and must not each invent one: the accounts store validates the column against it,
 * the API's permission table compares against it, and the renderer (M5) hides controls a
 * server would refuse. A role list that disagreed between the UI and the guard would show
 * people buttons that 403.
 *
 * The order is a strict ladder — every role can do everything the ones below it can:
 *
 *   reader        study progress only.
 *   collaborator  + annotates documents that already exist. No creation, no imports.
 *   admin         + modifies the vault, imports, manages access. Several may exist.
 *   author        + owns the files. Sole holder of the pure token. Exactly one.
 *
 * The two rules an ordering cannot express, because they are about the ACTOR rather than the
 * level, live with the accounts routes: an admin may grant only Reader, and an admin may not
 * deactivate their own token.
 */

export const ROLES = {
    READER: "reader",
    COLLABORATOR: "collaborator",
    ADMIN: "admin",
    AUTHOR: "author",
};

/** Weakest first. Index is the rank; nothing else should hardcode these numbers. */
export const ROLE_ORDER = [ROLES.READER, ROLES.COLLABORATOR, ROLES.ADMIN, ROLES.AUTHOR];

/** @returns {number} rank, or -1 for anything that is not a role. */
export function roleRank(role) {
    return ROLE_ORDER.indexOf(role);
}

/** @returns {boolean} whether `role` is a real role at all. */
export function isRole(role) {
    return roleRank(role) !== -1;
}

/**
 * @returns {boolean} whether `role` reaches `minimum`.
 * An unknown role never satisfies anything — the guard fails closed on a corrupt row.
 */
export function atLeast(role, minimum) {
    const have = roleRank(role);
    const need = roleRank(minimum);
    if (have === -1 || need === -1) return false;
    return have >= need;
}

// ---------------------------------------------------------------------------
// Capabilities — what the RENDERER asks before drawing a control.
//
// The API's answer to "may I?" lives in one table, `src/api/auth/permissions.js`, matched per
// method and path. The renderer cannot import that file: it belongs to the API tier, and the
// UI has no business knowing route shapes. The obvious alternative — a role comparison
// written inline in each JSX file — is how a UI drifts from its guard, and the failure is
// ugly in both directions: a button that 403s when pressed, or a control hidden from someone
// who was allowed to use it all along.
//
// So capabilities are named here, in the module both sides already share, and each one
// records the REQUESTS it stands for. The renderer reads `minimum`; `tests/capabilities.test.js`
// feeds every entry in `guards` through the API's real `requiredRole()` matcher and asserts it
// agrees. Drift becomes a failing test rather than a support ticket.
//
// A capability is deliberately coarser than the policy — it answers "should this button
// exist", not "may this exact request proceed". Where a capability would span two different
// minimums, the honest fix is to split it, not to relax the test.
// ---------------------------------------------------------------------------

/**
 * @typedef {{minimum: string, guards: Array<[string, string, string]>, note?: string}} Capability
 * `guards` entries are [mount, method, pathWithinRouter] — the same three arguments
 * `requiredRole()` takes.
 */

/** @type {Record<string, Capability>} */
export const CAPABILITIES = {
    // --- reader ------------------------------------------------------------
    readVault:        { minimum: ROLES.READER, guards: [["documents", "GET", "/list"], ["search", "GET", "/"]] },
    study:            { minimum: ROLES.READER, guards: [["srs", "POST", "/review"], ["srs", "GET", "/due"]] },
    optimizeSchedule: { minimum: ROLES.READER, guards: [["srs", "POST", "/optimize"]],
        note: "Fitted FSRS weights model one person's forgetting and are stored per account." },
    dismissCardFlag:  { minimum: ROLES.READER, guards: [["flashcards", "POST", "/abc123/flags/mouthful/dismiss"]] },
    readLogs:         { minimum: ROLES.READER, guards: [["diary", "GET", "/"]] },

    // --- collaborator ------------------------------------------------------
    annotate:         { minimum: ROLES.COLLABORATOR, guards: [["highlights", "POST", "/"], ["documents", "PUT", "/metadata"]],
        note: "Highlights, tags and cards all live in the sidecar, so annotating IS a metadata write." },
    attachMedia:      { minimum: ROLES.COLLABORATOR, guards: [["media", "POST", "/vanilla"], ["media", "POST", "/custom"]] },

    // --- admin -------------------------------------------------------------
    createDocuments:  { minimum: ROLES.ADMIN, guards: [["documents", "POST", "/file"], ["documents", "POST", "/folder"]] },
    // Distinct from `annotate`, and the difference is not cosmetic. A PDF's highlights live in
    // the sidecar (`PUT /metadata`, collaborator); a Markdown or text file's live in the BODY,
    // as marks in the prose, so highlighting one is a `PUT /file` — a whole-document rewrite,
    // and admin. A Collaborator can therefore annotate a book but not a note, which is a real
    // property of where the data lives rather than a gap in the table.
    editDocumentBody: { minimum: ROLES.ADMIN, guards: [["documents", "PUT", "/file"]] },
    changeVaultShape: { minimum: ROLES.ADMIN, guards: [["documents", "POST", "/move"], ["documents", "DELETE", "/"]] },
    importDocuments:  { minimum: ROLES.ADMIN, guards: [["documents", "POST", "/import"], ["subscriptions", "POST", "/import"]] },
    editCards:        { minimum: ROLES.ADMIN, guards: [["flashcards", "POST", "/"], ["flashcards", "DELETE", "/abc123"]] },
    manageDecks:      { minimum: ROLES.ADMIN, guards: [["decks", "POST", "/"], ["decks", "DELETE", "/abc123"]] },
    manageCategories: { minimum: ROLES.ADMIN, guards: [["categories", "POST", "/"], ["categories", "PUT", "/1"]] },
    manageMedia:      { minimum: ROLES.ADMIN, guards: [["media", "POST", "/reconcile"], ["media", "DELETE", "/"]] },
    viewHistory:      { minimum: ROLES.ADMIN, guards: [["seal", "GET", "/log"]] },
    checkIndex:       { minimum: ROLES.ADMIN, guards: [["doctor", "GET", "/check"]] },
    manageAccounts:   { minimum: ROLES.ADMIN, guards: [["accounts", "GET", "/"], ["accounts", "POST", "/"]] },
    viewAllProgress:  { minimum: ROLES.ADMIN, guards: [["accounts", "GET", "/abc123/progress"]] },

    // --- author ------------------------------------------------------------
    rollbackHistory:  { minimum: ROLES.AUTHOR, guards: [["seal", "POST", "/rollback"]] },
    rebuildIndex:     { minimum: ROLES.AUTHOR, guards: [["doctor", "POST", "/rebuild"], ["doctor", "POST", "/sync"]] },
    switchVault:      { minimum: ROLES.AUTHOR, guards: [["vault", "POST", "/switch"]] },
    manageRemotes:    { minimum: ROLES.AUTHOR, guards: [["remotes", "GET", "/"]] },
    rotatePureToken:  { minimum: ROLES.AUTHOR, guards: [["accounts", "POST", "/pure-token"]] },
};

/**
 * Whether `role` may do `capability`.
 *
 * Unknown capability → false. That is the same fail-closed direction the API's table takes for
 * an unlisted mount: a typo hides a button, which someone reports, rather than revealing one
 * the server will refuse.
 *
 * @param {string} role
 * @param {string} capability  a key of CAPABILITIES
 * @returns {boolean}
 */
export function can(role, capability) {
    const entry = CAPABILITIES[capability];
    if (!entry) return false;
    return atLeast(role, entry.minimum);
}
