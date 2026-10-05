// ── Pick Event ──────────────────────────────────────────────────────────────
// Chooses the existing calendar event that a modify/cancel message refers to,
// by title similarity and (when known) start-time proximity.
const ctx = $('Validate Command').first().json;
const resp = $input.first().json;
const target = ctx.stage3.command.target || {};
const STOP = new Set(['the', 'a', 'an', 'with', 'and', 'of', 'for', 'to', 'on', 'our', 'meeting', 'call']);
const tokens = s => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t)));

const want = tokens(target.summary);
const wantStart = target.start_datetime ? Date.parse(String(target.start_datetime).slice(0, 19)) : NaN;

let best = null, bestScore = 0;
for (const ev of resp.items || []) {
  if (ev.status === 'cancelled') continue;
  const have = tokens(ev.summary);
  const inter = [...want].filter(t => have.has(t)).length;
  const union = new Set([...want, ...have]).size || 1;
  let score = inter / union;
  const evStart = Date.parse(String(ev.start?.dateTime || ev.start?.date || '').slice(0, 19));
  if (!isNaN(wantStart) && !isNaN(evStart)) {
    const diffH = Math.abs(evStart - wantStart) / 3.6e6;
    if (diffH <= 1) score += 1; else if (diffH <= 24) score += 0.3;
  }
  if (score > bestScore) { bestScore = score; best = ev; }
}

const found = !!best && bestScore >= 0.3;
return [{
  json: {
    ...ctx,
    lookup: {
      found,
      score: Number(bestScore.toFixed(2)),
      event_id: found ? best.id : null,
      event_summary: found ? best.summary : null,
      error: resp.error ? (resp.error.message || 'calendar lookup failed') : null,
    },
  },
}];
