import { createContext, useContext } from 'react';

export const RowsContext = createContext({ rows: new Map(), only: null });

export const useRows = () => useContext(RowsContext);

export const useSearching = () => useContext(RowsContext).only !== null;
