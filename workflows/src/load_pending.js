// ── Load Pending ────────────────────────────────────────────────────────────
// Claims the parked context for a button press (first press wins) and marks it
// approved / skipped. Returns {} when nothing is pending for that id.
const cb = $input.first().json.callback;
const sd = $getWorkflowStaticData('global');
const row = sd.pending?.[cb.pending_id];
if (!row || row.status !== 'pending') return [{ json: {} }];
row.status = cb.action === 'ok' ? 'approved' : 'skipped';
row.resolved = Date.now();
const ctx = row.ctx;
delete row.ctx;                                              // no longer needed once resolved
return [{ json: { id: cb.pending_id, ctx } }];
