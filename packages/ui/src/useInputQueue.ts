import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiQueuedMessage } from '@pidesktop/shared';
import type { InputFeatureBridge, UiInputQueue, UiInputQueueMutation, UiInputQueueScope } from '../../shared/src/inputFeatures';
import { useChatStore } from './store';

/** Session-scoped, versioned queue snapshots. Late reads never replace a newer mutation. */
export function useInputQueue(items: UiQueuedMessage[]) {
  const bridge = useChatStore(state => state.bridge) as Partial<InputFeatureBridge> | null;
  const cwd = useChatStore(state => state.cwd), sessionPath = useChatStore(state => state.sessionPath), sessionId = useChatStore(state => state.sessionId);
  const loading = useChatStore(state => state.sessionLoading), status = useChatStore(state => state.status);
  const available = Boolean(cwd && sessionId && !loading && (status === 'busy' || status === 'idle'));
  const scope = useMemo<UiInputQueueScope>(() => ({ cwd, sessionPath, sessionId: sessionId ?? '' }), [cwd, sessionPath, sessionId]);
  const [queue, setQueue] = useState<UiInputQueue | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const latest = useRef<UiInputQueue | null>(null), generation = useRef(0), locked = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const accept = (next: UiInputQueue) => {
    if (!mounted.current || (next.scope && (next.scope.cwd !== scope.cwd || next.scope.sessionPath !== scope.sessionPath || next.scope.sessionId !== scope.sessionId))) return null;
    if (latest.current && next.version < latest.current.version) return latest.current;
    latest.current = next; setQueue(next);
    return next;
  };
  async function refresh() {
    const request = ++generation.current;
    if (!bridge?.getInputQueue || !available || !mounted.current) return;
    try {
      const next = await bridge.getInputQueue(scope);
      if (request === generation.current && mounted.current) { accept(next); setError(''); }
    } catch (cause) {
      if (request === generation.current && mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [bridge, scope, items, available]);
  async function mutate(action: UiInputQueueMutation['action'], id?: string, text?: string, beforeId?: string | null) {
    if (!available || locked.current || !latest.current || !bridge?.mutateInputQueue) return null;
    locked.current = true; generation.current++; setPending(true); setError('');
    try {
      const next = await bridge.mutateInputQueue({ scope, requestId: crypto.randomUUID(), expectedVersion: latest.current.version, action, id, text, beforeId });
      return accept(next);
    } catch (cause) {
      // Refresh the version after conflicts, but retain the actionable error and editor draft.
      const message = cause instanceof Error ? cause.message : String(cause);
      await refresh();
      if (mounted.current) setError(message);
      return null;
    } finally { locked.current = false; if (mounted.current) setPending(false); }
  }
  return { queue, error, pending, ready: Boolean(available && queue && bridge?.mutateInputQueue), refresh, mutate };
}
