-- 1. The dialer calls only the contacts whose "קורס מבוקש" is in settings.yaml dialing.requested_courses (Mishlav:
--    only "יום עיון חשבונאות"). bot_next_due gets the list; null or empty = everyone (as before).
-- 2. A hand-off to a rep names the study day the customer chose (request_human's day_he), as a sent link already
--    does: course number, dates, zoom or in person. bot_tool_event is the same as 20261117040000 otherwise.

drop function bot_next_due(timestamptz, text[]);
create function bot_next_due(p_now timestamptz, p_skip text[] default '{}', p_courses text[] default null)
returns table (gold_record_id text, bot_status public.contact_status, next_call_at timestamptz)
language sql stable set search_path = '' as $$
  select s.gold_record_id, s.bot_status, s.next_call_at
    from public.bot_state s
    join public.contacts c on c.gold_record_id = s.gold_record_id
   where s.bot_status in ('new', 'queued', 'callback')
     and (s.next_call_at is null or s.next_call_at <= p_now)
     and not (s.gold_record_id = any (coalesce(p_skip, '{}')))
     and (coalesce(cardinality(p_courses), 0) = 0 or trim(c.requested_course) = any (p_courses))
   order by case s.bot_status when 'callback' then 0 when 'queued' then 1 else 2 end,
            s.next_call_at nulls last,
            s.gold_record_id
   limit 1
$$;
revoke execute on function bot_next_due(timestamptz, text[], text[]) from public, anon, authenticated;
grant execute on function bot_next_due(timestamptz, text[], text[]) to service_role;

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
    v_note := 'נשלח קישור לרכישה: ' || coalesce(p_result ->> 'day_he', p_params ->> 'day_id');
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
      v_note := 'להעביר לנציג (' || public.rep_reason_he(v_reason) || '), לחזור ' || coalesce(p_result ->> 'scheduled_time_he', 'בהקדם');
    elsif v_reason = 'other' then
      -- an open question: the call goes on, and a later result (e.g. the link) wins. No Gold status.
      v_outcome := 'HUMAN_FOLLOWUP';
      v_new := case when v_state.bot_status = 'in_call' then 'human_followup' else v_state.bot_status end;
      v_note := 'שאלה לנציג, לחזור ' || coalesce(p_result ->> 'scheduled_time_he', 'בהקדם');
    else
      v_new := 'hot_lead'; v_outcome := 'HOT_LEAD';
      v_note := 'להעביר לנציג (' || public.rep_reason_he(v_reason) || '), לחזור ' || coalesce(p_result ->> 'scheduled_time_he', 'בהקדם');
    end if;
    -- the study day the customer chose (request_human's day_id): the rep knows what to sell
    v_note := v_note || coalesce(' · ' || (p_result ->> 'day_he'), '');

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
        else 'השיחה הסתיימה' end;
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
