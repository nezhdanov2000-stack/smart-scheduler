// Offline smoke test for the n8n Code-node scripts: runs them outside n8n with
// stubbed `$input`, `$()` and `$now`, and canned LLM responses.
//   npm i luxon && node tests/test_code_nodes.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const { DateTime } = require('luxon');
const SRC = path.join(__dirname, '..', 'workflows', 'src');
const outputs = {};
const staticData = {};   // stands in for n8n's $getWorkflowStaticData('global')
function run(file, nodeName, inputJson) {
  let code = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/__STAGE\d_PROMPT__/g, '"PROMPT"');
  const $ = n => ({ first: () => ({ json: outputs[n] }), isExecuted: n in outputs });
  const fn = new Function('$input', '$', '$now', 'DateTime', '$getWorkflowStaticData', code);
  const res = fn({ first: () => ({ json: inputJson }) }, $, DateTime.fromISO('2025-06-15T10:00:00', { zone: 'Asia/Bangkok' }), DateTime, () => staticData);
  if (res.length) outputs[nodeName] = res[0].json;
  return res.length ? res[0].json : null;
}
const llm = obj => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });
const update = { message: { message_id: 7, chat: { id: -100 }, from: { first_name: 'Gleb' }, text: "Let's meet tomorrow after lunch to go over the project timeline." } };

assert.strictEqual(run('prepare_input.js', 'x', { message: { chat: { id: 1 }, sticker: {} } }), null);
let b = run('prepare_input.js', 'x', { business_message: { business_connection_id: 'abc', message_id: 3, chat: { id: 555, first_name: 'Anna' }, from: { id: 555, first_name: 'Anna' }, text: 'Can we meet tomorrow at 3pm?' } });
assert.ok(b.meta.business && b.meta.reply_chat_id === 845660052 && b.meta.reply_to === null && b.meta.counterpart === 'Anna');
let o = run('prepare_input.js', 'Prepare Input', update);
assert.strictEqual(o.meta.now, '2025-06-15T10:00:00'); assert.strictEqual(o.meta.weekday, 'Sunday');

o = run('parse_stage1.js', 'Parse Stage 1', llm({ is_scheduling: true, normalised_message: "Let's meet 2025-06-16T13:00:00 ...", temporal_expressions: [] }));
assert.ok(o.stage1.is_scheduling && o.request.messages.length === 2);

o = run('parse_stage2.js', 'Parse Stage 2', llm({ intent: 'create', entities: { event_title: 'Project Timeline Review', start_datetime: '2025-06-16T13:00:00', end_datetime: null, location: null, participants: [] } }));
assert.ok(o.stage2.ok); assert.strictEqual(o.stage2.entities.end_datetime, '2025-06-16T14:00:00');

// attempt 1: hallucinated field + malformed datetime -> rejected, retry allowed
o = run('build_stage3.js', 'Build Stage 3 Request', o);
o = run('validate_command.js', 'Validate Command', llm({ method: 'POST', body: { summary: 'Project Timeline Review', priority: 'high', start: { dateTime: '16/06/2025 13:00', timeZone: 'Asia/Bangkok' }, end: { dateTime: '2025-06-16T14:00:00', timeZone: 'Asia/Bangkok' } }, target: null }));
assert.ok(!o.stage3.valid && o.stage3.can_retry && o.stage3.errors.length === 2, JSON.stringify(o.stage3.errors));

// attempt 2: feedback is in the prompt; valid output accepted
o = run('build_stage3.js', 'Build Stage 3 Request', o);
assert.strictEqual(o.stage3.attempt, 2); assert.ok(o.request.messages[1].content.includes('rejected by schema validation'));
const good = { summary: 'Project Timeline Review', start: { dateTime: '2025-06-16T13:00:00', timeZone: 'Asia/Bangkok' }, end: { dateTime: '2025-06-16T14:00:00', timeZone: 'Asia/Bangkok' }, attendees: [{ email: 'anna@example.com', displayName: 'Anna' }] };
o = run('validate_command.js', 'Validate Command', llm({ method: 'POST', body: good, target: null }));
assert.ok(o.stage3.valid, JSON.stringify(o.stage3.errors));
o = run('validate_command.js', 'Validate Command', llm(good));            // bare body is wrapped
assert.ok(o.stage3.valid && o.stage3.command.method === 'POST');
o = run('validate_command.js', 'Validate Command', llm('not json'));
assert.ok(!o.stage3.valid);
o = run('validate_command.js', 'Validate Command', llm({ method: 'DELETE', body: null, target: null })); // wrong method for create
assert.ok(!o.stage3.valid);

