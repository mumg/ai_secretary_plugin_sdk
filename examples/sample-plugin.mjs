import { definePlugin } from '../index.mjs';

const isConfigured = settings => typeof settings?.channel === 'string' && settings.channel.length > 0;

export default definePlugin({
  id: 'sample_chat',
  isConfigured,
  async configure({ settings, onSuccess, onError }) {
    if (isConfigured(settings)) onSuccess();
    else onError(new Error('Укажите канал источника'));
  },
  async start({ client, settings, signal }) {
    if (signal.aborted) return;
    await client.sendConversations([{
      external_id: 'sample-event-1',
      thread_external_id: settings.channel,
      occurred_at: new Date(),
      body: 'Пример сообщения из плагина.',
    }], { signal });
  },
  async stop() {},
});
