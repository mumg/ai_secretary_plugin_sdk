# AI Secretary plugin SDK for Node.js

**[Подробный справочник API на русском](docs/API.ru.md)** · [Plugin HTTP contract](https://github.com/mumg/ai_secretary/blob/main/backend/internal/contracts/plugin-openapi.json)

This SDK sends conversation messages and external tasks from a source plugin to AI Secretary. It validates and batches records (100 messages or 500 tasks per request), signs HTTP requests with HMAC-SHA256, and retries temporary failures. It has no runtime dependencies or native modules. Node.js 24 or newer is required.

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

For task plugins, create a transport with `resource: 'tasks'`, pass it as `taskTransport`, and call `client.sendTasks([{ external_id: 'item-42', title: 'Review the sample request', status: 'NEW', priority: 'HIGH' }])`. Task imports are create-only: repeating an external ID never reopens an existing task. A transport with `resource: 'status'` supports `client.reportStatus('BUSY', 'Loading')`; the host shows this as a plugin component. A package can adopt a pre-existing external task source by declaring `adopt_source_id` in its manifest. This requires an explicit administrator upload and `tasks.write` permission.

To supply linked task or document context, declare `resources.read` and `resource_rules` in the package manifest. Each rule has a literal `prefix`, `type` (`task` or `document`), and `operations` (`availability`, `get`, optionally `search`). Create `resourceTransport` with `createResourceTransport({baseUrl, pluginId, secret})` and run `client.runResourceWorker(provider, {signal})`. The provider implements `availability(reference)`, `get(reference)`, optional `search(query)` and `probe()`. `get` returns `{type,title,content,url,version,updated_at,links}`; each link has a `reference` and a relation (`parent`, `related`, `references`, or `attachment`). Return `{status:'auth_required'}` when login is needed, `{status:'unavailable'}` when the network is down, `{status:'forbidden'}` for access denial, or `{status:'not_found'}` for a bad reference. `probe` detects recovery and wakes waiting work automatically. The plugin must enforce the configured user's external-system access rights. Search is explicitly requested by an administrator and its results do not replace directly linked documents.

`createSignedTransport` uses the plugin identity supplied by the host at runtime. Keep the plugin secret out of logs and distributable packages. A host-managed Node.js plugin receives `SECRETARY_PLUGIN_BASE_URL`, `SECRETARY_PLUGIN_ID`, `SECRETARY_PLUGIN_SECRET`, and `SECRETARY_PLUGIN_CONFIG_FILE` in its environment. `definePlugin` declares `isConfigured`, `configure`, `start`, and `stop` callbacks, but the host does not invoke them automatically: the plugin entrypoint runs its own lifecycle. See the [API reference](docs/API.ru.md) and the [declaration example](examples/sample-plugin.mjs).

The [plugin API contract](https://github.com/mumg/ai_secretary/blob/main/backend/internal/contracts/plugin-openapi.json) defines the accepted fields and endpoints. The SDK does not install plugins, run them in a sandbox, or validate licenses. Consult the [plugin integration guide](https://github.com/mumg/ai_secretary/blob/main/docs/plugins.md) for current host capabilities.

## Русский

SDK передаёт сообщения переписки в AI Секретарь, проверяет данные, разбивает их на пакеты по 100, подписывает запросы HMAC-SHA256 и повторяет временно неудачные запросы. Для работы нужен Node.js 24 или новее. Внешних зависимостей и нативных модулей нет.

Секрет из регистрации плагина храните вне публикуемого пакета. При запуске через приложение используйте переменные окружения, выданные процессу плагина; `definePlugin` сам по себе не запускает обработчики. Полное описание методов, типов, ошибок и жизненного цикла — в [справочнике API](docs/API.ru.md).
