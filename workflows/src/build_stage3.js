// ── Build Stage 3 Request ───────────────────────────────────────────────────
// First pass comes from Parse Stage 2; later passes come from the retry branch
// and carry the validator's error list, which is fed back to the model
// ("automatic prompt-adjusted retry").
const STAGE3_PROMPT = __STAGE3_PROMPT__;

const ctx = $input.first().json;
const attempt = (ctx.stage3?.attempt || 0) + 1;
const previousErrors = ctx.stage3?.errors || [];

let user =
  `Timezone: ${ctx.config.timezone}\n` +
  `Placeholder e-mail format for unknown attendees: firstname.lastname@${ctx.config.placeholderEmailDomain}\n` +
  `Stage 2 output: ${JSON.stringify({ intent: ctx.stage2.intent, entities: ctx.stage2.entities })}`;
if (previousErrors.length) {
  user += `\n\nYour previous output was rejected by schema validation:\n- ${previousErrors.join('\n- ')}\n` +
          `Previous output: ${ctx.stage3.raw}\nFix these problems and output the corrected JSON object only.`;
}

return [{
  json: {
    ...ctx,
    stage3: { attempt, errors: previousErrors },
    request: {
      model: ctx.config.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STAGE3_PROMPT },
        { role: 'user', content: user },
      ],
    },
  },
}];
