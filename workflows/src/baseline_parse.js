// ── Baseline: Parse Output ──────────────────────────────────────────────────
const ctx = $('Prepare Input').first().json;
let out = {};
try { out = JSON.parse($input.first().json.choices[0].message.content); } catch (e) { out = { parse_error: true }; }
const ok = out.is_scheduling === true && out.intent === 'create' && out.api_command && typeof out.api_command === 'object';
return [{ json: { config: ctx.config, ...out, ok } }];
