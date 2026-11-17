-- `contacts` becomes an exact copy of the Gold student export (16 columns, nothing of ours). The bot writes its
-- results into Gold's own two fields (notes = "הערות", status = "סטטוס"); everything it needs for dialing lives
-- in internal tables Gold never sees (bot_state, calls, rep_tasks). Gold pulls the contacts the bot changed
-- (bot_state.gold_changed_at) through GET /api/gold/changes, which calls gold_changes() below.
-- Replaces 20261117000000_contacts + 20261117010000_bot_events (demo data only: rebuilt, then seed.sql).

drop function if exists bot_call_ended(text, int, int, int);
drop function if exists bot_tool_event(text, text, jsonb, jsonb);
drop function if exists bot_call_started(text, uuid);
drop function if exists bot_note(text);
drop table if exists rep_tasks, calls, contacts cascade;
drop function if exists touch_updated_at();
-- contact_status (the bot's own status) stays as it is: bot_state.bot_status uses it

-- The Gold copy: one column per Excel column, in the Excel's order (config/settings.yaml gold_import.columns)
create table contacts (
  gold_record_id   text primary key,          -- the unnamed first column: Gold's record id
  national_id      text,                      -- ת.ז
  company          text,                      -- חברה
  full_name        text,                      -- שם מלא
  email            text,                      -- אימייל
  phone            text,                      -- טלפון
  phone2           text,                      -- טלפון 2
  phone3           text,                      -- טלפון 3
  notes            text,                      -- הערות (the bot appends "[BOT] ..." lines)
  city             text,                      -- עיר
  address          text,                      -- כתובת
  address2         text,                      -- כתובת 2
  department       text,                      -- מחלקה
  requested_course text,                      -- קורס מבוקש
  source           text,                      -- מקור
  status           text                       -- סטטוס (the bot sets it, gold_status_text below)
);

-- The bot's side of each contact (internal)
create table bot_state (
  gold_record_id    text primary key references contacts (gold_record_id) on delete cascade on update cascade,
  bot_status        contact_status not null default 'new',
  attempts          int not null default 0,
  next_call_at      timestamptz,
  callback_at       timestamptz,
  last_call_at      timestamptz,
  last_outcome      text,
  interested_day_id text,                     -- a day_id from the catalogue, when known
  customer_gender   text check (customer_gender in ('male', 'female', 'unknown')),
  phone_index       smallint not null default 1 check (phone_index between 1 and 3),  -- phone / phone2 / phone3
  gold_changed_at   timestamptz                -- when the bot last changed contacts.notes / status (Gold's pull)
);
create index bot_state_due on bot_state (bot_status, next_call_at);
create index bot_state_gold_changed on bot_state (gold_changed_at);

-- every new contact gets its bot_state row
create function bot_state_for_new_contact() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into public.bot_state (gold_record_id) values (new.gold_record_id) on conflict do nothing;
  return new;
end $$;
create trigger contacts_bot_state after insert on contacts for each row execute function bot_state_for_new_contact();

create table calls (
  id             uuid primary key default gen_random_uuid(),
  gold_record_id text not null references contacts (gold_record_id) on delete cascade on update cascade,
  call_id        text not null unique,        -- the voice layer's call id
  started_at     timestamptz not null default now(),
  duration_sec   int,
  outcome        text,
  reason         text,
  summary        text
);
create index calls_contact on calls (gold_record_id, started_at desc);

-- "A rep should call this lead back" (request_human): the note the reps work from
create table rep_tasks (
  id             uuid primary key default gen_random_uuid(),
  gold_record_id text not null references contacts (gold_record_id) on delete cascade on update cascade,
  call_id        text,
  reason         text not null,               -- wants_human, pay_via_rep, company_purchase, discount_request, course_interest, other
  callback_at    timestamptz,                 -- when the customer asked the rep to call (null = as soon as possible)
  note           text,
  done           boolean not null default false,
  created_at     timestamptz not null default now()
);
create index rep_tasks_open on rep_tasks (done, callback_at);

alter table contacts enable row level security;
alter table bot_state enable row level security;
alter table calls enable row level security;
alter table rep_tasks enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- How the bot's calls update the contacts. The tools server calls these (service role only):
--   bot_call_started  when a call to a contact is dialed   -> links call_id to the contact
--   bot_tool_event    after every tool the bot ran          -> Gold notes/status, bot_state, rep task
--   bot_call_ended    when the call is over                 -> no result yet: back to the queue for a retry

-- THE Gold status text for each result (null = leave Gold's status as it is). Temporary texts until Mishlav
-- sends their list: replace them here, nowhere else.
create function gold_status_text(p_status contact_status) returns text language sql immutable set search_path = '' as $$
  select case p_status
    when 'link_sent'           then 'נשלח קישור'
    when 'callback'            then 'לחזור'
    when 'hot_lead'            then 'להעביר לנציג'
    when 'company'             then 'רכישה דרך החברה'
    when 'not_interested'      then 'לא מעוניין'
    when 'do_not_call'         then 'להסרה'
    when 'already_registered'  then 'כבר רשום'
    when 'wrong_number'        then 'מספר שגוי'
    when 'closed_max_attempts' then 'לא ענה'
  end
$$;

create function bot_note(p_text text) returns text language sql stable set search_path = '' as $$
  select '[BOT] ' || to_char(now() at time zone 'Asia/Jerusalem', 'DD.MM.YYYY HH24:MI') || ' ' || p_text
$$;

-- Writes a result into Gold's fields: a "[BOT]" line at the end of the notes (what is there stays) and the
-- status text, if the result has one. Marks the contact for Gold's next pull.
create function bot_write_gold(p_id text, p_status contact_status, p_note text) returns void
language plpgsql set search_path = '' as $$
begin
  update public.contacts
     set notes = concat_ws(E'\n', nullif(notes, ''), public.bot_note(p_note)),
         status = coalesce(public.gold_status_text(p_status), status)
   where gold_record_id = p_id;
  update public.bot_state set gold_changed_at = now() where gold_record_id = p_id;
end $$;

create function bot_call_started(p_call_id text, p_gold_record_id text) returns void
language plpgsql set search_path = '' as $$
begin
  update public.bot_state
     set bot_status = 'in_call', attempts = attempts + 1, last_call_at = now(), next_call_at = null
   where gold_record_id = p_gold_record_id;
  if not found then
    raise exception 'no contact %', p_gold_record_id;
  end if;
  insert into public.calls (call_id, gold_record_id) values (p_call_id, p_gold_record_id);
end $$;

-- p_result is the tool's answer as the bot got it. Returns the bot status after the event (null: the call
-- isn't a contact's call, e.g. a scenario test).
create function bot_tool_event(p_call_id text, p_tool text, p_params jsonb, p_result jsonb) returns text
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
         phone_index = coalesce(v_next_phone, phone_index)
   where gold_record_id = v_id;
  perform public.bot_write_gold(v_id, v_new, v_note);
  update public.calls set outcome = coalesce(v_outcome, outcome), reason = coalesce(v_reason, reason)
   where call_id = p_call_id;
  return v_new::text;
end $$;

-- The call is over. A contact still "in_call" got no result (no answer, voicemail, hung up): queue it for a
-- retry with a "לא ענה" note, or close it after the last attempt (settings.yaml dialing: max_attempts, retry).
create function bot_call_ended(p_call_id text, p_duration_sec int, p_retry_minutes int, p_max_attempts int) returns text
language plpgsql set search_path = '' as $$
declare
  v_id text;
  v_outcome text;
  v_new public.contact_status;
begin
  update public.calls set duration_sec = p_duration_sec where call_id = p_call_id
  returning gold_record_id, outcome into v_id, v_outcome;
  if v_id is null then return null; end if;
  update public.bot_state s
     set bot_status = case when s.attempts >= p_max_attempts then 'closed_max_attempts'::public.contact_status else 'queued' end,
         next_call_at = case when s.attempts >= p_max_attempts then null else now() + make_interval(mins => p_retry_minutes) end,
         last_outcome = coalesce(v_outcome, 'NO_RESULT')
   where s.gold_record_id = v_id and s.bot_status = 'in_call'
  returning bot_status into v_new;
  if v_new is not null then
    perform public.bot_write_gold(v_id, v_new, case when v_outcome = 'VOICEMAIL' then 'לא ענה (תא קולי)' else 'לא ענה' end);
    return v_new::text;
  end if;
  return (select bot_status::text from public.bot_state where gold_record_id = v_id);
end $$;

-- What Gold receives: the contacts the bot changed after p_since (null = all it ever changed), Gold's columns
-- only, plus `until` (the next p_since). The backend renames the columns to the Excel's headers.
create function gold_changes(p_since timestamptz default null) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'until', now(),
    'contacts', coalesce(jsonb_agg(to_jsonb(c) order by s.gold_changed_at, c.gold_record_id), '[]'::jsonb))
    from public.contacts c
    join public.bot_state s using (gold_record_id)
   where s.gold_changed_at is not null and (p_since is null or s.gold_changed_at > p_since)
$$;

-- Only the backend (service role) may run them: the public API keys can't.
revoke execute on function gold_status_text(contact_status), bot_note(text), bot_write_gold(text, contact_status, text),
  bot_call_started(text, text), bot_tool_event(text, text, jsonb, jsonb), bot_call_ended(text, int, int, int),
  gold_changes(timestamptz), bot_state_for_new_contact() from public, anon, authenticated;
grant execute on function gold_status_text(contact_status), bot_note(text), bot_write_gold(text, contact_status, text),
  bot_call_started(text, text), bot_tool_event(text, text, jsonb, jsonb), bot_call_ended(text, int, int, int),
  gold_changes(timestamptz) to service_role;
