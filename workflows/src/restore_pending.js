// ── Restore Pending ─────────────────────────────────────────────────────────
// The owner tapped ✅ or ❌. Reloads the saved pipeline context so the calendar
// nodes can run exactly as they would have without the confirmation step.
const cb = $('Prepare Input').first().json.callback;
const row = $input.first().json || {};
const expired = !row.ctx;
const ctx = expired ? {} : (typeof row.ctx === 'string' ? JSON.parse(row.ctx) : row.ctx);
const approved = !expired && cb.action === 'ok';
const statusLine = expired ? '⚠️ Already handled.' : approved ? '⏳ Adding…' : '❌ Skipped.';
return [{
  json: {
    ...ctx,
    config: ctx.config || $('Prepare Input').first().json.config,
    meta: ctx.meta || { reply_chat_id: cb.chat_id, chat_id: cb.chat_id, message_id: cb.message_id, received_at_ms: Date.now(), business: false },
    kind: 'callback', callback: cb, expired, approved,
    pending_id: cb.pending_id,
    edit_text: `${cb.message_text}\n\n${statusLine}`,
    answer_text: expired ? 'Already handled' : approved ? 'Adding to calendar…' : 'Skipped',
  },
}];
