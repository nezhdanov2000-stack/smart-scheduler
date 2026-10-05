// ── Validate Command ────────────────────────────────────────────────────────
// Schema validation of the Stage 3 output against the Google Calendar Events
// API v3 subset defined in schema/calendar_command.schema.json (kept in sync by
// hand because the n8n Code node cannot load external libraries by default).
const ctx = $('Build Stage 3 Request').first().json;
const resp = $input.first().json;

const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const TZ = /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EVENT_KEYS = ['summary', 'description', 'location', 'start', 'end', 'attendees', 'reminders'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkDateTime(v, path, errors) {
  if (!isObj(v)) return errors.push(`${path} must be an object {dateTime, timeZone}`);
  for (const k of Object.keys(v)) if (!['dateTime', 'timeZone'].includes(k)) errors.push(`${path}.${k} is not allowed`);
  if (typeof v.dateTime !== 'string' || !DT.test(v.dateTime) || isNaN(Date.parse(v.dateTime.slice(0, 19))))
    errors.push(`${path}.dateTime must be ISO 8601 (YYYY-MM-DDTHH:MM:SS)`);
  if (typeof v.timeZone !== 'string' || !TZ.test(v.timeZone)) errors.push(`${path}.timeZone must be an IANA timezone`);
}

function checkEvent(body, requireCore, errors) {
  if (!isObj(body)) return errors.push('body must be an object');
  for (const k of Object.keys(body)) if (!EVENT_KEYS.includes(k)) errors.push(`body.${k} is not a supported Calendar API field`);
  if (requireCore) for (const k of ['summary', 'start', 'end']) if (!(k in body)) errors.push(`body.${k} is required`);
  if (!requireCore && Object.keys(body).length === 0) errors.push('PATCH body must contain at least one field');
  if ('summary' in body && (typeof body.summary !== 'string' || !body.summary.trim())) errors.push('body.summary must be a non-empty string');
  if ('description' in body && typeof body.description !== 'string') errors.push('body.description must be a string');
  if ('location' in body && (typeof body.location !== 'string' || !body.location.trim())) errors.push('body.location must be a non-empty string (omit it if unknown)');
  if ('start' in body) checkDateTime(body.start, 'body.start', errors);
  if ('end' in body) checkDateTime(body.end, 'body.end', errors);
  if (body.start?.dateTime && body.end?.dateTime && !errors.length &&
      Date.parse(body.end.dateTime.slice(0, 19)) <= Date.parse(body.start.dateTime.slice(0, 19)))
    errors.push('body.end must be after body.start');
  if ('attendees' in body) {
    if (!Array.isArray(body.attendees)) errors.push('body.attendees must be an array');
    else body.attendees.forEach((a, i) => {
      if (!isObj(a) || typeof a.email !== 'string' || !EMAIL.test(a.email)) errors.push(`body.attendees[${i}].email must be a valid e-mail`);
      else for (const k of Object.keys(a)) if (!['email', 'displayName', 'optional'].includes(k)) errors.push(`body.attendees[${i}].${k} is not allowed`);
    });
  }
}

function validateCommand(cmd, intent) {
  const errors = [];
  if (!isObj(cmd)) return ['output must be a JSON object'];
  for (const k of Object.keys(cmd)) if (!['method', 'body', 'target'].includes(k)) errors.push(`top-level field "${k}" is not allowed`);
  const expected = { create: 'POST', modify: 'PATCH', cancel: 'DELETE' }[intent];
  if (!['POST', 'PATCH', 'DELETE'].includes(cmd.method)) errors.push('method must be POST, PATCH or DELETE');
  else if (expected && cmd.method !== expected) errors.push(`method must be ${expected} for intent "${intent}"`);
  if (cmd.method === 'POST') checkEvent(cmd.body, true, errors);
  if (cmd.method === 'PATCH') checkEvent(cmd.body, false, errors);
  if (cmd.method === 'DELETE' && cmd.body != null) errors.push('body must be null for DELETE');
  if (cmd.target != null) {
    if (!isObj(cmd.target)) errors.push('target must be an object or null');
    else if ('summary' in cmd.target && typeof cmd.target.summary !== 'string') errors.push('target.summary must be a string');
  }
  return errors;
}

let raw = '', command = null, errors = [];
try {
  raw = resp.choices[0].message.content;
  command = JSON.parse(raw);
  // tolerate a bare Events body for "create" by wrapping it in the envelope
  if (isObj(command) && !('method' in command) && ('summary' in command || 'start' in command))
    command = { method: 'POST', body: command, target: null };
  errors = validateCommand(command, ctx.stage2.intent);
} catch (e) {
  errors = ['output is not parseable JSON'];
}

// PATCH/DELETE need something to look the event up by
if (!errors.length && command.method !== 'POST') {
  command.target = {
    summary: command.target?.summary || ctx.stage2.entities.event_title,
    start_datetime: command.target?.start_datetime ?? (ctx.stage2.intent === 'cancel' ? ctx.stage2.entities.start_datetime : null) ?? null,
  };
}

const valid = errors.length === 0;
return [{
  json: {
    ...ctx,
    request: null,
    stage3: {
      attempt: ctx.stage3.attempt,
      valid,
      errors,
      raw,
      command: valid ? command : null,
      can_retry: !valid && ctx.stage3.attempt <= ctx.config.maxStage3Retries,
    },
  },
}];
