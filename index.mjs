import { createHash, createHmac, randomBytes } from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{1,110}$/;
const SECRET = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const RETRYABLE = new Set([429, 502, 503, 504]);
const MESSAGE_FIELDS = new Set([
  'external_id', 'thread_external_id', 'body', 'occurred_at',
  'subject', 'author', 'direction', 'source_url', 'participants',
]);
const TASK_FIELDS = new Set([
  'external_id', 'title', 'description', 'status', 'priority', 'due_at',
  'source_url', 'evidence', 'occurred_at', 'source_updated_at',
]);

function requireString(value, field, max = Infinity) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function normalizeURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('baseUrl must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new TypeError('remote plugin API requires HTTPS');
  }
  return url.origin;
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('message must be an object');
  }
  for (const field of Object.keys(message)) {
    if (!MESSAGE_FIELDS.has(field)) throw new TypeError(`unknown message field: ${field}`);
  }
  const result = { ...message };
  requireString(result.external_id, 'external_id', 512);
  requireString(result.thread_external_id, 'thread_external_id', 512);
  requireString(result.body, 'body', 8 << 20);
  if (result.occurred_at instanceof Date) result.occurred_at = result.occurred_at.toISOString();
  requireString(result.occurred_at, 'occurred_at');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result.occurred_at) ||
      !Number.isFinite(Date.parse(result.occurred_at))) {
    throw new TypeError('occurred_at must be an ISO date-time');
  }
  for (const [field, max] of [['subject', 2000], ['author', 512], ['source_url', 4000]]) {
    if (result[field] !== undefined && (typeof result[field] !== 'string' || result[field].length > max)) {
      throw new TypeError(`${field} must be a string of at most ${max} characters`);
    }
  }
  if (result.direction !== undefined && !['INCOMING', 'OUTGOING', 'INTERNAL'].includes(result.direction)) {
    throw new TypeError('direction must be INCOMING, OUTGOING or INTERNAL');
  }
  if (result.participants !== undefined) {
    if (!Array.isArray(result.participants) || result.participants.some(person =>
      !person || typeof person !== 'object' || Array.isArray(person) ||
      Object.keys(person).some(key => !['name', 'address', 'role'].includes(key)) ||
      Object.values(person).some(value => typeof value !== 'string'))) {
      throw new TypeError('participants must be an array of {name, address, role} objects');
    }
  }
  return result;
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task) ||
      Object.keys(task).some(field => !TASK_FIELDS.has(field))) {
    throw new TypeError('task contains unsupported fields');
  }
  requireString(task.external_id, 'external_id', 512);
  requireString(task.title, 'title', 500);
  const result = { ...task };
  for (const [field, max] of [['description', 20000], ['source_url', 4000], ['evidence', 2000]]) {
    if (result[field] !== undefined && (typeof result[field] !== 'string' || result[field].length > max)) {
      throw new TypeError(`${field} must be a string of at most ${max} characters`);
    }
  }
  for (const field of ['due_at', 'occurred_at', 'source_updated_at']) {
    if (result[field] instanceof Date) result[field] = result[field].toISOString();
    if (result[field] !== undefined && (typeof result[field] !== 'string' ||
        !Number.isFinite(Date.parse(result[field])))) throw new TypeError(`invalid ${field}`);
  }
  if (result.status !== undefined && !['NEEDS_CONFIRMATION', 'NEW', 'IN_PROGRESS', 'POSSIBLY_COMPLETED', 'COMPLETED', 'CANCELLED'].includes(result.status)) {
    throw new TypeError('invalid task status');
  }
  if (result.priority !== undefined && !['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].includes(result.priority)) {
    throw new TypeError('invalid task priority');
  }
  return result;
}

export function signPluginRequest({ secret, timestamp, nonce, method, path, body }) {
  if (!SECRET.test(secret)) throw new TypeError('secret must be a 64-character lowercase hex string');
  if (!/^\d+$/.test(String(timestamp))) throw new TypeError('timestamp must contain Unix seconds');
  if (!NONCE.test(nonce)) throw new TypeError('nonce must contain 16–128 URL-safe characters');
  if (typeof method !== 'string' || !/^[A-Z]+$/.test(method)) throw new TypeError('invalid HTTP method');
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new TypeError('path must be an escaped request path without query or fragment');
  }
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) throw new TypeError('body must be text or bytes');
  const digest = createHash('sha256').update(body).digest('hex');
  const canonical = [String(timestamp), nonce, method, path, digest].join('\n');
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

export class PluginApiError extends Error {
  constructor(status, detail) {
    super(detail || `Plugin API returned HTTP ${status}`);
    this.name = 'PluginApiError';
    this.status = status;
    this.retryable = RETRYABLE.has(status);
  }
}

