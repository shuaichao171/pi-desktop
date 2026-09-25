import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { discoverProviderModels, ProviderDiscoveryError } from '../packages/agent/src/providerDiscovery.ts';

async function server(t, handler) {
  const requests = [];
  const instance = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    instance.closeAllConnections();
    instance.close(resolve);
  }));
  return { url: `http://127.0.0.1:${instance.address().port}`, requests };
}

function json(response, data, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
}

const options = (baseUrl, api = 'openai-completions', extra = {}) => ({ baseUrl, api, ...extra });
const hasCode = (code) => (error) => error instanceof ProviderDiscoveryError && error.code === code;

test('both OpenAI protocols discover local HTTP models with explicit metadata only', async (t) => {
  const fixture = await server(t, (_request, response) => json(response, { data: [
    { id: 'custom-model', name: 'Custom Model', context_length: 200000, max_output_tokens: 32000, reasoning: true, input_modalities: ['text', 'image'], supported_reasoning_efforts: ['none', 'low', 'high', 'max'] },
    { id: 'gpt-fictional-reasoning-1m' },
    { id: 'custom-model', context_length: 99 },
    { id: 'invalid\nmodel' },
    { id: 'invalid-metadata', context_length: -1, max_output_tokens: '8192', reasoning: 'true' },
  ] }));
  for (const api of ['openai-completions', 'openai-responses']) {
    const result = await discoverProviderModels(options(fixture.url, api, { apiKey: 'fixture-secret', headers: { 'x-provider-tenant': 'fixture' } }));
    assert.deepEqual(result.models, [
      { id: 'custom-model', name: 'Custom Model', contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ['text', 'image'], thinkingLevels: ['off', 'low', 'high', 'max'] },
      { id: 'gpt-fictional-reasoning-1m' },
      { id: 'invalid-metadata' },
    ]);
    assert.equal(result.warnings.length, 1);
  }
  assert(fixture.requests.every((request) => request.url === '/v1/models'));
  assert(fixture.requests.every((request) => request.headers.authorization === 'Bearer fixture-secret' && request.headers['x-provider-tenant'] === 'fixture'));
});

test('API roots, versioned URLs, model URLs, and pasted generation endpoints do not duplicate v1', async (t) => {
  const fixture = await server(t, (request, response) => json(response, request.url.includes('v1beta') ? { models: [] } : { data: [] }));
  const cases = [
    ['openai-completions', '/v1/', '/v1/models'],
    ['openai-completions', '/v1/models', '/v1/models'],
    ['openai-completions', '/v1/chat/completions', '/v1/models'],
    ['openai-responses', '/api/responses', '/api/models'],
    ['anthropic-messages', '/', '/v1/models?limit=1000'],
    ['anthropic-messages', '/gateway/v1', '/gateway/v1/models?limit=1000'],
    ['anthropic-messages', '/gateway/v1/messages', '/gateway/v1/models?limit=1000'],
    ['google-generative-ai', '/', '/v1beta/models?pageSize=1000'],
    ['google-generative-ai', '/v1beta', '/v1beta/models?pageSize=1000'],
  ];
  for (const [api, path, expected] of cases) {
    await discoverProviderModels(options(fixture.url + path, api));
    assert.equal(fixture.requests.at(-1).url, expected);
  }
});

