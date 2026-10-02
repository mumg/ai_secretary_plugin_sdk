import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { PluginApiError, PluginClient, createSignedTransport, definePlugin, signPluginRequest } from '../index.mjs';

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
