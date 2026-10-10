export interface UiDiagnosticEvent {
  id: string;
  scope: 'conversation' | 'workbench' | 'terminal' | 'preview' | 'approval' | 'session-navigation' | 'automation' | 'plugins' | 'settings' | 'search';
  kind: 'render-error' | 'operation-error' | 'session-open';
  outcome: 'success' | 'failure' | 'cancelled';
  durationMs?: number;
  phases?: { rpcMs?: number; snapshotMs?: number; renderMs?: number; paintMs?: number };
  temperature?: 'cold' | 'warm';
  code?: string;
}

/** A renderer can report timing and correlation, never arbitrary log payloads. */
export function normalizeUiDiagnostic(value: unknown): UiDiagnosticEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(v.id)
    || typeof v.scope !== 'string' || !['conversation','workbench','terminal','preview','approval','session-navigation','automation','plugins','settings','search'].includes(v.scope)
    || typeof v.kind !== 'string' || !['render-error','operation-error','session-open'].includes(v.kind)
    || typeof v.outcome !== 'string' || !['success','failure','cancelled'].includes(v.outcome)) return null;
  const ms = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 3_600_000 ? Math.round(n * 100) / 100 : undefined;
  const result: UiDiagnosticEvent = { id: v.id, scope: v.scope as UiDiagnosticEvent['scope'], kind: v.kind as UiDiagnosticEvent['kind'], outcome: v.outcome as UiDiagnosticEvent['outcome'] };
  if (ms(v.durationMs) !== undefined) result.durationMs = ms(v.durationMs);
  if (v.temperature === 'cold' || v.temperature === 'warm') result.temperature = v.temperature;
  if (typeof v.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(v.code)) result.code = v.code;
  if (v.phases && typeof v.phases === 'object') {
    result.phases = {};
    for (const key of ['rpcMs','snapshotMs','renderMs','paintMs'] as const) {
      const n = ms((v.phases as Record<string, unknown>)[key]);
      if (n !== undefined) result.phases[key] = n;
    }
  }
  return result;
}
