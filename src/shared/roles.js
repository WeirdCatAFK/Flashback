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
