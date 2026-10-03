# Интерфейс Node.js SDK плагинов AI Secretary

Пакет `@ai-secretary/plugin-sdk` предоставляет функции для отправки переписок и задач, публикации состояния источника и чтения связанных внешних ресурсов. Он работает в Node.js 24+ без нативных модулей и зависимостей времени выполнения. Экспортированы `PluginClient`, `PluginApiError`, `createSignedTransport`, `createResourceTransport`, `signPluginRequest`, `definePlugin` и типы TypeScript из `index.d.ts`.

Это клиентский SDK. Установка пакета плагина, выдача полномочий и настройка пользователя выполняются приложением. Подписанный [OpenAPI-контракт](https://github.com/mumg/ai_secretary/blob/main/backend/internal/contracts/plugin-openapi.json) определяет HTTP-поля и ответы сервера.

## Подключение

```js
import { PluginClient, createSignedTransport, createResourceTransport } from '@ai-secretary/plugin-sdk';

const connection = {
  baseUrl: process.env.SECRETARY_PLUGIN_BASE_URL,
  pluginId: process.env.SECRETARY_PLUGIN_ID,
  secret: process.env.SECRETARY_PLUGIN_SECRET,
};

const client = new PluginClient({
  transport: createSignedTransport(connection),
  taskTransport: createSignedTransport({ ...connection, resource: 'tasks' }),
  statusTransport: createSignedTransport({ ...connection, resource: 'status' }),
  resourceTransport: createResourceTransport(connection),
});
```

Укажите только нужные транспорты. Конструктору необходим хотя бы один из них. Для установленного плагина приложение передаёт три показанные переменные окружения и путь `SECRETARY_PLUGIN_CONFIG_FILE` к JSON с настройками. Секрет подписи не включайте в пакет и не записывайте в журналы. Настольный сервер запускает точку входа пакета как отдельный процесс Node.js; SDK не запускает её автоматически.

`baseUrl` — ровно HTTP(S)-origin без пути, параметров, фрагмента и учётных данных. Обычный HTTP допустим только для localhost; удалённое подключение требует HTTPS. `pluginId` совпадает с `id` установленного плагина, `secret` — 64 строчных шестнадцатеричных символа.

### Манифест пакета и полномочия

В `manifest.json` объявляют нужные полномочия:

| Полномочие | Возможность SDK |
| --- | --- |
| `conversations.write` | `sendConversations` |
| `tasks.write` | `sendTasks`, `reportStatus` |
| `resources.read` | задания `availability`, `get`, необязательный `search` |
| `auth.interactive` | сценарии входа `auth_flows` в настольном приложении; отдельного метода SDK нет |

Пакет указывает `api_version: "0.1.0"`, `runtime: "nodejs"`, точку входа и контрольные суммы файлов. Это версия контракта плагина, а не версия npm-пакета. Установленный плагин действует только в пределах выданных ему полномочий и своего источника. Подробнее о структуре архива, настройках и SSO: [руководство по плагинам](https://github.com/mumg/ai_secretary/blob/main/docs/plugins.md).

## `PluginClient`

Все методы принимают необязательное `{ signal: AbortSignal }`. Отмена останавливает запрос на стороне клиента. Методы возвращают `Promise`; ошибка проверки входных данных возникает до отправки HTTP-запроса.

### `sendConversations(messages, { signal }?)`

Отправляет сообщения пакетами до 100 элементов. `external_id` должен быть уникален в одном вызове; повторная отправка того же ID в источник идемпотентна. `thread_external_id` группирует сообщения в переписку. Источник определяется по подписи плагина, передавать `source_id` нельзя.

| Поле `ConversationMessage` | Тип | Назначение |
| --- | --- | --- |
| `external_id` ** | string, до 512 | Стабильный ID сообщения в исходной системе |
| `thread_external_id` ** | string, до 512 | Стабильный ID цепочки |
| `body` ** | непустая строка, до 8 МиБ | Текст сообщения |
| `occurred_at` ** | ISO date-time или `Date` | Время сообщения |
| `subject` | string, до 2000 | Тема |
| `author` | string, до 512 | Автор |
| `direction` | `INCOMING`, `OUTGOING`, `INTERNAL` | Направление |
| `source_url` | string, до 4000 | Ссылка на оригинал |
| `participants` | `{ name?, address?, role? }[]` | Участники; значения — строки |

** Обязательное поле. Неизвестные поля отклоняются. `Date` преобразуется в ISO-строку. Метод возвращает `{ source_id, created, updated, unchanged }` — суммы ответов всех пакетов. Для пустого массива запрос не выполняется, `source_id` равен `null`, счётчики — нулю.

```js
await client.sendConversations([{
  external_id: 'mail-42', thread_external_id: 'thread-7',
  occurred_at: new Date(), direction: 'INCOMING',
  subject: 'Обсуждение требований', body: 'Текст письма',
  author: 'colleague@example.test',
  participants: [{ name: 'Коллега', address: 'colleague@example.test' }],
}]);
```

### `sendTasks(tasks, { signal }?)`

Отправляет задачи пакетами до 500 элементов с `close_missing: false`. `external_id` уникален в пределах вызова. Повторный импорт существующей задачи сохраняет её пользовательское состояние и не открывает завершённую задачу заново.

| Поле `TaskInput` | Тип | Назначение |
| --- | --- | --- |
| `external_id` ** | string, до 512 | Стабильный ID внешней задачи |
| `title` ** | string, до 500 | Заголовок |
| `description` | string, до 20 000 | Описание |
| `status` | `NEEDS_CONFIRMATION`, `NEW`, `IN_PROGRESS`, `POSSIBLY_COMPLETED`, `COMPLETED`, `CANCELLED` | Состояние источника |
| `priority` | `LOW`, `NORMAL`, `HIGH`, `CRITICAL` | Приоритет |
| `due_at`, `occurred_at`, `source_updated_at` | дата/время или `Date` | Срок, создание и изменение в источнике |
| `source_url` | string, до 4000 | Ссылка на задачу; может запустить получение контекста через плагин ресурсов |
| `evidence` | string, до 2000 | Основание назначения |

** Обязательное поле. Метод возвращает `{ source_id, created, updated, unchanged, items }`. Каждый элемент `items` содержит `{ external_id, task_id, action, status, active }`, где `action` — `created`, `updated` или `unchanged`. Результаты сохраняют порядок пакетных ответов. Для пустого массива `source_id` равен `null`, `items` пуст.

### `reportStatus(status, message = '', { signal }?)`

Показывает состояние плагина в компонентах приложения. `status`: `OK`, `BUSY`, `DEGRADED`, `ERROR` или `UNKNOWN`; сообщение — строка до 2000 символов. Метод возвращает ответ сервера.

```js
await client.reportStatus('BUSY', 'Загрузка задач');
```

## Внешние ресурсы

Плагин объявляет до 16 `resource_rules` и полномочие `resources.read`. Правило задаёт буквальный префикс идентификатора или HTTPS-URL, `type: "task" | "document"` и `operations: ["availability", "get"]` с необязательным `"search"`. Префикс URL должен включать путь. Пересекающиеся правила разных плагинов требуют подтверждения владельца при включении.

```json
{
  "permissions": ["resources.read"],
  "resource_rules": [
    {"prefix": "ABC-", "type": "task", "operations": ["availability", "get", "search"]},
    {"prefix": "https://wiki.example.test/docs/", "type": "document", "operations": ["availability", "get"]}
  ]
}
```

### `runResourceWorker(provider, { signal, pollMilliseconds = 3000, probeMilliseconds = 30000 }?)`

Опрос очереди и выполнение заданий. Интервалы измеряются в миллисекундах; минимум — 250 и 1000 соответственно. Метод завершается при отмене `signal`. Ошибка связи при получении/завершении задания выходит наружу после попыток транспорта, поэтому процесс плагина должен управлять собственным повторным запуском.

`provider.availability(reference, { resourceType, signal })` вызывается первым. Только статус `available` позволяет ядру поставить `get`. `provider.get(reference, { resourceType, signal })` возвращает ресурс либо `{ status, resource?, detail? }`. Если объявлен `search`, реализуйте также `provider.search(query, { signal })`: он возвращает массив ресурсов или `{ status, results?, detail? }`. `provider.probe({ signal })` необязателен: при переходе с недоступного состояния к доступному worker сообщает серверу о восстановлении. Начальная успешная проверка тоже посылает сигнал. Если плагин сам обнаружил восстановление, он может вызвать `notifyResourcesAvailable()` напрямую.

Статусы провайдера: `available`, `unavailable` (например, VPN выключен), `auth_required` (нужен повторный вход), `forbidden` (нет прав), `not_found` (неверная ссылка). При `unavailable` и `auth_required` сервер сохраняет работу в ожидании и не опрашивает недоступный ресурс постоянно. Исключение любого обработчика задания worker преобразует в `unavailable`; возвращайте `forbidden` и `not_found` явно. Детали ошибки ограничены 1000 символами.

`ExternalResource` содержит:

| Поле | Тип | Условие |
| --- | --- | --- |
| `type` | `task` или `document` | Совпадает с ожидаемым типом |
| `title` | непустая строка, до 500 | Заголовок |
| `content` | непустая строка, до 65 536 | Текст для анализа |
| `url` | HTTPS-URL, до 2048 | Оригинал |
| `version` | непустая строка, до 256 | Версия для проверки актуальности |
| `updated_at` | дата/время | Изменение в источнике |
| `links` | до 20 связей | `{ relation, reference }`; relation: `parent`, `related`, `references`, `attachment` |

Сервер ограничивает обход прямых связей двумя переходами и двенадцатью ресурсами на событие. Поиск запускается отдельно администратором и не заменяет прямо связанные материалы. Плагин должен применять права учётной записи пользователя во внешней системе: `resources.read` разрешает вызов API секретаря, но не предоставляет доступ к трекеру или wiki.

```js
const controller = new AbortController();
// vpnConnected() и tracker.get() реализует конкретный плагин.
await client.runResourceWorker({
  async availability(reference) {
    return vpnConnected() ? 'available' : 'unavailable';
  },
  async get(reference) {
    const item = await tracker.get(reference);
    if (!item) return { status: 'not_found' };
    return {
      type: 'task', title: item.title, content: item.description,
      url: item.url, version: item.revision, updated_at: item.updatedAt,
      links: item.parentId ? [{ relation: 'parent', reference: item.parentId }] : [],
    };
  },
  async probe() { return vpnConnected(); },
}, { signal: controller.signal });
```

`claimResourceJobs({ signal }?)` возвращает массив заданий с `claim_id` и операцией `availability`, `get` или `search`. `completeResourceJob(job, result, { signal }?)` подтверждает задание; `job` должен быть получен из `claimResourceJobs`. Для `availability`/`get` есть `event_id`, `reference`, `resource_type`; для поиска — `search_id`, `query`. Ответ содержит состояние серверной работы. Аренда задания — две минуты; просроченное задание может быть выдано повторно. `notifyResourcesAvailable({ signal }?)` возвращает `{ requeued }`. Обычно достаточно `runResourceWorker`, низкоуровневые методы нужны для собственного цикла обработки.

## Транспорт и подпись

`createSignedTransport({ baseUrl, pluginId, secret, resource?, fetchImpl?, now?, nonce?, sleep?, maxAttempts? })` создаёт подписанный POST-транспорт. `resource` выбирает `conversations` (по умолчанию), `tasks`, `status`, `resourceClaim`, `resourceComplete` или `resourceAvailability`. `createResourceTransport(options)` собирает три транспорта для заданий ресурсов. `fetchImpl`, `now`, `nonce` и `sleep` полезны в тестах; `maxAttempts` — целое от 1 до 5, по умолчанию 3. Повторяются сетевые ошибки и HTTP 429, 502, 503, 504 с задержкой 250, 500 мс и далее с удвоением. Для 4xx, кроме 429, повторов нет. Каждый повтор получает новый timestamp и nonce.

`signPluginRequest({ secret, timestamp, nonce, method, path, body })` возвращает HMAC-SHA256 в нижнем hex-регистре. Каноническая строка состоит из Unix-времени в секундах, nonce, метода, точного escaped path и SHA-256 **исходных байтов тела**, разделённых `\n`. Временная метка и nonce передаются заголовками `X-Plugin-Timestamp`, `X-Plugin-Nonce`, подпись — `X-Plugin-Signature`. Подписывайте именно отправляемый JSON. Встроенный транспорт делает это сам.

`PluginApiError` содержит `status`, `message` из `detail` ответа и `retryable`. После исчерпания повторов транспорт выбрасывает эту ошибку. Ошибки локальной проверки полей — `TypeError`; некорректный ответ сервера — `Error`.

## Декларация жизненного цикла

`definePlugin({ id, isConfigured, configure, start, stop? })` проверяет наличие функций и возвращает замороженный объект. Это способ объявить интерфейс в коде плагина, **не автоматический загрузчик**: текущий host исполняет файл `entrypoint`, а плагин сам читает настройки, создаёт клиент и вызывает свои обработчики. `stop` по умолчанию — пустая асинхронная функция.

```ts
interface PluginDefinition<Settings> {
  id: string;
  isConfigured(settings: Settings): boolean | Promise<boolean>;
  configure(context: {
    settings: Settings;
    onSuccess(): void;
    onError(error: Error): void;
  }): void | Promise<void>;
  start(context: {
    client: PluginClient;
    settings: Settings;
    signal: AbortSignal;
  }): void | Promise<void>;
  stop(): void | Promise<void>;
}
```

Настройки задаются `settings_fields` манифеста и сохраняются приложением; `isConfigured` и `configure` выполняются кодом плагина. Лицензирование платного плагина также остаётся его собственной логикой и настройками, SDK ключи лицензий не проверяет.
