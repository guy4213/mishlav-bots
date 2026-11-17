-- Retrying contacts who don't answer (settings.yaml dialing; the cadence is a proposal pending Mishlav's approval).
--   bot_state.attempts          every call ever (as before, never resets)
--   bot_state.no_answer_streak  calls in a row with no result; 0 when the customer answered, or when a wrong
--                               number moved the bot to the next phone (a new number gets a fresh round)
--   bot_state.ever_answered     the customer answered at least once
--   calls.answered              we talked with the customer in this call (only for the note of a call that
--                               ended without a result: "לא ענה" would be wrong there)
-- "Answered" = a successful get_day_info / send_purchase_link / schedule_callback / request_human, or end_call
-- with a reason other than voicemail / wrong_number.
-- The bot stops at no_answer_streak_max no-result calls in a row, or after max_total_calls calls in all (whatever
-- the last one's result, as long as the contact would be called again: queued / callback):
--   never answered -> closed_max_attempts (Gold "לא ענה")
--   answered once  -> hot_lead (Gold "להעביר לנציג") + a rep task with reason 'unreachable'
--
-- PRODUCTION: the deployed server still calls the old bot_call_ended(text, int, int, int). It stays as it is
-- (it doesn't know the streak) until the new server is deployed.
-- TODO after deploy: drop function bot_call_ended(text, int, int, int);

alter table bot_state
  add column no_answer_streak int not null default 0,
  add column ever_answered boolean not null default false;
alter table calls add column answered boolean not null default false;

-- contacts that already have a result from a conversation answered
update bot_state set ever_answered = true
 where bot_status in ('link_sent', 'callback', 'hot_lead', 'company', 'human_followup', 'not_interested',
                      'do_not_call', 'already_registered');

comment on column rep_tasks.reason is
  'request_human reasons (wants_human, pay_via_rep, company_purchase, discount_request, course_interest, other), '
  'or unreachable: the customer answered once, then the bot could not reach him again';

-- Same as 20261117020000_gold_copy.sql, plus the streak: an answered call resets it, a wrong number that moves
-- to the next phone too.
create or replace function bot_tool_event(p_call_id text, p_tool text, p_params jsonb, p_result jsonb) returns text
language plpgsql set search_path = '' as $$
declare
  v_id text;
  v_state public.bot_state;
  v_contact public.contacts;
  v_new public.contact_status;
  v_outcome text;
  v_note text;
  v_at timestamptz;          -- callback time (callback / rep task)
  v_next_phone smallint;     -- wrong number: the next phone to dial
  v_reason text := p_params ->> 'reason';
begin
  select gold_record_id into v_id from public.calls where call_id = p_call_id;
  if v_id is null or coalesce((p_result ->> 'ok')::boolean, false) is not true then
    return null;
  end if;
  select * into v_state from public.bot_state where gold_record_id = v_id for update;

  -- we talked with the customer: the no-answer streak starts over
  if p_tool in ('get_day_info', 'send_purchase_link', 'schedule_callback', 'request_human')
     or (p_tool = 'end_call' and v_reason not in ('voicemail', 'wrong_number')) then
    update public.bot_state set no_answer_streak = 0, ever_answered = true where gold_record_id = v_id;
    update public.calls set answered = true where call_id = p_call_id;
  end if;

  if p_tool = 'get_day_info' then
    update public.bot_state set interested_day_id = p_params ->> 'day_id' where gold_record_id = v_id;
    return v_state.bot_status::text;

  elsif p_tool = 'send_purchase_link' then
    v_new := 'link_sent'; v_outcome := 'LINK_SENT';
    v_note := 'נשלח קישור לרכישה: ' || (p_params ->> 'day_id');
    update public.bot_state set interested_day_id = p_params ->> 'day_id' where gold_record_id = v_id;

  elsif p_tool = 'schedule_callback' then
    if p_result ->> 'status' <> 'accepted' then return v_state.bot_status::text; end if;  -- an alternative isn't booked yet
    v_at := (p_result ->> 'scheduled_time')::timestamptz;
    v_new := 'callback'; v_outcome := 'CALLBACK';
    v_note := 'ביקש שנחזור אליו: ' || (p_result ->> 'scheduled_time_he');

  elsif p_tool = 'request_human' then
    if p_result ->> 'status' <> 'handed_to_rep' then return v_state.bot_status::text; end if;  -- still waiting for a time
    insert into public.rep_tasks (gold_record_id, call_id, reason, callback_at)
    values (v_id, p_call_id, v_reason, (p_result ->> 'scheduled_time')::timestamptz);
    if v_reason = 'company_purchase' then
      v_new := 'company'; v_outcome := 'COMPANY';
      v_note := 'להעביר לנציג (' || v_reason || '), לחזור ' || coalesce(p_result ->> 'scheduled_time_he', 'בהקדם');
    elsif v_reason = 'other' then
      -- an open question: the call goes on, and a later result (e.g. the link) wins. No Gold status.
      v_outcome := 'HUMAN_FOLLOWUP';
      v_new := case when v_state.bot_status = 'in_call' then 'human_followup' else v_state.bot_status end;
      v_note := 'שאלה לנציג, לחזור ' || coalesce(p_result ->> 'scheduled_time_he', 'בהקדם');
    else
      v_new := 'hot_lead'; v_outcome := 'HOT_LEAD';
      v_note := 'להעביר לנציג (' || v_reason || '), לחזור ' || coalesce(p_result ->> 'scheduled_time_he', 'בהקדם');
    end if;

  elsif p_tool = 'end_call' then
    if v_reason is null or v_reason = 'completed' then return v_state.bot_status::text; end if;  -- the action before it decided
    v_outcome := upper(v_reason);
    if v_reason = 'voicemail' then
      -- no answer: bot_call_ended queues the retry and writes the note
      update public.calls set outcome = v_outcome, reason = v_reason where call_id = p_call_id;
      update public.bot_state set last_outcome = v_outcome where gold_record_id = v_id;
      return v_state.bot_status::text;
    elsif v_reason = 'wrong_number' then
      -- spec 4.7: phone 2, then phone 3, otherwise close
      select * into v_contact from public.contacts where gold_record_id = v_id;
      v_next_phone := case
        when v_state.phone_index < 2 and nullif(trim(v_contact.phone2), '') is not null then 2
        when v_state.phone_index < 3 and nullif(trim(v_contact.phone3), '') is not null then 3
      end;
      if v_next_phone is not null then
        v_new := 'queued';
        v_note := 'מספר שגוי (' || case v_state.phone_index when 1 then 'טלפון' else 'טלפון ' || v_state.phone_index end
                  || '), עוברים לטלפון ' || v_next_phone;
      else
        v_new := 'wrong_number';
        v_note := 'מספר שגוי';
      end if;
    else
      v_new := v_reason::public.contact_status;
      v_note := case v_reason
        when 'not_interested' then 'לא מעוניין'
        when 'do_not_call' then 'ביקש להסיר אותו מהרשימה – לא להתקשר'
        when 'already_registered' then 'כבר רשום'
        else v_reason end;
    end if;
  else
    return v_state.bot_status::text;
  end if;

  -- do_not_call is final: nothing later in the same call undoes it
  if v_state.bot_status = 'do_not_call' then v_new := 'do_not_call'; v_next_phone := null; end if;
  update public.bot_state
     set bot_status = v_new,
         last_outcome = coalesce(v_outcome, last_outcome),
         callback_at = case when v_new = 'callback' then v_at else callback_at end,
         next_call_at = case when v_new = 'callback' then v_at when v_new = 'queued' then now() else null end,
         phone_index = coalesce(v_next_phone, phone_index),
         no_answer_streak = case when v_next_phone is not null then 0 else no_answer_streak end
   where gold_record_id = v_id;
  perform public.bot_write_gold(v_id, v_new, v_note);
  update public.calls set outcome = coalesce(v_outcome, outcome), reason = coalesce(v_reason, reason)
   where call_id = p_call_id;
  return v_new::text;
end $$;

-- The call is over.
--   still "in_call" = no result (no answer, voicemail, hung up): the streak grows; the next call is
--     p_next_call_at[new streak] (the backend computes them from business hours: packages/shared/src/retry.ts)
--   queued / callback after the bot's last allowed call: it stops anyway
--   anything else: the call's result stands
-- Stopping: never answered -> closed_max_attempts; answered once -> a rep (hot_lead + rep task 'unreachable',
-- at the customer's callback time if it is still ahead).
create function bot_call_ended(p_call_id text, p_duration_sec int, p_next_call_at timestamptz[],
                               p_no_answer_streak_max int, p_max_total_calls int) returns text
language plpgsql set search_path = '' as $$
declare
  v_id text;
  v_outcome text;
  v_answered boolean;
  v_state public.bot_state;
  v_no_result boolean;
  v_streak int;
  v_streak_hit boolean;
  v_new public.contact_status;
  v_note text;
begin
  update public.calls set duration_sec = p_duration_sec where call_id = p_call_id
  returning gold_record_id, outcome, answered into v_id, v_outcome, v_answered;
  if v_id is null then return null; end if;
  select * into v_state from public.bot_state where gold_record_id = v_id for update;

  v_no_result := v_state.bot_status = 'in_call';
  if not v_no_result and not (v_state.bot_status in ('queued', 'callback') and v_state.attempts >= p_max_total_calls) then
    return v_state.bot_status::text;
  end if;
  v_streak := v_state.no_answer_streak + case when v_no_result then 1 else 0 end;
  v_streak_hit := v_streak >= p_no_answer_streak_max;

  if not v_streak_hit and v_state.attempts < p_max_total_calls then
    v_new := 'queued';
    v_note := case when v_outcome = 'VOICEMAIL' then 'לא ענה (תא קולי)'
                   when v_answered then 'השיחה נגמרה בלי תוצאה'
                   else 'לא ענה' end;
  elsif v_state.ever_answered then
    v_new := 'hot_lead';
    v_note := case when v_streak_hit then 'ביקש שנחזור, לא הצלחנו להשיג אותו – נציג יחזור'
                   else p_max_total_calls || ' שיחות בלי סגירה – נציג יחזור' end;
    insert into public.rep_tasks (gold_record_id, call_id, reason, callback_at)
    values (v_id, p_call_id, 'unreachable', case when v_state.callback_at > now() then v_state.callback_at end);
  else
    v_new := 'closed_max_attempts';
    v_note := case when v_streak_hit then p_no_answer_streak_max || ' ניסיונות בלי מענה – נסגר'
                   else p_max_total_calls || ' שיחות בלי מענה – נסגר' end;
  end if;

  update public.bot_state
     set bot_status = v_new,
         no_answer_streak = v_streak,
         next_call_at = case when v_new = 'queued'
                          then coalesce(p_next_call_at[v_streak], p_next_call_at[cardinality(p_next_call_at)], now())
                        end,
         last_outcome = case when v_no_result then coalesce(v_outcome, 'NO_RESULT') else last_outcome end
   where gold_record_id = v_id;
  perform public.bot_write_gold(v_id, v_new, v_note);
  return v_new::text;
end $$;

revoke execute on function bot_call_ended(text, int, timestamptz[], int, int) from public, anon, authenticated;
grant execute on function bot_call_ended(text, int, timestamptz[], int, int) to service_role;