// conflict check: busy slot -> rejected with suggestion; free slot -> proceeds
run('validate_command.js', 'Validate Command', llm({ method: 'POST', body: good, target: null }));
o = run('detect_conflict.js', 'Detect Conflict', { items: [
  { id: 'x', summary: 'Dentist', start: { dateTime: '2025-06-16T13:30:00+07:00' }, end: { dateTime: '2025-06-16T14:30:00+07:00' } },
  { id: 'y', summary: 'Lunch', start: { dateTime: '2025-06-16T14:30:00+07:00' }, end: { dateTime: '2025-06-16T15:00:00+07:00' } },
  { id: 'z', summary: 'Holiday', start: { date: '2025-06-16' }, end: { date: '2025-06-17' } }] });
assert.ok(o.slot.checked && o.slot.conflict && o.slot.conflicts[0].summary === 'Dentist', JSON.stringify(o.slot));
assert.strictEqual(o.slot.suggestion.label, '15:00–16:00');
o = run('finalize.js', 'Finalize', o);
assert.strictEqual(o.status, 'conflict'); assert.ok(o.reply.includes('Dentist') && o.reply.includes('15:00–16:00'));
console.log(o.reply);
o = run('detect_conflict.js', 'Detect Conflict', { items: [{ id: 'z', summary: 'Holiday', start: { date: '2025-06-16' }, end: { date: '2025-06-17' } }] });
assert.ok(o.slot.checked && !o.slot.conflict);
delete outputs['Detect Conflict'];

// create -> finalize
run('validate_command.js', 'Validate Command', llm({ method: 'POST', body: good, target: null }));
outputs['Create Event'] = {};
o = run('finalize.js', 'Finalize', { id: 'evt1', htmlLink: 'https://calendar.google.com/x' });
assert.strictEqual(o.status, 'created'); assert.ok(o.reply.includes('Project Timeline Review')); assert.ok(!('text' in o.payload));
console.log(o.reply);

// cancel path: lookup by title/time
delete outputs['Create Event'];
outputs['Parse Stage 2'].stage2.intent = 'cancel';
run('build_stage3.js', 'Build Stage 3 Request', outputs['Parse Stage 2']);
o = run('validate_command.js', 'Validate Command', llm({ method: 'DELETE', body: null, target: { summary: 'Project timeline review', start_datetime: '2025-06-16T13:00:00' } }));
assert.ok(o.stage3.valid);
o = run('pick_event.js', 'Pick Event', { items: [
  { id: 'a', summary: 'Dentist', start: { dateTime: '2025-06-16T09:00:00+07:00' } },
  { id: 'b', summary: 'Project Timeline Review', start: { dateTime: '2025-06-16T13:00:00+07:00' } }] });
assert.ok(o.lookup.found && o.lookup.event_id === 'b');
o = run('pick_event.js', 'Pick Event', { items: [{ id: 'a', summary: 'Dentist', start: { dateTime: '2025-06-20T09:00:00+07:00' } }] });
assert.ok(!o.lookup.found);
o = run('finalize.js', 'Finalize', o);
assert.strictEqual(o.status, 'event_not_found');

// modify: the event being moved must not conflict with itself
outputs['Parse Stage 2'].stage2.intent = 'modify';
run('build_stage3.js', 'Build Stage 3 Request', outputs['Parse Stage 2']);
run('validate_command.js', 'Validate Command', llm({ method: 'PATCH', body: { start: good.start, end: good.end }, target: { summary: 'Project Timeline Review', start_datetime: null } }));
run('pick_event.js', 'Pick Event', { items: [{ id: 'b', summary: 'Project Timeline Review', start: { dateTime: '2025-06-17T10:00:00+07:00' } }] });
o = run('detect_conflict.js', 'Detect Conflict', { items: [{ id: 'b', summary: 'Project Timeline Review', start: { dateTime: '2025-06-16T13:00:00+07:00' }, end: { dateTime: '2025-06-16T14:00:00+07:00' } }] });
assert.ok(!o.slot.conflict, 'own event must be excluded');
delete outputs['Pick Event']; delete outputs['Detect Conflict'];

