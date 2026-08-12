export interface HistoryState<T> { past: T[]; present: T; future: T[] }
export const createHistory = <T>(initial: T): HistoryState<T> => ({ past: [], present: initial, future: [] });
export const commit = <T>(state: HistoryState<T>, next: T): HistoryState<T> => ({ past: [...state.past, state.present].slice(-50), present: next, future: [] });
export const undo = <T>(state: HistoryState<T>): HistoryState<T> => state.past.length ? { past: state.past.slice(0, -1), present: state.past.at(-1)!, future: [state.present, ...state.future] } : state;
export const redo = <T>(state: HistoryState<T>): HistoryState<T> => state.future.length ? { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1) } : state;
