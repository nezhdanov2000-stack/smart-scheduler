// ── Prepare Confirmation ────────────────────────────────────────────────────
// Builds the "Schedule this?" card that is sent to the owner with ✅ / ❌ buttons.
const ctx = $input.first().json;
const fmt = iso => iso ? DateTime.fromISO(String(iso).slice(0, 19)).toFormat("ccc d LLL, HH:mm") : '?';
const ent = ctx.stage2.entities;
const body = ctx.stage3.command.body || {};
const quote = ctx.text.length > 160 ? ctx.text.slice(0, 157) + '…' : ctx.text;
const who = ctx.meta.business ? `${ctx.meta.sender} in chat with ${ctx.meta.counterpart}` : ctx.meta.sender;
let card;
if (ctx.stage2.intent === 'modify') {
  card = `✏️ Move "${ctx.lookup.event_summary}"` + (body.start?.dateTime ? ` to ${fmt(body.start.dateTime)}` : '') + '?';
} else {
  card = `📅 Add to calendar?\n\n${body.summary || ent.event_title}\n🕒 ${fmt(body.start?.dateTime)} – ${fmt(body.end?.dateTime).split(', ')[1] || ''}` +
         (body.location ? `\n📍 ${body.location}` : '') +
         (ent.participants?.length ? `\n👥 ${ent.participants.join(', ')}` : '');
}
return [{ json: { ...ctx, ask_text: `💬 ${who}: "${quote}"\n\n${card}` } }];
