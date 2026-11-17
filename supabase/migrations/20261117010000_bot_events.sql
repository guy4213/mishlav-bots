-- How the bot's calls update the contacts. The tools server calls these three functions (service role only):
--   bot_call_started  when a call to a contact is dialed   -> links call_id to the contact
--   bot_tool_event    after every tool the bot ran          -> the contact's status, callback, rep task, note
--   bot_call_ended    when the call is over                 -> no result yet: back to the queue for a retry
-- Every change also appends a "[BOT] ..." line to bot_notes, which Gold reads (updated_at moves with it).

create function bot_note(p_text text) returns text language sql stable set search_path = '' as $$
  select '[BOT] ' || to_char(now() at time zone 'Asia/Jerusalem', 'DD.MM.YYYY HH24:MI') || ' ' || p_text
$$;

create function bot_call_started(p_call_id text, p_contact_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  insert into public.calls (call_id, contact_id) values (p_call_id, p_contact_id);
  update public.contacts
     set status = 'in_call', attempts = attempts + 1, last_call_at = now(), next_call_at = null
   where id = p_contact_id;
  if not found then
    raise exception 'no contact %', p_contact_id;
  end if;
end $$;

-- p_result is the tool's answer as the bot got it. Returns the contact's status after the event (null: the
-- call isn't a contact's call, e.g. a scenario test, or nothing changed).
create function bot_tool_event(p_call_id text, p_tool text, p_params jsonb, p_result jsonb) returns text
language plpgsql set search_path = '' as $$
declare
  v_contact uuid;
  v_status public.contact_status;
  v_new public.contact_status;
  v_outcome text;
  v_note text;
  v_at timestamptz;
  v_reason text := p_params ->> 'reason';
begin
  select contact_id into v_contact from public.calls where call_id = p_call_id;
  if v_contact is null or coalesce((p_result ->> 'ok')::boolean, false) is not true then
    return null;
  end if;
  select status into v_status from public.contacts where id = v_contact for update;

  if p_tool = 'get_day_info' then
    update public.contacts set interested_day_id = p_params ->> 'day_id' where id = v_contact;
    return v_status::text;

  elsif p_tool = 'send_purchase_link' then
    v_new := 'link_sent'; v_outcome := 'LINK_SENT';
    v_note := 'נשלח קישור לרכישה: ' || (p_params ->> 'day_id');
    update public.contacts set interested_day_id = p_params ->> 'day_id' where id = v_contact;

  elsif p_tool = 'schedule_callback' then
    if p_result ->> 'status' <> 'accepted' then return v_status::text; end if;  -- an alternative isn't booked yet
    v_at := (p_result ->> 'scheduled_time')::timestamptz;
    v_new := 'callback'; v_outcome := 'CALLBACK';
    v_note := 'ביקש שנחזור אליו: ' || (p_result ->> 'scheduled_time_he');
    update public.contacts set callback_at = v_at, next_call_at = v_at where id = v_contact;

  elsif p_tool = 'request_human' then
    if p_result ->> 'status' <> 'handed_to_rep' then return v_status::text; end if;  -- still waiting for a time
    v_at := (p_result ->> 'scheduled_time')::timestamptz;
    insert into public.rep_tasks (contact_id, call_id, reason, callback_at)
    values (v_contact, p_call_id, v_reason, v_at);
    v_note := 'להעביר לנציג (' || v_reason || '), לחזור ' || coalesce(p_result ->> 'scheduled_time_he', 'בהקדם');
    if v_reason = 'company_purchase' then
      v_new := 'company'; v_outcome := 'COMPANY';
    elsif v_reason = 'other' then
      -- an open question: the call goes on, and a later result (e.g. the link) wins
      v_outcome := 'HUMAN_FOLLOWUP';
      v_new := case when v_status = 'in_call' then 'human_followup' else v_status end;
    else
      v_new := 'hot_lead'; v_outcome := 'HOT_LEAD';
    end if;

  elsif p_tool = 'end_call' then
    if v_reason is null or v_reason = 'completed' then return v_status::text; end if;  -- the action before it decided
    v_new := v_reason::public.contact_status;
    v_outcome := upper(v_reason);
    v_note := case v_reason
      when 'not_interested' then 'לא מעוניין'
      when 'do_not_call' then 'ביקש להסיר אותו מהרשימה – לא להתקשר'
      when 'already_registered' then 'כבר רשום'
      when 'wrong_number' then 'מספר שגוי'
      when 'voicemail' then 'תא קולי'
      else v_reason end;
  else
    return v_status::text;
  end if;

  -- do_not_call is final: nothing later in the same call undoes it
  if v_status = 'do_not_call' then v_new := 'do_not_call'; end if;
  update public.contacts
     set status = v_new,
         last_outcome = coalesce(v_outcome, last_outcome),
         next_call_at = case when v_new in ('callback') then next_call_at else null end,
         bot_notes = concat_ws(E'\n', bot_notes, public.bot_note(v_note))
   where id = v_contact;
  update public.calls set outcome = coalesce(v_outcome, outcome), reason = coalesce(v_reason, reason)
   where call_id = p_call_id;
  return v_new::text;
end $$;

-- The call is over. A contact still "in_call" got no result: queue it for a retry, or close it after the
-- last attempt (settings.yaml dialing: max_attempts, retry).
create function bot_call_ended(p_call_id text, p_duration_sec int, p_retry_minutes int, p_max_attempts int) returns text
language plpgsql set search_path = '' as $$
declare
  v_contact uuid;
  v_status public.contact_status;
begin
  update public.calls set duration_sec = p_duration_sec where call_id = p_call_id returning contact_id into v_contact;
  if v_contact is null then return null; end if;
  update public.contacts c
     set status = case when c.attempts >= p_max_attempts then 'closed_max_attempts'::public.contact_status else 'queued' end,
         next_call_at = case when c.attempts >= p_max_attempts then null else now() + make_interval(mins => p_retry_minutes) end,
         last_outcome = 'NO_RESULT',
         bot_notes = concat_ws(E'\n', c.bot_notes, public.bot_note('שיחה בלי תוצאה (' || coalesce(p_duration_sec, 0) || ' שניות)'))
   where c.id = v_contact and c.status = 'in_call';
  select status into v_status from public.contacts where id = v_contact;
  return v_status::text;
end $$;

-- Only the backend (service role) may run them: the public API keys can't.
revoke execute on function bot_note(text), bot_call_started(text, uuid), bot_tool_event(text, text, jsonb, jsonb),
  bot_call_ended(text, int, int, int) from public, anon, authenticated;
grant execute on function bot_note(text), bot_call_started(text, uuid), bot_tool_event(text, text, jsonb, jsonb),
  bot_call_ended(text, int, int, int) to service_role;
