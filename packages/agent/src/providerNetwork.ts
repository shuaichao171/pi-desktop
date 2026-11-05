import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Agent, ProxyAgent, fetch as networkFetch, type Dispatcher, type RequestInit as NetworkRequestInit } from 'undici';
import { readProviderDocument } from './customProviders.ts';
import { normalizeResponsesReasoningStream } from './providerResponseStream.ts';
import { sanitizeReasoningRequest } from './thinkingLevels.ts';
import { ProviderDiscoveryError } from './providerDiscovery.ts';

type NetworkScope = { useSystemProxy: boolean } | { provider: string; api: string; modelsPath: string; policy?: Promise<boolean | undefined> };
type SystemProxyResolver = (url: string) => Promise<string>;
const scopes = new AsyncLocalStorage<NetworkScope>();
const boundRuntimes = new WeakSet<ModelRuntime>();
const proxyDispatchers = new Map<string, ProxyAgent>();
let directDispatcher: Agent | undefined;
let resolveSystemProxy: SystemProxyResolver | undefined;
let installedFetch: typeof globalThis.fetch | undefined;

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}

function direct(): Agent {
  return directDispatcher ??= new Agent({ connect: { timeout: 15_000 }, bodyTimeout: 300_000, headersTimeout: 300_000 });
}

/** A PAC fallback must never silently turn an unsupported proxy into direct access. */
function systemDispatcher(proxyResult: string): Dispatcher {
  const directive = proxyResult.split(';').map((item) => item.trim()).find(Boolean);
  if (!directive) throw new ProviderDiscoveryError('network', '系统代理未返回有效连接方式');
  if (/^DIRECT$/i.test(directive)) return direct();
  const match = /^(PROXY|HTTP|HTTPS)\s+(\S+)$/i.exec(directive);
  if (!match) throw new ProviderDiscoveryError('network', /^SOCKS/i.test(directive)
    ? '当前系统代理使用 SOCKS，暂不支持此协议；请在本机代理软件中启用 HTTP/HTTPS 代理'
    : '系统代理返回了不支持的连接方式');
  let endpoint: URL;
  try {
    endpoint = new URL(`${match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`);
    if (!endpoint.hostname || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error();
  } catch { throw new ProviderDiscoveryError('network', '系统代理地址无效'); }
  const key = endpoint.href;
  let dispatcher = proxyDispatchers.get(key);
  if (!dispatcher) {
    // undici 8.x ProxyAgent reads the tunnel connect timeout from the top-level
    // connectTimeout option; connect:{timeout} is silently ignored there and the
    // tunnel would fall back to the 10s default, breaking slow proxy handshakes.
    dispatcher = new ProxyAgent({ uri: key, proxyTunnel: true, connectTimeout: 20_000, bodyTimeout: 300_000, headersTimeout: 300_000 });
    proxyDispatchers.set(key, dispatcher);
    // Drain an older pool when proxy settings change repeatedly. Active requests
    // finish normally; no live sockets are destroyed by this cache bound.
    if (proxyDispatchers.size > 32) {
      const oldest = proxyDispatchers.entries().next().value;
      if (oldest) { proxyDispatchers.delete(oldest[0]); void oldest[1].close().catch(() => {}); }
    }
  }
  return dispatcher;
}

async function policy(scope: NetworkScope): Promise<boolean | undefined> {
  if ('useSystemProxy' in scope) return scope.useSystemProxy;
  return scope.policy ??= readProviderDocument(scope.modelsPath).then((document) => {
    const provider = Object.hasOwn(document.data.providers, scope.provider) ? document.data.providers[scope.provider] : undefined;
    const value = provider?.desktopUseSystemProxy;
    return typeof value === 'boolean' ? value : undefined;
  });
}

function installFetchRouter(): void {
  if (globalThis.fetch === installedFetch) return;
  const inheritedFetch = globalThis.fetch;
  const routedFetch: typeof globalThis.fetch = async (input, init) => {
    const scope = scopes.getStore();
    if (!scope) return inheritedFetch(input, init);
    const normalize = (response: Response): Response => 'provider' in scope && scope.api === 'openai-responses'
      ? normalizeResponsesReasoningStream(response) : response;
    const useSystemProxy = await policy(scope);
    if (useSystemProxy === undefined) return normalize(await inheritedFetch(input, init));
    // Normalize through the active web API, then pass URL + options to npm
    // Undici, whose Request brand may differ from the host runtime's Request.
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    let dispatcher: Dispatcher;
    if (useSystemProxy) {
      // Outside the Electron host (tests, plain Node) no resolver is installed;
      // keep those environments working by falling back to the inherited fetch.
      if (!resolveSystemProxy) return normalize(await inheritedFetch(input, init));
      const result = await abortable(resolveSystemProxy(request.url), request.signal);
      dispatcher = systemDispatcher(result);
    } else dispatcher = direct();
    request.signal.throwIfAborted();
    const options: NetworkRequestInit = {
      method: request.method,
      headers: [...request.headers],
      body: request.body as NetworkRequestInit['body'],
      signal: request.signal,
      redirect: request.redirect,
      credentials: request.credentials,
      cache: request.cache,
      mode: request.mode,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive,
      duplex: 'half',
      dispatcher,
    };
    return normalize(await networkFetch(request.url, options) as unknown as Response);
  };
  installedFetch = routedFetch;
  globalThis.fetch = routedFetch;
}

/** Install once per process. Resolver updates do not affect unrelated requests. */
export function configureProviderNetwork(resolver: SystemProxyResolver): void {
  resolveSystemProxy = resolver;
  installFetchRouter();
}

/** Also used by model discovery, before any provider configuration is saved. */
export function runWithProviderNetwork<T>(useSystemProxy: boolean, work: () => T): T {
  installFetchRouter();
  return scopes.run({ useSystemProxy }, work);
}

/** Every new model request reads current policy; existing SDK streams stay intact. */
export function bindProviderNetwork(runtime: ModelRuntime, modelsPath: string): void {
  installFetchRouter();
  if (boundRuntimes.has(runtime)) return;
  boundRuntimes.add(runtime);
  const run = <T>(provider: string, api: string, work: () => T): T => scopes.run({ provider, api, modelsPath }, work);
  // Reasoning efforts are normalized here so /compact, auto-compaction and chat
  // share one guard below both SDK entry points (see thinkingLevels.ts).
  const stream = runtime.stream.bind(runtime);
  runtime.stream = (model, context, options) => { const safe = sanitizeReasoningRequest(model, options); return run(safe.model.provider, safe.model.api, () => stream(safe.model, context, safe.options)); };
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => { const safe = sanitizeReasoningRequest(model, options); return run(safe.model.provider, safe.model.api, () => streamSimple(safe.model, context, safe.options)); };
  const streamDeferred = runtime.streamDeferred.bind(runtime);
  runtime.streamDeferred = (model, handle, options) => { const safe = sanitizeReasoningRequest(model, options); return run(safe.model.provider, safe.model.api, () => streamDeferred(safe.model, handle, safe.options)); };
  const cancelDeferred = runtime.cancelDeferred.bind(runtime);
  runtime.cancelDeferred = (model, handle, options) => { const safe = sanitizeReasoningRequest(model, options); return run(safe.model.provider, safe.model.api, () => cancelDeferred(safe.model, handle, safe.options)); };
}
