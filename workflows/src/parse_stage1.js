// ── Parse Stage 1 ───────────────────────────────────────────────────────────
// Reads the Stage 1 verdict. Scheduling messages get a Stage 2 request attached;
// everything else exits the pipeline here (no further API calls).
const STAGE2_PROMPT = __STAGE2_PROMPT__;

const ctx = $('Prepare Input').first().json;
const resp = $input.first().json;

let stage1;
try {
  stage1 = JSON.parse(resp.choices[0].message.content);
} catch (e) {
  stage1 = { is_scheduling: false, error: 'Stage 1 returned unparseable output' };
}
stage1.is_scheduling = stage1.is_scheduling === true;
if (stage1.is_scheduling && !stage1.normalised_message) stage1.normalised_message = ctx.text;

const out = { ...ctx, stage1, request: null };
if (stage1.is_scheduling) {
  out.request = {
    model: ctx.config.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: STAGE2_PROMPT },
      { role: 'user', content:
          `Current date/time: ${ctx.meta.now} (${ctx.meta.weekday})\n` +
          `Sender: ${ctx.meta.sender}\n` +
          `Normalised message: ${stage1.normalised_message}\n` +
          `Temporal expressions: ${JSON.stringify(stage1.temporal_expressions || [])}` },
    ],
  };
}
return [{ json: out }];
