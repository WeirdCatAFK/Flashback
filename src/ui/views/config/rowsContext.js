/**
 * What Config's rows read while they render: the catalogue by id (settings.js), and while
 * a search is open, the ids it matched. A row outside `only` renders nothing, which is how
 * one section component serves both its own page and a search's result list. Its own file
 * because a `.jsx` module exports components only.
 */

import { createContext, useContext } from 'react';

export const RowsContext = createContext({ rows: new Map(), only: null });

/** The catalogue and the search's matches, if any. */
export const useRows = () => useContext(RowsContext);

/** Whether a search is showing, when a section's prose and extras stay out of the way. */
export const useSearching = () => useContext(RowsContext).only !== null;
