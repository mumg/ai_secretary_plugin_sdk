import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { PluginApiError, PluginClient, createResourceTransport, createSignedTransport, definePlugin, signPluginRequest } from '../index.mjs';

const secret = 'a'.repeat(64);
const path = '/api/v1/plugins/sample_chat/conversations:batch';
const message = number => ({ external_id: `event-${number}`, thread_external_id: 'thread-1',
  body: `Neutral message ${number}`, occurred_at: '2026-10-01T10:00:00Z' });

test('signature matches the server canonical request format', () => {
  assert.equal(signPluginRequest({ secret, timestamp: '1700000000', nonce: 'nonce_000000000001',
    method: 'POST', path, body: '{"messages":[]}' }),
  '060ebb2e88a278dfbe893f1c01eb8fca4fdde7cd135a1cc961c983aec1d147c3');
  const input = { secret, timestamp: '1700000000', nonce: 'nonce_000000000001',
    method: 'POST', path, body: '{"messages":[]}' };
  assert.equal(signPluginRequest({ ...input, body: new TextEncoder().encode(input.body) }),
    signPluginRequest(input));
});

test('signed transport authenticates exact UTF-8 request bytes', async () => {
  const calls = [];
  const transport = createSignedTransport({ baseUrl: 'http://127.0.0.1:8000', pluginId: 'sample_chat', secret,
    now: () => 1700000000000, nonce: () => 'nonce_000000000002',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { status: 202, json: async () => ({ source_id: 'plugin_sample_chat', created: 1, updated: 0, unchanged: 0 }) };
    } });
  const client = new PluginClient({ transport });
  assert.deepEqual(await client.sendConversations([{ ...message(1), body: 'Пример сообщения' }]),
    { source_id: 'plugin_sample_chat', created: 1, updated: 0, unchanged: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8000' + path);
  const { body, headers } = calls[0].options;
  const digest = createHash('sha256').update(body).digest('hex');
  const canonical = ['1700000000', 'nonce_000000000002', 'POST', path, digest].join('\n');
  assert.equal(headers['X-Plugin-Signature'], createHmac('sha256', secret).update(canonical).digest('hex'));
  assert.equal(JSON.parse(body).messages[0].body, 'Пример сообщения');
});

test('101 messages are sent as 100 plus 1 and results are combined', async () => {
  const sizes = [];
  const client = new PluginClient({ transport: async payload => {
    sizes.push(payload.messages.length);
    return { source_id: 'plugin_sample_chat', created: payload.messages.length, updated: 0, unchanged: 0 };
  } });
  assert.deepEqual(await client.sendConversations(Array.from({ length: 101 }, (_, n) => message(n))),
    { source_id: 'plugin_sample_chat', created: 101, updated: 0, unchanged: 0 });
  assert.deepEqual(sizes, [100, 1]);
});

test('invalid messages fail before any request', async () => {
  let calls = 0;
  const client = new PluginClient({ transport: async () => { calls++; } });
  await assert.rejects(client.sendConversations([message(1), message(1)]), /external_id/);
  await assert.rejects(client.sendConversations([{ ...message(1), extra: 'bad' }]), /unknown message field/);
  await assert.rejects(client.sendConversations([{ ...message(1), occurred_at: 'tomorrow' }]), /date-time/);
  await assert.rejects(client.sendConversations([{ ...message(1), participants: ['bad'] }]), /participants/);
  assert.equal(calls, 0);
});

test('temporary failure retries with a fresh nonce; authentication failure does not', async () => {
  let attempts = 0;
  const nonces = ['nonce_000000000003', 'nonce_000000000004'];
  const headers = [];
  const transport = createSignedTransport({ baseUrl: 'https://secretary.example.test', pluginId: 'sample_chat', secret,
    nonce: () => nonces.shift(), sleep: async () => {},
    fetchImpl: async (_, options) => {
      headers.push(options.headers);
      attempts++;
      return attempts === 1
        ? { status: 503, json: async () => ({ detail: 'temporary' }) }
        : { status: 202, json: async () => ({ source_id: 'plugin_sample_chat', created: 1, updated: 0, unchanged: 0 }) };
    } });
  await new PluginClient({ transport }).sendConversations([message(2)]);
  assert.equal(attempts, 2);
  assert.notEqual(headers[0]['X-Plugin-Nonce'], headers[1]['X-Plugin-Nonce']);
  assert.notEqual(headers[0]['X-Plugin-Signature'], headers[1]['X-Plugin-Signature']);

  const unauthorized = new PluginClient({ transport: createSignedTransport({
    baseUrl: 'https://secretary.example.test', pluginId: 'sample_chat', secret,
    fetchImpl: async () => { attempts++; return { status: 403, json: async () => ({ detail: 'disabled' }) }; },
  }) });
  await assert.rejects(unauthorized.sendConversations([message(3)]), error =>
    error instanceof PluginApiError && error.status === 403 && !error.retryable && error.message === 'disabled');
  assert.equal(attempts, 3);
});

test('remote HTTP and unsafe origins are refused', () => {
  for (const baseUrl of ['http://secretary.example.test', 'https://u:p@secretary.example.test',
    'https://secretary.example.test/prefix', 'file:///tmp/plugin']) {
    assert.throws(() => createSignedTransport({ baseUrl, pluginId: 'sample_chat', secret }), TypeError);
  }
  assert.throws(() => createSignedTransport({ baseUrl: 'https://secretary.example.test',
    pluginId: '../other', secret }), TypeError);
});

test('plugin lifecycle declaration keeps required callbacks', async () => {
  const plugin = definePlugin({ id: 'sample_chat', isConfigured: settings => Boolean(settings.channel),
    configure: async ({ onSuccess }) => onSuccess(), start: async () => {}, stop: async () => {} });
  assert.equal(await plugin.isConfigured({ channel: 'demo' }), true);
  assert.equal(Object.isFrozen(plugin), true);
  assert.throws(() => definePlugin({ id: 'bad/id', start: async () => {} }), TypeError);
});

test('task batches use signed task endpoint and preserve create-only acknowledgements', async () => {
  const requests = [];
  const transport = createSignedTransport({ baseUrl: 'http://127.0.0.1:8000', pluginId: 'sample_chat',
    secret, resource: 'tasks', fetchImpl: async (url, options) => {
      requests.push([url, options]);
      const tasks = JSON.parse(options.body).tasks;
      return { status: 200, json: async () => ({ source_id: 'plugin_sample_chat', created: tasks.length,
        updated: 0, unchanged: 0, items: tasks.map(task => ({ external_id: task.external_id,
          task_id: task.external_id, action: 'created', status: 'NEW', active: true })) }) };
    } });
  const client = new PluginClient({ taskTransport: transport });
  const tasks = Array.from({ length: 501 }, (_, n) => ({ external_id: `task-${n}`, title: `Sample task ${n}` }));
  const result = await client.sendTasks(tasks);
  assert.equal(result.created, 501);
  assert.deepEqual(requests.map(([, options]) => JSON.parse(options.body).tasks.length), [500, 1]);
  assert.match(requests[0][0], /\/tasks:batch$/);
  assert.equal(JSON.parse(requests[0][1].body).close_missing, false);
  await assert.rejects(client.sendTasks([{ ...tasks[0], priority: 'URGENT' }]), /priority/);
  assert.equal(requests.length, 2);
});

test('plugin status uses its signed endpoint', async () => {
  const requests = [];
  const client = new PluginClient({ statusTransport: createSignedTransport({
    baseUrl: 'http://127.0.0.1:8000', pluginId: 'sample_chat', secret, resource: 'status',
    fetchImpl: async (url, options) => { requests.push([url, options]); return { status: 200,
      json: async () => ({ status: 'BUSY' }) }; },
  }) });
  await client.reportStatus('BUSY', 'Loading');
  assert.match(requests[0][0], /\/status$/);
  assert.deepEqual(JSON.parse(requests[0][1].body), { status: 'BUSY', message: 'Loading' });
});

test('resource worker checks availability before get and can wake waiting work', async () => {
  const requests = [];
  const pending = [
    {event_id: 'event-1', reference: 'ARC-42', resource_type: 'task', operation: 'availability', claim_id: 'claim-1'},
    {event_id: 'event-1', reference: 'ARC-42', resource_type: 'task', operation: 'get', claim_id: 'claim-2'},
  ];
  const controller = new AbortController();
  let completed = 0;
  const client = new PluginClient({resourceTransport: createResourceTransport({
    baseUrl: 'http://127.0.0.1:8000', pluginId: 'sample_chat', secret,
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({url, payload});
      if (url.endsWith('resource-jobs:claim')) {
        const job = pending.shift();
        return {status: 200, json: async () => ({jobs: job ? [job] : []})};
      }
      if (url.endsWith('resource-jobs:complete') && ++completed === 2) controller.abort();
      return {status: 200, json: async () => ({state: 'READY', requeued: 1})};
    },
  })});
  await client.runResourceWorker({
    availability: async () => 'available',
    get: async () => ({type: 'task', title: 'Sample task', content: 'Review sample data',
      url: 'https://tracker.example.test/ARC-42', version: '2', updated_at: '2026-10-01T10:00:00Z'}),
  }, {signal: controller.signal});
  const completions = requests.filter(call => call.url.endsWith('resource-jobs:complete'));
  assert.equal(completions.length, 2);
  assert.equal(completions[0].payload.status, 'available');
  assert.equal(completions[1].payload.resource.version, '2');
  await client.notifyResourcesAvailable();
  assert.equal(requests.at(-1).payload.available, true);
});

test('search job is completed with search identity and results', async () => {
  let completion;
  const client = new PluginClient({resourceTransport: {
    claim: async () => ({jobs: []}),
    complete: async payload => { completion = payload; return {state: 'READY'}; },
    notify: async () => ({requeued: 0}),
  }});
  const job = {operation: 'search', search_id: 'search-1', query: 'sample', claim_id: 'claim-1'};
  await client.completeResourceJob(job, {status: 'available', results: []});
  assert.deepEqual(completion, {search_id: 'search-1', claim_id: 'claim-1', status: 'available', results: []});
});
