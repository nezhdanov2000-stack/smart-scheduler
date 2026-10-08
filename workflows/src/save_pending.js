// ── Save Pending ────────────────────────────────────────────────────────────
// Parks the pipeline context until the owner taps ✅ / ❌. Stored in the
// workflow's static data (lives in n8n's own SQLite database - no external DB).
const sd = $getWorkflowStaticData('global');
sd.pending = sd.pending || {};
sd.nextId = (sd.nextId || 0) + 1;
const id = sd.nextId;
const now = Date.now();
for (const [k, v] of Object.entries(sd.pending)) {          // keep the store small
  if (v.status !== 'pending' || now - v.created > 7 * 24 * 3600 * 1000) delete sd.pending[k];
}
sd.pending[id] = { created: now, status: 'pending', ctx: $input.first().json };
return [{ json: { id } }];