test('Anthropic pagination uses after_id and advertised thinking/effort capabilities', async (t) => {
  const fixture = await server(t, (request, response) => {
    const cursor = new URL(request.url, 'http://localhost').searchParams.get('after_id');
    json(response, cursor ? { data: [{ id: 'claude-second', display_name: 'Second', max_input_tokens: 200000, max_output_tokens: 8192, capabilities: { thinking: { supported: false } } }], has_more: false } : {
      data: [{ id: 'claude-first', display_name: 'First', max_input_tokens: 1000000, max_output_tokens: 128000, capabilities: { thinking: { supported: true }, effort: { supported: true, low: true, medium: true, high: true, max: true, xhigh: false } } }],
      has_more: true, last_id: 'claude+first/opaque',
    });
  });
  const result = await discoverProviderModels(options(fixture.url, 'anthropic-messages', { apiKey: 'anthropic-fixture' }));
  assert.deepEqual(result.models, [
    { id: 'claude-first', name: 'First', contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinkingLevels: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-second', name: 'Second', contextWindow: 200000, maxTokens: 8192, reasoning: false },
  ]);
  assert.deepEqual(result.warnings, []);
  assert.equal(new URL(fixture.requests[1].url, fixture.url).searchParams.get('after_id'), 'claude+first/opaque');
  assert(fixture.requests.every(({ headers }) => headers['x-api-key'] === 'anthropic-fixture' && headers['anthropic-version'] === '2023-06-01' && headers.authorization === undefined));
});

test('Gemini pagination sends a header key, strips models/ prefix, and skips explicitly non-generative models', async (t) => {
  const fixture = await server(t, (request, response) => json(response, request.url.includes('pageToken=') ? {
    models: [{ name: 'models/gemini-second', displayName: 'Second', inputTokenLimit: 1000000, outputTokenLimit: 65536, thinking: true, supportedThinkingLevels: ['minimal', 'low', 'medium', 'high'], supportedGenerationMethods: ['generateContent'] }],
  } : {
    models: [{ name: 'models/gemini-first', displayName: 'First', inputTokenLimit: 32768, outputTokenLimit: 8192, thinking: false, supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }],
    nextPageToken: 'opaque+/token',
  }));
  const result = await discoverProviderModels(options(fixture.url + '/v1beta', 'google-generative-ai', { apiKey: 'gemini-fixture' }));
  assert.deepEqual(result.models, [
    { id: 'gemini-first', name: 'First', contextWindow: 32768, maxTokens: 8192, reasoning: false },
    { id: 'gemini-second', name: 'Second', contextWindow: 1000000, maxTokens: 65536, reasoning: true, thinkingLevels: ['minimal', 'low', 'medium', 'high'] },
  ]);
  assert.equal(new URL(fixture.requests[1].url, fixture.url).searchParams.get('pageToken'), 'opaque+/token');
  assert(fixture.requests.every(({ url, headers }) => !url.includes('key=') && headers['x-goog-api-key'] === 'gemini-fixture' && headers.authorization === undefined));
});

test('explicit request authorization is retained without being replaced by apiKey', async (t) => {
  const fixture = await server(t, (_request, response) => json(response, { data: [] }));
  await discoverProviderModels(options(fixture.url, 'openai-responses', { apiKey: 'ignored-fixture-key', headers: { Authorization: 'Bearer supplied-token', 'X-Project': 'test' } }));
  assert.equal(fixture.requests[0].headers.authorization, 'Bearer supplied-token');
  assert.equal(fixture.requests[0].headers['x-project'], 'test');
});

test('independent Gemini token ceilings survive discovery and only model metadata is returned', async (t) => {
  const fixture = await server(t, (_request, response) => json(response, {
    models: [{ name: 'models/independent-limits', displayName: 'Independent limits', inputTokenLimit: 8192, outputTokenLimit: 32768,
      apiKey: 'do-not-return', headers: { authorization: 'do-not-return' }, metadata: { credential: 'do-not-return' } }],
    apiKey: 'do-not-return', error: { credential: 'do-not-return' },
  }));
  const result = await discoverProviderModels(options(fixture.url, 'google-generative-ai'));
  assert.deepEqual(result.models, [{ id: 'independent-limits', name: 'Independent limits', contextWindow: 8192, maxTokens: 32768 }]);
  assert(!JSON.stringify(result).includes('do-not-return'));
});

test('a reasoning boolean does not invent effort levels and reports missing levels', async (t) => {
  const fixture = await server(t, (_request, response) => json(response, { data: [{ id: 'reasoner', context_length: 32768, max_output_tokens: 8192, reasoning: true }] }));
  const result = await discoverProviderModels(options(fixture.url));
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].thinkingLevels, undefined);
  assert.equal(result.warnings.length, 1);
  assert(result.warnings[0].includes('思考强度'));
});

test('cross-origin redirects never forward keys; same-origin redirects are bounded and supported', async (t) => {
  const other = await server(t, (_request, response) => json(response, { data: [] }));
  const fixture = await server(t, (request, response) => {
    if (request.url === '/v1/models') { response.writeHead(302, { location: other.url + '/steal' }); response.end(); }
    else if (request.url === '/same/models') { response.writeHead(307, { location: '/actual/models' }); response.end(); }
    else if (request.url === '/loop/models') { response.writeHead(302, { location: '/loop/models' }); response.end(); }
    else json(response, { data: [{ id: 'same-origin-model' }] });
  });
  await assert.rejects(discoverProviderModels(options(fixture.url, 'openai-completions', { apiKey: 'must-stay-local' })), hasCode('redirect'));
  assert.equal(other.requests.length, 0);
  const result = await discoverProviderModels(options(fixture.url + '/same', 'openai-completions', { apiKey: 'must-stay-local' }));
  assert.equal(result.models[0].id, 'same-origin-model');
  assert.equal(fixture.requests.at(-1).headers.authorization, 'Bearer must-stay-local');
  await assert.rejects(discoverProviderModels(options(fixture.url + '/loop')), hasCode('redirect'));
  assert.equal(fixture.requests.filter(({ url }) => url === '/loop/models').length, 4);
});

