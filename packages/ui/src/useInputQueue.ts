import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { UiQueuedMessage } from '@pidesktop/shared';
import type { InputFeatureBridge, UiInputQueueScope } from '../../shared/src/inputFeatures';
import { useChatStore } from './store';
import { InputQueueController } from './inputQueueController';

type QueueBridge = Partial<InputFeatureBridge>;
interface SharedController { controller: InputQueueController; holds: number; users: number }

/**
 * The composer queue strip and the transcript's pending bubbles act on the same queue.
 * They share one controller per bridge + scope so their mutations serialize against a
 * single version and row-pending state shows in both places.
 */
const sharedControllers = new WeakMap<object, Map<string, SharedController>>();
const scopeKey = (scope: UiInputQueueScope) => `${scope.cwd}\0${scope.sessionPath ?? ''}\0${scope.sessionId}`;

function acquireController(bridge: QueueBridge | null, scope: UiInputQueueScope): SharedController {
  const owner = (bridge ?? sharedControllers) as object;
  let byScope = sharedControllers.get(owner);
  if (!byScope) { byScope = new Map(); sharedControllers.set(owner, byScope); }
  const key = scopeKey(scope);
  let shared = byScope.get(key);
  if (!shared) {
    shared = {
      holds: 0, users: 0,
      controller: new InputQueueController({
        getInputQueue: value => bridge!.getInputQueue!(value),
        mutateInputQueue: request => bridge!.mutateInputQueue!(request),
      }, scope, () => {
        const current = useChatStore.getState();
        return current.bridge === bridge && current.cwd === scope.cwd && current.sessionPath === scope.sessionPath && current.sessionId === scope.sessionId
          && !current.navigationPending && !current.sessionLoading && (current.status === 'busy' || current.status === 'idle');
      }),
    };
    byScope.set(key, shared);
  }
  return shared;
}

function releaseController(bridge: QueueBridge | null, scope: UiInputQueueScope, shared: SharedController): void {
  shared.users -= 1;
  if (shared.users > 0) return;
  const byScope = sharedControllers.get((bridge ?? sharedControllers) as object);
  if (byScope?.get(scopeKey(scope)) === shared) byScope.delete(scopeKey(scope));
}

/** Session-scoped, serialized mutations with independent row feedback. */
export function useInputQueue(items: UiQueuedMessage[]) {
  const bridge = useChatStore(state => state.bridge) as QueueBridge | null;
  const cwd = useChatStore(state => state.cwd), sessionPath = useChatStore(state => state.sessionPath), sessionId = useChatStore(state => state.sessionId);
  const loading = useChatStore(state => state.sessionLoading || state.navigationPending), status = useChatStore(state => state.status);
  const available = Boolean(cwd && sessionId && !loading && (status === 'busy' || status === 'idle') && bridge?.getInputQueue && bridge?.mutateInputQueue);
  const scope = useMemo<UiInputQueueScope>(() => ({ cwd, sessionPath, sessionId: sessionId ?? '' }), [cwd, sessionPath, sessionId]);
  const shared = useMemo(() => acquireController(bridge, scope), [bridge, scope]);
  const controller = shared.controller;
  useLayoutEffect(() => { shared.users += 1; return () => releaseController(bridge, scope, shared); }, [bridge, scope, shared]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Enabled while any consumer is mounted and available; one unmount must not disable the other.
  useLayoutEffect(() => {
    if (!available) return;
    shared.holds += 1; controller.setEnabled(true);
    return () => { shared.holds -= 1; if (shared.holds === 0) controller.setEnabled(false); };
  }, [shared, controller, available]);
  useEffect(() => { if (available) void controller.refresh(); }, [controller, items, available]);
  return { ...state, pending: state.pendingRows.size > 0 || state.pendingGlobal, ready: available && Boolean(state.queue), refresh: controller.refresh, mutate: controller.mutate };
}
