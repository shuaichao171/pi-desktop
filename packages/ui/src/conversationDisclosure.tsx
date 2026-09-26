import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

/** Choices belong to a conversation, so virtual rows can unmount without erasing them. */
export function createDisclosureStore() {
  const choices = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  const requests = new Map<string, number>();
  return {
    get: (key: string) => choices.get(key) ?? null,
    set(key: string, expanded: boolean) {
      if (choices.get(key) === expanded) return;
      choices.set(key, expanded);
      listeners.get(key)?.forEach(listener => listener());
    },
    subscribe(key: string, listener: () => void) {
      let group = listeners.get(key);
      if (!group) { group = new Set(); listeners.set(key, group); }
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(key);
      };
    },
    consumeRequest(key: string, request: number) {
      if ((requests.get(key) ?? -1) >= request) return false;
      requests.set(key, request);
      return true;
    },
  };
}

/** Navigation requests must not replay when a virtual row mounts again. */
export function useDisclosureRequest(key: string): (request: number) => boolean {
  const store = useContext(DisclosureContext);
  const local = useRef<{ key: string; request: number } | null>(null);
  return useCallback((request: number) => {
    if (store) return store.consumeRequest(key, request);
    if (local.current?.key === key && local.current.request >= request) return false;
    local.current = { key, request };
    return true;
  }, [store, key]);
}

const DisclosureContext = createContext<ReturnType<typeof createDisclosureStore> | null>(null);

export function ConversationDisclosureProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const store = useMemo(createDisclosureStore, [scope]);
  return <DisclosureContext.Provider value={store}>{children}</DisclosureContext.Provider>;
}

/** Standalone activity components still work without a conversation provider. */
export function useDisclosureChoice(key: string): [boolean | null, (expanded: boolean) => void] {
  const store = useContext(DisclosureContext);
  const [local, setLocal] = useState<{ key: string; expanded: boolean } | null>(null);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(key, listener) ?? (() => {}), [store, key]);
  const snapshot = useCallback(() => store?.get(key) ?? null, [store, key]);
  const choice = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setChoice = useCallback((expanded: boolean) => {
    if (store) store.set(key, expanded);
    else setLocal({ key, expanded });
  }, [store, key]);
  return [store ? choice : local?.key === key ? local.expanded : null, setChoice];
}
