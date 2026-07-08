// Outbound notifications: POST a JSON message to the configured webhook.
// The body carries a Discord-compatible `content` field (generic receivers get
// the same JSON and can key off it — e.g. to trigger a Komga/Kavita scan after
// imports). Fire-and-forget: a dead webhook must never break an import.
import config from './config.js';

export async function sendNotification(text, { fetchImpl = fetch } = {}) {
  const url = String(config.notifyWebhookUrl || '').trim();
  if (!url) return false;
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: String(text), source: 'backissue' }),
    });
    return true;
  } catch (e) {
    console.warn('notification webhook failed:', e?.message || e);
    return false;
  }
}
