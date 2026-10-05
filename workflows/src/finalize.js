// ── Finalize ────────────────────────────────────────────────────────────────
// Every branch ends here. Works out what happened, builds the Telegram reply
// (if any) and the audit record.
const ran = name => { try { return $(name).isExecuted; } catch (e) { return false; } };
const last = name => $(name).first().json;
const input = $input.first().json;

let ctx, status, result = null;
if (ran('Create Event') || ran('Patch Event') || ran('Delete Event')) {
  ctx = ran('Restore Pending') ? last('Restore Pending') : ran('Pick Event') ? last('Pick Event') : last('Validate Command');
  result = input;
  if (input.error) status = 'calendar_error';
  else status = ran('Create Event') ? 'created' : ran('Patch Event') ? 'modified' : 'cancelled';
} else if (ran('Ask Owner')) {
  ctx = last('Prepare Confirmation'); status = 'pending';          // waiting for ✅ / ❌
} else if (ran('Restore Pending')) {
  ctx = last('Restore Pending'); status = ctx.expired ? 'expired' : 'skipped';
} else if (ran('Detect Conflict')) {
  ctx = last('Detect Conflict'); status = ctx.slot.error ? 'calendar_error' : 'conflict';
} else if (ran('Pick Event')) {
  ctx = last('Pick Event'); status = 'event_not_found';
} else if (ran('Validate Command')) {
  ctx = last('Validate Command'); status = 'invalid_command';
} else if (ran('Parse Stage 2')) {
  ctx = last('Parse Stage 2'); status = 'entity_failed';
} else {
  ctx = last('Parse Stage 1'); status = 'discarded';
}

const fmt = iso => iso ? DateTime.fromISO(String(iso).slice(0, 19)).toFormat("ccc d LLL yyyy, HH:mm") : '';
const ent = ctx.stage2?.entities || {};
const body = ctx.stage3?.command?.body || {};
let reply = null;
switch (status) {
  case 'created':
    reply = `✅ Added to calendar: ${body.summary}\n🕒 ${fmt(body.start?.dateTime)} – ${fmt(body.end?.dateTime).split(', ')[1]}` +
            (body.location ? `\n📍 ${body.location}` : '') +
            (ent.participants?.length ? `\n👥 ${ent.participants.join(', ')}` : '') +
            (result?.htmlLink ? `\n${result.htmlLink}` : '');
    break;
  case 'modified':
    reply = `✏️ Updated: ${ctx.lookup.event_summary}` + (body.start?.dateTime ? `\n🕒 now ${fmt(body.start.dateTime)}` : '');
    break;
  case 'cancelled':
    reply = `🗑️ Cancelled: ${ctx.lookup.event_summary}`;
    break;
  case 'conflict': {
    const c = ctx.slot.conflicts[0];
    const verb = ctx.stage2.intent === 'modify' ? 'Not moved' : 'Not added';
    reply = `⚠️ ${verb} — that slot is already taken by "${c.summary}" (${c.start}–${c.end})` +
            (ctx.slot.conflicts.length > 1 ? ` and ${ctx.slot.conflicts.length - 1} more` : '') + '.' +
            (ctx.slot.suggestion ? `\n💡 Next free slot that day: ${ctx.slot.suggestion.label}.` : '') +
            `\nSend a different time and I'll schedule "${ent.event_title}".`;
    break;
  }
  case 'event_not_found':
    reply = `⚠️ I couldn't find a calendar event matching "${ctx.stage3.command.target?.summary}". Nothing was changed.`;
    break;
  case 'invalid_command':
  case 'calendar_error':
    reply = `⚠️ I understood this as a scheduling request ("${ent.event_title || '?'}") but couldn't write it to the calendar. Please add it manually.`;
    break;
  // 'discarded', 'entity_failed', 'pending', 'skipped', 'expired' stay silent (the card already says it)
}
if (!ctx.config.sendConfirmation || !ctx.meta.reply_chat_id) reply = null;
if (ctx.kind === 'callback' && status !== 'created' && status !== 'modified' && status !== 'calendar_error') reply = null;
if (reply && ctx.meta.business) {
  const quote = ctx.text.length > 120 ? ctx.text.slice(0, 117) + '…' : ctx.text;
  reply = `💬 ${ctx.meta.sender} in chat with ${ctx.meta.counterpart}: "${quote}"\n\n` + reply;
}

const payload = {
  stage1: ctx.stage1 || null,
  stage2: ctx.stage2 || null,
  stage3: ctx.stage3 ? { attempt: ctx.stage3.attempt, valid: ctx.stage3.valid, errors: ctx.stage3.errors, command: ctx.stage3.command } : null,
  lookup: ctx.lookup || null,
  slot: ctx.slot || null,
  pending_id: ctx.pending_id || null,
  calendar_event_id: result?.id || ctx.lookup?.event_id || null,
  calendar_error: result?.error ? (result.error.message || String(result.error)) : null,
};
if (ctx.config.logMessageText) payload.text = ctx.text;
else if (payload.stage1) { payload.stage1 = { ...payload.stage1 }; delete payload.stage1.normalised_message; }

return [{
  json: {
    chat_id: String(ctx.meta.chat_id),
    message_id: String(ctx.meta.message_id),
    reply_chat_id: ctx.meta.reply_chat_id ? String(ctx.meta.reply_chat_id) : null,
    reply_to: ctx.meta.reply_to || null,
    status,
    intent: ctx.stage2?.intent || null,
    latency_ms: Date.now() - ctx.meta.received_at_ms,
    stage3_attempts: ctx.stage3?.attempt || 0,
    has_reply: !!reply,
    reply,
    payload,
  },
}];
