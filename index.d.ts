export type Direction = 'INCOMING' | 'OUTGOING' | 'INTERNAL';
export interface Participant {
  name?: string;
  address?: string;
  role?: string;
}
export interface ConversationMessage {
  external_id: string;
  thread_external_id: string;
  body: string;
  occurred_at: string | Date;
  subject?: string;
  author?: string;
  direction?: Direction;
  source_url?: string;
  participants?: Participant[];
}
export interface BatchResult {
  source_id: string | null;
  created: number;
  updated: number;
  unchanged: number;
}
export interface TaskInput {
  external_id: string;
  title: string;
  description?: string;
  status?: 'NEEDS_CONFIRMATION' | 'NEW' | 'IN_PROGRESS' | 'POSSIBLY_COMPLETED' | 'COMPLETED' | 'CANCELLED';
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  due_at?: string | Date;
  source_url?: string;
  evidence?: string;
  occurred_at?: string | Date;
  source_updated_at?: string | Date;
}
export interface TaskBatchResult extends BatchResult {
  items: { external_id: string; task_id: string; action: 'created' | 'updated' | 'unchanged'; status: string; active: boolean }[];
}
export interface SendOptions { signal?: AbortSignal }
export type ResourceAvailability = 'available' | 'unavailable' | 'auth_required' | 'forbidden' | 'not_found';
export interface ResourceLink { relation: 'parent' | 'related' | 'references' | 'attachment'; reference: string }
export interface ExternalResource {
  type: 'task' | 'document'; title: string; content: string; url: string;
  version: string; updated_at: string; links?: ResourceLink[];
}
export interface ResourceJob {
  event_id?: string; reference?: string; resource_type?: 'task' | 'document';
  search_id?: string; query?: string; operation: 'availability' | 'get' | 'search'; claim_id: string;
}
export interface ResourceResult { status: ResourceAvailability; detail?: string; resource?: ExternalResource; results?: ExternalResource[] }
export interface ResourceProvider {
  probe?(options?: SendOptions): boolean | Promise<boolean>;
  availability(reference: string, options: {resourceType: 'task' | 'document'; signal?: AbortSignal}): ResourceAvailability | ResourceResult | Promise<ResourceAvailability | ResourceResult>;
  get(reference: string, options: {resourceType: 'task' | 'document'; signal?: AbortSignal}): ExternalResource | ResourceResult | Promise<ExternalResource | ResourceResult>;
  search?(query: string, options?: SendOptions): ExternalResource[] | ResourceResult | Promise<ExternalResource[] | ResourceResult>;
}
export interface ResourceTransport {
  claim(payload: object, options?: SendOptions): Promise<{jobs: ResourceJob[]}>;
  complete(payload: {event_id?: string; reference?: string; search_id?: string; claim_id: string} & ResourceResult, options?: SendOptions): Promise<{state: string}>;
  notify(payload: {available: true}, options?: SendOptions): Promise<{requeued: number}>;
}
export type PluginTransport = (
  payload: { messages: ConversationMessage[] }, options?: SendOptions
) => Promise<BatchResult>;
export type TaskTransport = (
  payload: { tasks: TaskInput[]; close_missing: false }, options?: SendOptions
) => Promise<TaskBatchResult>;
export type StatusTransport = (
  payload: { status: 'OK' | 'BUSY' | 'DEGRADED' | 'ERROR' | 'UNKNOWN'; message: string }, options?: SendOptions
) => Promise<unknown>;

export declare function signPluginRequest(input: {
  secret: string;
  timestamp: string | number;
  nonce: string;
  method: string;
  path: string;
  body: string | Uint8Array;
}): string;

export declare class PluginApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, detail?: string);
}

export declare class PluginClient {
  constructor(options: { transport?: PluginTransport; taskTransport?: TaskTransport; statusTransport?: StatusTransport; resourceTransport?: ResourceTransport });
  sendConversations(messages: ConversationMessage[], options?: SendOptions): Promise<BatchResult>;
  sendTasks(tasks: TaskInput[], options?: SendOptions): Promise<TaskBatchResult>;
  reportStatus(status: 'OK' | 'BUSY' | 'DEGRADED' | 'ERROR' | 'UNKNOWN', message?: string, options?: SendOptions): Promise<unknown>;
  claimResourceJobs(options?: SendOptions): Promise<ResourceJob[]>;
  completeResourceJob(job: ResourceJob, result: ResourceResult, options?: SendOptions): Promise<{state: string}>;
  notifyResourcesAvailable(options?: SendOptions): Promise<{requeued: number}>;
  runResourceWorker(provider: ResourceProvider, options?: {signal?: AbortSignal; pollMilliseconds?: number; probeMilliseconds?: number}): Promise<void>;
}

export interface SignedTransportOptions {
  baseUrl: string;
  pluginId: string;
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxAttempts?: number;
}

export declare function createSignedTransport(options: SignedTransportOptions & {resource?: 'conversations'}): PluginTransport;
export declare function createSignedTransport(options: SignedTransportOptions & {resource: 'tasks'}): TaskTransport;
export declare function createSignedTransport(options: SignedTransportOptions & {resource: 'status'}): StatusTransport;
export declare function createSignedTransport(options: SignedTransportOptions & {resource: 'resourceClaim'}): ResourceTransport['claim'];
export declare function createSignedTransport(options: SignedTransportOptions & {resource: 'resourceComplete'}): ResourceTransport['complete'];
export declare function createSignedTransport(options: SignedTransportOptions & {resource: 'resourceAvailability'}): ResourceTransport['notify'];

export declare function createResourceTransport(options: SignedTransportOptions): ResourceTransport;

export interface PluginDefinition<Settings = unknown> {
  id: string;
  isConfigured(settings: Settings): boolean | Promise<boolean>;
  configure(context: {
    settings: Settings;
    onSuccess(): void;
    onError(error: Error): void;
  }): void | Promise<void>;
  start(context: { client: PluginClient; settings: Settings; signal: AbortSignal }): void | Promise<void>;
  stop(): void | Promise<void>;
}

export declare function definePlugin<Settings = unknown>(
  definition: PluginDefinition<Settings>
): Readonly<PluginDefinition<Settings>>;