test('HTTP and network failures have structured sanitized errors without keys or response bodies', async (t) => {
  const rawSecret = 'fixture-sensitive-token';
  const fixture = await server(t, (_request, response) => json(response, { error: `Unauthorized ${rawSecret}` }, 401));
  await assert.rejects(discoverProviderModels(options(fixture.url, 'openai-completions', { apiKey: rawSecret })), (error) => {
    assert(error instanceof ProviderDiscoveryError);
    assert.equal(error.code, 'http'); assert.equal(error.status, 401);
    assert(!String(error).includes(rawSecret)); assert(!String(error).includes('Unauthorized'));
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(discoverProviderModels(options(fixture.url), async () => { throw new Error('raw body with ' + rawSecret); }), (error) => error.code === 'network' && !String(error).includes(rawSecret));
});

test('invalid connection input fails before any request and malformed JSON never leaks its body', async (t) => {
  let calls = 0;
  const forbiddenFetch = async () => { calls += 1; throw Error('must not be called'); };
  for (const invalid of [
    options('file:///private'), options('https://user:password@example.invalid'), options('https://example.invalid?key=secret'), options('https://example.invalid#secret'),
    options('https://example.invalid', 'unsupported'), options('https://example.invalid', 'openai-completions', { apiKey: 'key\ninjection' }),
    options('https://example.invalid', 'openai-completions', { headers: { Host: 'elsewhere.invalid' } }),
  ]) await assert.rejects(discoverProviderModels(invalid, forbiddenFetch), hasCode('invalid_request'));
  assert.equal(calls, 0);
  const fixture = await server(t, (_request, response) => response.end('raw secret invalid json'));
  await assert.rejects(discoverProviderModels(options(fixture.url)), (error) => error.code === 'invalid_response' && !String(error).includes('raw secret'));
});

test('streamed and declared oversized bodies stop with a bounded error', async (t) => {
  const fixture = await server(t, (request, response) => {
    if (request.url.startsWith('/declared')) { response.writeHead(200, { 'content-length': '2000001' }); response.end(); }
    else { response.writeHead(200); response.write(' '.repeat(1_100_000)); response.end(' '.repeat(1_100_000)); }
  });
  await assert.rejects(discoverProviderModels(options(fixture.url)), hasCode('response_too_large'));
  await assert.rejects(discoverProviderModels(options(fixture.url + '/declared')), hasCode('response_too_large'));
});

test('total body, pagination, duplicate cursor, and model count limits prevent unbounded discovery', async (t) => {
  const fixture = await server(t, (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const index = Number(url.searchParams.get('after_id') ?? '0');
    if (url.pathname.startsWith('/many')) json(response, { data: Array.from({ length: 1002 }, (_, i) => ({ id: 'model-' + i })) });
    else if (url.pathname.startsWith('/repeat')) json(response, { data: [{ id: 'repeated' }], has_more: true, last_id: 'same-cursor' });
    else json(response, { data: [{ id: 'model-' + index }], has_more: true, last_id: String(index + 1), ...(url.pathname.startsWith('/large') ? { padding: 'x'.repeat(1_700_000) } : {}) });
  });
  const paged = await discoverProviderModels(options(fixture.url + '/pages', 'anthropic-messages'));
  assert.equal(paged.models.length, 10);
  assert(paged.warnings.some((warning) => warning.includes('分页')));
  await assert.rejects(discoverProviderModels(options(fixture.url + '/repeat', 'anthropic-messages')), hasCode('invalid_response'));
  await assert.rejects(discoverProviderModels(options(fixture.url + '/large', 'anthropic-messages')), hasCode('response_too_large'));
  const many = await discoverProviderModels(options(fixture.url + '/many'));
  assert.equal(many.models.length, 1000);
  assert(many.warnings.some((warning) => warning.includes('1000')));
});

test('the whole discovery has a deadline even when a fetch implementation ignores abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = discoverProviderModels(options('http://localhost:1234'), async (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(pending, hasCode('timeout'));
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(signal.aborted, true);
});
