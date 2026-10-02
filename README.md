# AI Secretary plugin SDK for Node.js

This SDK sends conversation messages from a source plugin to AI Secretary. It validates and batches messages (up to 100 per request), signs HTTP requests with HMAC-SHA256, and retries temporary failures. It has no runtime dependencies or native modules. Node.js 24 or newer is required.

```sh
npm install @ai-secretary/plugin-sdk
```

```js
import { PluginClient, createSignedTransport } from '@ai-secretary/plugin-sdk';

const client = new PluginClient({
  transport: createSignedTransport({
    baseUrl: 'http://127.0.0.1:8000',
    pluginId: 'sample_chat',
    secret: process.env.SECRETARY_PLUGIN_SECRET,
  }),
});

await client.sendConversations([{
  external_id: 'message-42',
  thread_external_id: 'discussion-7',
  occurred_at: new Date(),
  body: 'Example conversation message',
  subject: 'Project discussion',
  author: 'colleague@example.test',
  participants: [{ name: 'Sample Colleague', address: 'colleague@example.test' }],
}]);
```

`external_id` identifies one message for idempotent import; `thread_external_id` groups messages into a conversation. The server determines the source from the plugin identity. `sendConversations` returns the source ID and counts of created, updated, and unchanged messages. Pass an `AbortSignal` as `{ signal }` to cancel a submission.

`createSignedTransport` is intended for a trusted external process or local development. Keep the plugin secret out of logs and distributable packages. For a host-managed plugin, pass the host's transport to `new PluginClient({ transport: hostTransport })`; that lets the host retain the signing key. A plugin can declare its `isConfigured`, `configure`, `start`, and `stop` lifecycle methods with `definePlugin`. See the [example plugin](examples/sample-plugin.mjs).

The [plugin API contract](https://github.com/mumg/ai_secretary/blob/main/backend/internal/contracts/plugin-openapi.json) defines the accepted fields and endpoints. The SDK does not install plugins, run them in a sandbox, or validate licenses. Consult the [plugin integration guide](https://github.com/mumg/ai_secretary/blob/main/docs/plugins.md) for current host capabilities.

## Русский

SDK передаёт сообщения переписки в AI Секретарь, проверяет данные, разбивает их на пакеты по 100, подписывает запросы HMAC-SHA256 и повторяет временно неудачные запросы. Для работы нужен Node.js 24 или новее. Внешних зависимостей и нативных модулей нет.

Секрет из регистрации плагина храните вне публикуемого пакета. `createSignedTransport` подходит для доверенного внешнего процесса и локальной разработки; при запуске через хост используйте переданный им транспорт, чтобы секрет подписи оставался у хоста. Полный контракт и текущее состояние запуска описаны в ссылках выше.
