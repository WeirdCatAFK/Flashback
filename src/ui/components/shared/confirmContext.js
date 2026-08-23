/**
 * The confirm context and the hook that reads it. See `ConfirmDialog.jsx` for the provider
 * that fills it and renders the dialog.
 *
 * Split from the provider for the same reason `sessionContext.js` is split from
 * `session.jsx`: eslint-plugin-react-refresh is right that a module exporting both a
 * component and a plain function breaks Fast Refresh for everything importing it — and
 * every view that can delete something imports this hook, so the blast radius was most of
 * the app. `ConfirmDialog.jsx` now exports exactly one component.
 */

import { createContext, useContext } from 'react';

/** @type {import('react').Context<null | ((opts: object) => Promise<boolean>)>} */
export const ConfirmContext = createContext(null);

/**
 * Returns the promise-based confirm function.
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete deck?', tone: 'danger' }))) return;
 *
 * Throws outside a provider rather than degrading to `window.confirm` or to a silent
 * `true`: a destructive action that skipped its confirmation is exactly the failure this
 * component exists to prevent, so it must be a wiring bug the developer sees, not a
 * fallback the user survives.
 *
 * @returns {(opts: {title?: string, message?: string, confirmLabel?: string,
 *                   cancelLabel?: string, tone?: 'default'|'danger'}) => Promise<boolean>}
 */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}