/** A transport receives one already validated batch and returns API counters. */
export class PluginClient {
  constructor({ transport, taskTransport, statusTransport, resourceTransport }) {
    if (typeof transport !== 'function' && typeof taskTransport !== 'function' && typeof statusTransport !== 'function' && !resourceTransport) {
      throw new TypeError('at least one transport must be a function');
    }
    this.transport = transport;
    this.taskTransport = taskTransport;
    this.statusTransport = statusTransport;
    this.resourceTransport = resourceTransport;
  }

  async sendConversations(messages, { signal } = {}) {
    if (typeof this.transport !== 'function') throw new TypeError('conversation transport is unavailable');
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
    const normalized = messages.map(normalizeMessage);
    const ids = new Set(normalized.map(message => message.external_id));
    if (ids.size !== normalized.length) throw new TypeError('external_id must be unique within a submission');
    const result = { source_id: null, created: 0, updated: 0, unchanged: 0 };
    for (let start = 0; start < normalized.length; start += 100) {
      const batch = await this.transport({ messages: normalized.slice(start, start + 100) }, { signal });
      if (!batch || typeof batch.source_id !== 'string' ||
          !['created', 'updated', 'unchanged'].every(key => Number.isSafeInteger(batch[key]) && batch[key] >= 0) ||
          (result.source_id !== null && result.source_id !== batch.source_id)) {
        throw new Error('Plugin API returned an invalid batch result');
      }
      result.source_id = batch.source_id;
      result.created += batch.created;
      result.updated += batch.updated;
      result.unchanged += batch.unchanged;
    }
    return result;
  }

  async sendTasks(tasks, { signal } = {}) {
    if (typeof this.taskTransport !== 'function') throw new TypeError('task transport is unavailable');
    if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
    const normalized = tasks.map(normalizeTask);
    const ids = new Set(normalized.map(task => task.external_id));
    if (ids.size !== normalized.length) throw new TypeError('external_id must be unique within a submission');
    const result = { source_id: null, created: 0, updated: 0, unchanged: 0, items: [] };
    for (let start = 0; start < normalized.length; start += 500) {
      const batch = normalized.slice(start, start + 500);
      const batchIDs = new Set(batch.map(task => task.external_id));
      const reply = await this.taskTransport({ tasks: batch, close_missing: false }, { signal });
      if (!reply || typeof reply.source_id !== 'string' || !Array.isArray(reply.items) ||
          reply.items.length !== batch.length ||
          !['created', 'updated', 'unchanged'].every(key => Number.isSafeInteger(reply[key]) && reply[key] >= 0) ||
          (result.source_id !== null && result.source_id !== reply.source_id) ||
          new Set(reply.items.map(item => item.external_id)).size !== batch.length ||
          reply.items.some(item => !batchIDs.has(item.external_id))) {
        throw new Error('Plugin API returned an invalid task acknowledgement');
      }
      result.source_id = reply.source_id;
      result.created += reply.created;
      result.updated += reply.updated;
      result.unchanged += reply.unchanged;
      result.items.push(...reply.items);
    }
    return result;
  }

  async reportStatus(status, message = '', { signal } = {}) {
    if (typeof this.statusTransport !== 'function') throw new TypeError('status transport is unavailable');
    if (!['OK', 'BUSY', 'DEGRADED', 'ERROR', 'UNKNOWN'].includes(status) ||
        typeof message !== 'string' || message.length > 2000) throw new TypeError('invalid plugin status');
    return this.statusTransport({ status, message }, { signal });
  }

  async claimResourceJobs(options = {}) {
    if (typeof this.resourceTransport?.claim !== 'function') throw new TypeError('resource transport is unavailable');
    const result = await this.resourceTransport.claim({}, options);
    if (!result || !Array.isArray(result.jobs)) throw new Error('Invalid resource job response');
    return result.jobs;
  }

  async completeResourceJob(job, result, options = {}) {
    if (typeof this.resourceTransport?.complete !== 'function') throw new TypeError('resource transport is unavailable');
    if (!job || !['availability', 'get', 'search'].includes(job.operation) || !job.claim_id ||
        (job.operation === 'search' ? !job.search_id : !job.event_id || !job.reference)) {
      throw new TypeError('Invalid resource job');
    }
    if (!result || !['available', 'unavailable', 'auth_required', 'forbidden', 'not_found'].includes(result.status)) {
      throw new TypeError('Invalid resource result');
    }
    return this.resourceTransport.complete(job.operation === 'search'
      ? {search_id: job.search_id, claim_id: job.claim_id, ...result}
      : {event_id: job.event_id, reference: job.reference, claim_id: job.claim_id, ...result}, options);
  }

  async notifyResourcesAvailable(options = {}) {
    if (typeof this.resourceTransport?.notify !== 'function') throw new TypeError('resource transport is unavailable');
    return this.resourceTransport.notify({available: true}, options);
  }

