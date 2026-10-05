// ── Baseline: Prepare Input ─────────────────────────────────────────────────
const CONFIG = { model: 'gpt-4o-mini', timezone: 'Asia/Bangkok', calendarId: 'primary' };
const BASELINE_PROMPT = __BASELINE_PROMPT__;

const msg = $input.first().json.message;
if (!msg || typeof msg.text !== 'string' || !msg.text.trim() || msg.text.startsWith('/')) return [];
const now = $now.setZone(CONFIG.timezone);
const nowIso = now.toFormat("yyyy-MM-dd'T'HH:mm:ss");
return [{
  json: {
    config: CONFIG,
    text: msg.text.trim(),
    request: {
      model: CONFIG.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: BASELINE_PROMPT },
        { role: 'user', content: `Current date/time: ${nowIso} (${now.toFormat('cccc')}), timezone ${CONFIG.timezone}\nMessage: ${msg.text.trim()}` },
      ],
    },
  },
}];
