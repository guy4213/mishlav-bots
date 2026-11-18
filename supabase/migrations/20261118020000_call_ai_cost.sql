-- What each call cost in Gemini tokens. The phone line sums the Live API's per-turn usageMetadata (each turn is
-- billed on the whole session context) and the backend prices it by config/settings.yaml (pricing.gemini_live).
-- Additive only: a server without this change never reads or writes these columns.
alter table calls add column ai_usage jsonb;        -- {model, input: {TEXT, AUDIO..}, output: {...}} in tokens
alter table calls add column ai_cost_usd numeric(10, 5);
comment on column calls.ai_usage is 'Gemini tokens of the call by modality, summed over its turns (input includes the re-billed context)';
comment on column calls.ai_cost_usd is 'USD for ai_usage at the price table in settings.yaml when the call ended';