  async runResourceWorker(provider, {signal, pollMilliseconds = 3000, probeMilliseconds = 30000} = {}) {
    if (typeof provider?.availability !== 'function' || typeof provider?.get !== 'function' ||
        !Number.isInteger(pollMilliseconds) || pollMilliseconds < 250 ||
        !Number.isInteger(probeMilliseconds) || probeMilliseconds < 1000) throw new TypeError('Invalid resource provider');
    let lastProbeAt = 0, wasAvailable = false;
    while (!signal?.aborted) {
      if (typeof provider.probe === 'function' && Date.now() - lastProbeAt >= probeMilliseconds) {
        lastProbeAt = Date.now();
        let available = false;
        try { available = Boolean(await provider.probe({signal})); } catch { /* Access can recover later. */ }
        if (available && !wasAvailable) await this.notifyResourcesAvailable({signal});
        wasAvailable = available;
      }
      const jobs = await this.claimResourceJobs({signal});
      for (const job of jobs) {
        if (signal?.aborted) break;
        let result;
        try {
          result = job.operation === 'availability'
            ? await provider.availability(job.reference, {resourceType: job.resource_type, signal})
            : job.operation === 'search'
              ? await provider.search(job.query, {signal})
              : await provider.get(job.reference, {resourceType: job.resource_type, signal});
          if (typeof result === 'string') result = {status: result};
          if (job.operation === 'search' && Array.isArray(result)) result = {status: 'available', results: result};
          if (job.operation === 'get' && result && !result.status) result = {status: 'available', resource: result};
        } catch (error) {
          result = {status: 'unavailable', detail: String(error?.message || error).slice(0, 1000)};
        }
        await this.completeResourceJob(job, result, {signal});
      }
      if (!jobs.length && !signal?.aborted) await new Promise(resolve => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, pollMilliseconds);
        signal?.addEventListener('abort', onAbort, {once: true});
      });
    }
  }
}

/** For trusted external processes and development. A hosted plugin uses the broker transport instead. */
export function createSignedTransport({ baseUrl, pluginId, secret, fetchImpl = globalThis.fetch,
  resource = 'conversations',
  now = () => Date.now(), nonce = () => randomBytes(24).toString('base64url'),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), maxAttempts = 3 }) {
  const origin = normalizeURL(baseUrl);
  if (!ID.test(pluginId)) throw new TypeError('invalid pluginId');
  if (!SECRET.test(secret)) throw new TypeError('invalid plugin secret');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new TypeError('invalid transport options');
  }
  const routes = {conversations: 'conversations:batch', tasks: 'tasks:batch', status: 'status',
    resourceClaim: 'resource-jobs:claim', resourceComplete: 'resource-jobs:complete',
    resourceAvailability: 'resource-availability'};
  if (!routes[resource]) throw new TypeError('invalid plugin resource');
  const path = `/api/v1/plugins/${pluginId}/${routes[resource]}`;
  return async (payload, { signal } = {}) => {
    const body = JSON.stringify(payload);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw signal.reason || new Error('Request aborted');
      const timestamp = String(Math.floor(now() / 1000));
      const requestNonce = nonce();
      const signature = signPluginRequest({ secret, timestamp, nonce: requestNonce, method: 'POST', path, body });
      let response;
      try {
        response = await fetchImpl(origin + path, {
          method: 'POST', body, signal,
          headers: { 'Content-Type': 'application/json', 'X-Plugin-Timestamp': timestamp,
            'X-Plugin-Nonce': requestNonce, 'X-Plugin-Signature': signature },
        });
      } catch (error) {
        if (attempt === maxAttempts || signal?.aborted) throw error;
        await sleep(250 * 2 ** (attempt - 1), signal);
        continue;
      }
      if (response.status === (resource === 'conversations' ? 202 : 200)) return response.json();
      const detail = await response.json().then(value => value?.detail).catch(() => '');
      const error = new PluginApiError(response.status, detail);
      if (!error.retryable || attempt === maxAttempts) throw error;
      await sleep(250 * 2 ** (attempt - 1), signal);
    }
  };
}

export function createResourceTransport(options) {
  return {
    claim: createSignedTransport({...options, resource: 'resourceClaim'}),
    complete: createSignedTransport({...options, resource: 'resourceComplete'}),
    notify: createSignedTransport({...options, resource: 'resourceAvailability'}),
  };
}

/** Plugin-side lifecycle declaration; the host owns the configuration UI. */
export function definePlugin({ id, isConfigured, configure, start, stop = async () => {} }) {
  if (!ID.test(id) || [isConfigured, configure, start, stop].some(fn => typeof fn !== 'function')) {
    throw new TypeError('plugin needs id, isConfigured, configure, start and stop');
  }
  return Object.freeze({ id, isConfigured, configure, start, stop });
}