// discarded path
for (const k of Object.keys(outputs)) if (k !== 'Prepare Input') delete outputs[k];
run('parse_stage1.js', 'Parse Stage 1', llm({ is_scheduling: false }));
o = run('finalize.js', 'Finalize', outputs['Parse Stage 1']);
assert.ok(o.status === 'discarded' && o.reply === null);
// confirmation flow
for (const k of Object.keys(outputs)) delete outputs[k];
run('prepare_input.js', 'Prepare Input', { business_message: { business_connection_id: 'abc', message_id: 3, chat: { id: 555, first_name: 'Anna' }, from: { id: 555, first_name: 'Anna' }, text: 'Can we meet tomorrow at 3pm?' } });
run('parse_stage1.js', 'Parse Stage 1', llm({ is_scheduling: true, normalised_message: 'x', temporal_expressions: [] }));
run('parse_stage2.js', 'Parse Stage 2', llm({ intent: 'create', entities: { event_title: 'Catch-up', start_datetime: '2025-06-16T15:00:00', end_datetime: null, location: null, participants: ['Anna'] } }));
run('build_stage3.js', 'Build Stage 3 Request', outputs['Parse Stage 2']);
run('validate_command.js', 'Validate Command', llm({ method: 'POST', body: { summary: 'Catch-up', start: { dateTime: '2025-06-16T15:00:00', timeZone: 'Asia/Bangkok' }, end: { dateTime: '2025-06-16T16:00:00', timeZone: 'Asia/Bangkok' } }, target: null }));
o = run('detect_conflict.js', 'Detect Conflict', { items: [] });
o = run('prepare_confirmation.js', 'Prepare Confirmation', o);
assert.ok(o.ask_text.includes('Anna in chat with Anna') && o.ask_text.includes('Catch-up') && o.ask_text.includes('15:00'));
console.log(o.ask_text);
o = run('save_pending.js', 'Save Pending', o);
const pendingId = o.id;
assert.ok(pendingId >= 1 && staticData.pending[pendingId].status === 'pending');
outputs['Ask Owner'] = {};
o = run('finalize.js', 'Finalize', {});
assert.ok(o.status === 'pending' && o.reply === null);
// ...button pressed
for (const k of Object.keys(outputs)) delete outputs[k];
run('prepare_input.js', 'Prepare Input', { callback_query: { id: 'q1', data: `ok:${pendingId}`, from: { id: 845660052 }, message: { chat: { id: 845660052 }, message_id: 9, text: 'card' } } });
assert.strictEqual(outputs['Prepare Input'].callback.pending_id, pendingId);
o = run('load_pending.js', 'Load Pending', outputs['Prepare Input']);
assert.ok(o.ctx && staticData.pending[pendingId].status === 'approved');
o = run('restore_pending.js', 'Restore Pending', o);
assert.ok(o.approved && !o.expired && o.stage3.command.method === 'POST' && o.edit_text.endsWith('⏳ Adding…'));
outputs['Create Event'] = {};
o = run('finalize.js', 'Finalize', { id: 'evt2', htmlLink: 'https://calendar.google.com/y' });
assert.ok(o.status === 'created' && o.reply.includes('Catch-up') && o.reply_chat_id === '845660052', o.reply);
delete outputs['Create Event'];
o = run('load_pending.js', 'Load Pending', outputs['Prepare Input']);   // second press on the same card
assert.deepStrictEqual(o, {});
o = run('restore_pending.js', 'Restore Pending', o);     // already handled
assert.ok(o.expired && !o.approved);
o = run('finalize.js', 'Finalize', o);
assert.ok(o.status === 'expired' && o.reply === null);
console.log('all code-node tests passed');
