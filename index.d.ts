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
export interface SendOptions { signal?: AbortSignal }
export type PluginTransport = (
  payload: { messages: ConversationMessage[] }, options?: SendOptions
) => Promise<BatchResult>;

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
  constructor(options: { transport: PluginTransport });
  sendConversations(messages: ConversationMessage[], options?: SendOptions): Promise<BatchResult>;
}

export declare function createSignedTransport(options: {
  baseUrl: string;
  pluginId: string;
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxAttempts?: number;
}): PluginTransport;

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
