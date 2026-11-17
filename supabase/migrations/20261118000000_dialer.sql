-- The automatic dialer (apps/backend/src/dialer.ts) and the real purchase-link SMS (apps/backend/src/sms.ts).
-- Additive only: the server deployed from main keeps working (bot_call_started still takes its two named args).
--
--   dialer_control      one row: is the dialer on? Survives restarts and deploys. Starts OFF.
--   bot_next_due        the next contact to dial now
--   bot_mark_no_phone   a contact without a valid phone leaves the queue (wrong_number), so it can't block it
--   bot_call_number     the phone a call is on (send_purchase_link's recipient; the bot never sees a number)
--   calls.origin        'dialer' (the automatic loop) or 'manual' (dashboard tests)

create table dialer_control (
  id         boolean primary key default true check (id),   -- a single row
  enabled    boolean not null default false,
  changed_at timestamptz not null default now(),
  reason     text
);
insert into dialer_control (id, enabled, reason) values (true, false, 'כבוי עד ההפעלה הראשונה מהדשבורד')
on conflict (id) do nothing;
alter table dialer_control enable row level security;
revoke all on table dialer_control from public, anon, authenticated;
grant select, update on table dialer_control to service_role;

-- Turns the dialer on or off; returns the row as it is now.
create function dialer_set(p_enabled boolean, p_reason text default null) returns public.dialer_control
language sql set search_path = '' as $$
  update public.dialer_control set enabled = p_enabled, changed_at = now(), reason = p_reason
   where id
  returning *
$$;

alter table calls add column origin text not null default 'manual' check (origin in ('dialer', 'manual'));

-- Same as 20261117020000_gold_copy.sql, plus where the call came from. Replaces the two-argument version (an
-- overload next to it would make two-argument calls ambiguous for PostgREST); p_origin defaults to 'manual',
-- so the deployed server's {p_call_id, p_gold_record_id} calls work unchanged.
drop function bot_call_started(text, text);
create function bot_call_started(p_call_id text, p_gold_record_id text, p_origin text default 'manual') returns void
language plpgsql set search_path = '' as $$
begin
  update public.bot_state
     set bot_status = 'in_call', attempts = attempts + 1, last_call_at = now(), next_call_at = null
   where gold_record_id = p_gold_record_id;
  if not found then
    raise exception 'no contact %', p_gold_record_id;
  end if;
  insert into public.calls (call_id, gold_record_id, origin) values (p_call_id, p_gold_record_id, p_origin);
end $$;

-- The next contact to dial at p_now: new / queued / callback whose time has come (or never set). Callbacks
-- first (the customer asked for that time), then retries by their time, then new contacts by record id.
-- p_skip: contacts the dialer passed over in this run (e.g. not in DIALER_ONLY_NUMBERS), so they can't block it.
create function bot_next_due(p_now timestamptz, p_skip text[] default '{}')
returns table (gold_record_id text, bot_status public.contact_status, next_call_at timestamptz)
language sql stable set search_path = '' as $$
  select s.gold_record_id, s.bot_status, s.next_call_at
    from public.bot_state s
   where s.bot_status in ('new', 'queued', 'callback')
     and (s.next_call_at is null or s.next_call_at <= p_now)
     and not (s.gold_record_id = any (coalesce(p_skip, '{}')))
   order by case s.bot_status when 'callback' then 0 when 'queued' then 1 else 2 end,
            s.next_call_at nulls last,
            s.gold_record_id
   limit 1
$$;

-- No valid phone to dial: out of the queue as a wrong number, with a note in Gold. Never touches a call in
-- progress or a do-not-call. Returns the contact's status after it.
create function bot_mark_no_phone(p_gold_record_id text) returns text
language plpgsql set search_path = '' as $$
declare
  v_new public.contact_status;
begin
  update public.bot_state
     set bot_status = 'wrong_number', next_call_at = null, last_outcome = 'NO_PHONE'
   where gold_record_id = p_gold_record_id and bot_status not in ('in_call', 'do_not_call')
  returning bot_status into v_new;
  if v_new is null then
    return (select s.bot_status::text from public.bot_state s where s.gold_record_id = p_gold_record_id);
  end if;
  perform public.bot_write_gold(p_gold_record_id, v_new, 'אין מספר טלפון תקין');
  return v_new::text;
end $$;

-- The phone a contact's call is on, as written in Gold (phone / phone2 / phone3 by phone_index). Null: the
-- call isn't a contact's (a scenario test) or that phone is empty. The backend normalises it.
create function bot_call_number(p_call_id text) returns text
language sql stable set search_path = '' as $$
  select case s.phone_index when 1 then c.phone when 2 then c.phone2 else c.phone3 end
    from public.calls k
    join public.contacts c on c.gold_record_id = k.gold_record_id
    join public.bot_state s on s.gold_record_id = k.gold_record_id
   where k.call_id = p_call_id
$$;

revoke execute on function dialer_set(boolean, text), bot_call_started(text, text, text),
  bot_next_due(timestamptz, text[]), bot_mark_no_phone(text), bot_call_number(text) from public, anon, authenticated;
grant execute on function dialer_set(boolean, text), bot_call_started(text, text, text),
  bot_next_due(timestamptz, text[]), bot_mark_no_phone(text), bot_call_number(text) to service_role;
