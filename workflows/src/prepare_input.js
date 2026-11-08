// ── Prepare Input ───────────────────────────────────────────────────────────
// Normalises the Telegram update, holds the workflow configuration and builds
// the Stage 1 request. Edit CONFIG to suit your deployment (no secrets here –
// API keys live in the n8n credential vault).
const CONFIG = {
  model: 'gpt-4o-mini',            // inference engine for all three stages
  timezone: 'Asia/Bangkok',        // IANA timezone used for "now" and for calendar events
  calendarId: 'primary',           // Google Calendar to write to
  placeholderEmailDomain: 'example.com', // attendees without a known e-mail
  maxStage3Retries: 2,             // prompt-adjusted retries after schema-validation failure
  sendConfirmation: true,          // reply in the Telegram chat after a calendar operation
  logMessageText: false,           // data minimisation: keep raw text out of the audit table
  allowedChatIds: [],              // e.g. [-1001234567890]; empty = accept every chat
};

const STAGE1_PROMPT = __STAGE1_PROMPT__;

const update = $input.first().json;
const msg = update.message || update.edited_message;
if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) return [];   // stickers, photos, joins…
if (msg.text.trim().startsWith('/')) return [];                             // bot commands
if (CONFIG.allowedChatIds.length && !CONFIG.allowedChatIds.includes(msg.chat.id)) return [];

const now = $now.setZone(CONFIG.timezone);
const nowIso = now.toFormat("yyyy-MM-dd'T'HH:mm:ss");
const sender = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'unknown';

return [{
  json: {
    config: CONFIG,
    meta: {
      received_at_ms: Date.now(),
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      sender,
      now: nowIso,
      weekday: now.toFormat('cccc'),
    },
    text: msg.text.trim(),
    request: {
      model: CONFIG.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STAGE1_PROMPT },
        { role: 'user', content: `Current date/time: ${nowIso} (${now.toFormat('cccc')}), timezone ${CONFIG.timezone}\nMessage: ${msg.text.trim()}` },
      ],
    },
  },
}];
