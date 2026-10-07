/**
 * @pidesktop/shared — loopback AI debugging API contract.
 *
 * Pi Desktop can expose a local-only HTTP debug endpoint (default
 * 127.0.0.1:47899) so an assistant can inspect the running app — status,
 * cloud-sync state, a request-level cloud log and manual triggers — without a
 * debugger attached. Authentication is optional and toggled in settings.
 */

export const DEBUG_API_CHANNELS = {
  getState: 'debug-api:get-state',
  setConfig: 'debug-api:set-config',
} as const;

export interface UiDebugApiConfig {
  /** Whether the loopback debug server should run. */
  enabled: boolean;
  /** Loopback port; must be an integer between 1 and 65535. */
  port: number;
  /** When true, requests must send `Authorization: Bearer <token>`. */
  authEnabled: boolean;
  /** Bearer token; empty allows the server to generate one when auth turns on. */
  token: string;
}

export interface UiDebugApiState extends UiDebugApiConfig {
  /** Whether the server currently accepts connections. */
  running: boolean;
  /** http://127.0.0.1:<port> when running; null otherwise. */
  baseUrl: string | null;
}
