// Offline smoke test for the n8n Code-node scripts: runs them outside n8n with
// stubbed `$input`, `$()` and `$now`, and canned LLM responses.
//   npm i luxon && node tests/test_code_nodes.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const { DateTime } = require('luxon');
const SRC = path.join(__dirname, '..', 'workflows', 'src');
const outputs = {};
function run(file, nodeName, inputJson) {
  let code = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/__STAGE\d_PROMPT__/g, '"PROMPT"');
  const $ = n => ({ first: () => ({ json: outputs[n] }), isExecuted: n in outputs });
  const fn = new Function('$input', '$', '$now', 'DateTime', code);
  const res = fn({ first: () => ({ json: inputJson }) }, $, DateTime.fromISO('2025-06-15T10:00:00', { zone: 'Asia/Bangkok' }), DateTime);
  if (res.length) outputs[nodeName] = res[0].json;
  return res.length ? res[0].json : null;
}
const llm = obj => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });
const update = { message: { message_id: 7, chat: { id: -100 }, from: { first_name: 'Gleb' }, text: "Let's meet tomorrow after lunch to go over the project timeline." } };

assert.strictEqual(run('prepare_input.js', 'x', { message: { chat: { id: 1 }, sticker: {} } }), null);
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

// discarded path
for (const k of Object.keys(outputs)) if (k !== 'Prepare Input') delete outputs[k];
run('parse_stage1.js', 'Parse Stage 1', llm({ is_scheduling: false }));
o = run('finalize.js', 'Finalize', outputs['Parse Stage 1']);
assert.ok(o.status === 'discarded' && o.reply === null);
console.log('all code-node tests passed');
