import { createContext } from 'react';

/**
 * True while the surrounding message content is still streaming. Heavy render
 * work (worker highlighting) only runs on stable content: re-highlighting on
 * every streamed token would flicker and thrash the worker. Defaults to false
 * — anything not explicitly streaming counts as stable.
 */
export const StreamingContentContext = createContext(false);
