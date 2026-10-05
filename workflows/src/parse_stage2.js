// ── Parse Stage 2 ───────────────────────────────────────────────────────────
// Checks that the intent is known and the required entities are present.
const ctx = $('Parse Stage 1').first().json;
const resp = $input.first().json;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/;

let stage2, errors = [];
try {
  stage2 = JSON.parse(resp.choices[0].message.content);
} catch (e) {
  stage2 = {}; errors.push('Stage 2 returned unparseable output');
}
const ent = stage2.entities || {};
if (!['create', 'modify', 'cancel'].includes(stage2.intent)) errors.push('unknown intent');
if (!ent.event_title || typeof ent.event_title !== 'string') errors.push('missing event_title');
if (stage2.intent !== 'cancel' && !ISO.test(ent.start_datetime || '')) errors.push('missing or malformed start_datetime');

// 60-minute default duration (belt and braces – the prompt already asks for it)
if (ISO.test(ent.start_datetime || '') && !ISO.test(ent.end_datetime || '')) {
  const end = DateTime.fromISO(ent.start_datetime.slice(0, 19)).plus({ minutes: 60 });
  ent.end_datetime = end.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}
if (!Array.isArray(ent.participants)) ent.participants = [];
stage2.entities = ent;
stage2.ok = errors.length === 0;
stage2.errors = errors;

return [{ json: { ...ctx, stage2, request: null } }];
