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
  // Telegram Business "Chatbots": messages from the owner's private chats arrive as
  // business_message. Confirmations for those are sent to the OWNER's private chat with the
  // bot (never to the other person). Set to your own chat id; empty = no confirmations for them.
  ownerChatId: 845660052,
  // Ask before writing to the calendar: 'business' = only for messages from your private chats
  // (Telegram Business), 'all' = always ask, 'none' = never ask. The question goes to ownerChatId.
  confirmBefore: 'business',
  conflictPolicy: 'reject',        // 'reject' = never double-book (warn + suggest next free slot); 'allow' = no check
  workdayEnd: 21,                  // hour (24h) after which no alternative slot is suggested
};

const STAGE1_PROMPT = __STAGE1_PROMPT__;

const update = $input.first().json;

// ✅ / ❌ button pressed on a confirmation card
if (update.callback_query) {
  const q = update.callback_query;
  const m = /^(ok|no):(\d+)$/.exec(q.data || '');
  if (!m) return [];
  return [{ json: { kind: 'callback', config: CONFIG, callback: {
    id: q.id, action: m[1], pending_id: Number(m[2]),
    chat_id: q.message?.chat?.id, message_id: q.message?.message_id, message_text: q.message?.text || '',
    from: q.from?.id } } }];
}

const msg = update.message || update.business_message;
if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) return [];   // stickers, photos, joins, edits…
if (msg.text.trim().startsWith('/')) return [];                             // bot commands
const business = !!msg.business_connection_id;
if (!business && CONFIG.allowedChatIds.length && !CONFIG.allowedChatIds.includes(msg.chat.id)) return [];
if (business && msg.from?.is_bot) return [];

const now = $now.setZone(CONFIG.timezone);
const nowIso = now.toFormat("yyyy-MM-dd'T'HH:mm:ss");
const sender = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'unknown';

return [{
  json: {
    kind: 'message',
    config: CONFIG,
    meta: {
      received_at_ms: Date.now(),
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      business,
      business_connection_id: msg.business_connection_id || null,
      // where confirmations go: the same chat for normal messages, the owner's chat for business ones
      reply_chat_id: business ? (CONFIG.ownerChatId || null) : msg.chat.id,
      reply_to: business ? null : msg.message_id,
      counterpart: business ? ([msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.title || String(msg.chat.id)) : null,
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
