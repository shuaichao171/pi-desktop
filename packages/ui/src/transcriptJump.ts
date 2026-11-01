import { createContext } from 'react';

/** ChatView-level jump facility shared with message action rows: scroll the
 * transcript so the given message row is visible (handles the virtualized
 * timeline, reading anchors and reveal state). Null when no host provides it. */
export const JumpToMessageContext = createContext<((id: string) => void) | null>(null);
