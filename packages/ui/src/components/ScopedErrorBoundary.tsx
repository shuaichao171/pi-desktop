import { Component, type ReactNode } from 'react';
import type { UiDiagnosticEvent } from '@pidesktop/shared';
import { useT } from '../i18n';
import { ErrorDetails } from './ErrorDetails';
import { Icon } from './Icons';

export interface ScopedErrorBoundaryProps { children: ReactNode; scope: UiDiagnosticEvent['scope']; resetKeys?: readonly unknown[]; onReset?: () => void }
export function resetKeysChanged(previous: readonly unknown[] = [], current: readonly unknown[] = []): boolean {
  return previous.length !== current.length || previous.some((value, index) => !Object.is(value, current[index]));
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === 'string' ? value : 'Unknown rendering failure'); }
function ScopedFailure({ error, scope, onRetry }: { error: Error; scope: UiDiagnosticEvent['scope']; onRetry: () => void }) {
  const { t } = useT();
  return <section className="pd-scoped-error" role="alert"><span className="pd-scoped-error-icon" aria-hidden="true"><Icon name="alert" width="18" height="18" /></span><div className="pd-scoped-error-copy"><strong>{t('error.areaTitle')}</strong><p>{t('error.areaDescription')}</p></div><button type="button" onClick={onRetry}>{t('error.areaRetry')}</button><ErrorDetails error={error.stack ?? error.message} scope={scope} kind="render-error" /></section>;
}
/** Rendering failures stay local. A different file/session automatically gets a fresh subtree. */
export class ScopedErrorBoundary extends Component<ScopedErrorBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: asError(error) }; }
  componentDidUpdate(previous: ScopedErrorBoundaryProps) {
    if (this.state.error && (previous.scope !== this.props.scope || resetKeysChanged(previous.resetKeys, this.props.resetKeys))) this.setState({ error: null });
  }
  private retry = () => {
    try { this.props.onReset?.(); this.setState({ error: null }); }
    catch (error) { this.setState({ error: asError(error) }); }
  };
  render() { return this.state.error ? <ScopedFailure error={this.state.error} scope={this.props.scope} onRetry={this.retry} /> : this.props.children; }
}
