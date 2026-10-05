// ── Detect Conflict ─────────────────────────────────────────────────────────
// Runs before every POST (create) and PATCH (modify). Looks at the events that
// "Find Conflicts" fetched for the rest of that day and decides whether the
// requested slot overlaps an existing event. If it does, the calendar is left
// untouched and the user gets a warning plus the next free slot of the same
// length (same day, up to CONFIG.workdayEnd).
const ran = name => { try { return $(name).isExecuted; } catch (e) { return false; } };
const ctx = ran('Pick Event') ? $('Pick Event').first().json : $('Validate Command').first().json;
const resp = $input.first().json;
const tz = ctx.config.timezone;
const body = ctx.stage3.command.body || {};
const excludeId = ctx.lookup?.event_id || null;

const parse = v => v ? DateTime.fromISO(String(v), { zone: tz }) : null;
let start = parse(body.start?.dateTime);
let end = parse(body.end?.dateTime);
if (start && !end) end = start.plus({ minutes: 60 });

const out = { checked: false, conflict: false, conflicts: [], suggestion: null, policy: ctx.config.conflictPolicy || 'reject', error: null };
if (resp.error) out.error = resp.error.message || 'calendar lookup failed';

if (start && end && !resp.error && out.policy !== 'allow') {
  out.checked = true;
  const busy = [];
  for (const ev of resp.items || []) {
    if (ev.status === 'cancelled' || ev.transparency === 'transparent') continue;   // "free" events don't block
    if (excludeId && ev.id === excludeId) continue;                                 // the event being moved
    if (!ev.start?.dateTime || !ev.end?.dateTime) continue;                          // all-day events don't block
    const s = DateTime.fromISO(ev.start.dateTime), e = DateTime.fromISO(ev.end.dateTime);
    if (s.isValid && e.isValid) busy.push({ id: ev.id, summary: ev.summary || '(untitled)', start: s, end: e });
  }
  busy.sort((a, b) => a.start - b.start);
  out.conflicts = busy.filter(b => b.start < end && b.end > start).map(b => ({
    id: b.id, summary: b.summary,
    start: b.start.setZone(tz).toFormat("ccc d LLL, HH:mm"), end: b.end.setZone(tz).toFormat('HH:mm'),
  }));
  out.conflict = out.conflicts.length > 0;

  if (out.conflict) {
    // next gap of the same length, same day, before workdayEnd (default 21:00)
    const duration = end.diff(start);
    const dayEnd = start.set({ hour: ctx.config.workdayEnd ?? 21, minute: 0, second: 0 });
    let cand = start;
    for (let i = 0; i < 50 && cand.plus(duration) <= dayEnd; i++) {
      const hit = busy.find(b => b.start < cand.plus(duration) && b.end > cand);
      if (!hit) { out.suggestion = { start: cand.toFormat("yyyy-MM-dd'T'HH:mm:ss"), label: `${cand.toFormat('HH:mm')}–${cand.plus(duration).toFormat('HH:mm')}` }; break; }
      cand = hit.end.setZone(tz);
    }
  }
}
return [{ json: { ...ctx, slot: out } }];
