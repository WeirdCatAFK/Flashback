/**
 * ConflictBanner — what an editor shows when its save was refused because the document
 * changed underneath it.
 *
 * A banner rather than a modal, deliberately: the draft is still in the editor behind it and
 * has to stay visible, because it is the thing the user is about to decide the fate of. A
 * modal would hide exactly what they need to look at.
 *
 * Two ways out, both of them explicit — there is no correct automatic answer:
 *   Reload    — take what is on disk now, discarding this draft.
 *   Overwrite — keep this draft and let it win, discarding the other version.
 *
 *   <ConflictBanner onReload={…} onOverwrite={…} />
 */

import { useT } from '../../translations';
import './ConflictBanner.css';

export default function ConflictBanner({ onReload, onOverwrite, message }) {
  const { t } = useT();
  return (
    <div className="conflict-banner" role="alert">
      <span className="conflict-banner__message">
        {message ?? t('This document changed while you were editing it. Your unsaved work is still here.')}
      </span>
      <span className="conflict-banner__actions">
        <button type="button" className="conflict-banner__btn" onClick={onReload}>
          {t('Reload')}
        </button>
        <button type="button" className="conflict-banner__btn conflict-banner__btn--primary" onClick={onOverwrite}>
          {t('Overwrite')}
        </button>
      </span>
    </div>
  );
}
