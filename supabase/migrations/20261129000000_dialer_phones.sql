-- The dialer checks a contact's phone before it dials (apps/backend/src/dialer.ts, contacts.ts pickPhone). The real
-- Gold export (5,298 study-day leads) has placeholder phones (050-0000000), empty phone 1 with a good phone 2, and
-- the same person twice or three times (the same number on two records).
--
--   bot_use_phone       phone 1 is empty / invalid / a placeholder: dial phone 2 (or 3) from now on. Kept in
--                       bot_state.phone_index, so the purchase-link SMS (bot_call_number), the rep tasks and a later
--                       wrong number follow the phone actually called. A note in Gold says which phone was bad.
--   bot_mark_duplicate  one call per number: a number already called on another contact -> this one is closed as
--                       'duplicate' (a note in Gold names the other record; Gold's status stays as it is).
--   dashboard_summary   'duplicate' counts as closed in the funnel. Otherwise the same as 20261118010000_dashboard.
-- Additive: the server on the previous version never calls the new functions.

alter type contact_status add value if not exists 'duplicate';  -- used only inside function bodies (run later)

create function bot_use_phone(p_gold_record_id text, p_phone_index int) returns void
language plpgsql set search_path = '' as $$
declare
  v_state public.bot_state;
  v_bad   text;
begin
  select * into v_state from public.bot_state where gold_record_id = p_gold_record_id;
  if not found or v_state.phone_index = p_phone_index or v_state.bot_status in ('in_call', 'do_not_call') then
    return;
  end if;
  select case v_state.phone_index when 1 then c.phone when 2 then c.phone2 else c.phone3 end into v_bad
    from public.contacts c where c.gold_record_id = p_gold_record_id;
  update public.bot_state set phone_index = p_phone_index where gold_record_id = p_gold_record_id;
  perform public.bot_write_gold(p_gold_record_id, v_state.bot_status,
    case v_state.phone_index when 1 then 'טלפון' else 'טלפון ' || v_state.phone_index end
      || coalesce(' (' || nullif(trim(v_bad), '') || ')', ' ריק') || ' לא תקין – מחייגים לטלפון ' || p_phone_index);
end $$;

create function bot_mark_duplicate(p_gold_record_id text, p_number text) returns text
language plpgsql set search_path = '' as $$
declare
  v_other text;
  v_new   public.contact_status;
begin
  select k.gold_record_id into v_other
    from public.calls k
   where k.number = p_number and k.gold_record_id is not null and k.gold_record_id <> p_gold_record_id
   order by k.started_at
   limit 1;
  if v_other is null then
    return null;
  end if;
  update public.bot_state
     set bot_status = 'duplicate', next_call_at = null, last_outcome = 'DUPLICATE'
   where gold_record_id = p_gold_record_id and bot_status not in ('in_call', 'do_not_call')
  returning bot_status into v_new;
  if v_new is not null then
    perform public.bot_write_gold(p_gold_record_id, v_new,
      'כפול: המספר כבר חויג ברשומה ' || v_other || ' – לא מחייגים שוב');
  end if;
  return v_other;
end $$;

create index if not exists calls_number_idx on calls (number);

create or replace function dashboard_summary(p_day_start timestamptz) returns jsonb
language sql stable set search_path = '' as $$
  with today as (
    select k.outcome, k.answered from public.calls k where k.origin = 'dialer' and k.started_at >= p_day_start
  ),
  statuses as (
    select s.bot_status::text as status, count(*)::int as n from public.bot_state s group by s.bot_status
  ),
  queue as (
    select s.gold_record_id, c.full_name, s.bot_status::text as bot_status, s.next_call_at,
           -- the order the dialer takes them (bot_next_due): due now first, callbacks, retries, new; then by time
           row_number() over (order by (s.next_call_at is not null and s.next_call_at > now()),
                                       case s.bot_status when 'callback' then 0 when 'queued' then 1 else 2 end,
                                       s.next_call_at nulls last, s.gold_record_id) as rn
      from public.bot_state s
      join public.contacts c on c.gold_record_id = s.gold_record_id
     where s.bot_status in ('new', 'queued', 'callback')
  )
  select jsonb_build_object(
    'day_start', p_day_start,
    'today', jsonb_build_object(
      'total', (select count(*) from today),
      'answered', (select count(*) from today where answered),
      'no_result', (select count(*) from today where outcome is null),
      'outcomes', coalesce((select jsonb_object_agg(o.outcome, o.n)
                              from (select outcome, count(*) as n from today where outcome is not null group by outcome) o),
                           '{}'::jsonb),
      'manual_total', (select count(*) from public.calls k where k.origin = 'manual' and k.started_at >= p_day_start)
    ),
    'funnel', jsonb_build_object(
      'new', coalesce((select sum(n) from statuses where status = 'new'), 0),
      'in_queue', coalesce((select sum(n) from statuses where status in ('queued', 'callback', 'in_call', 'voicemail', 'no_answer')), 0),
      'handled', coalesce((select sum(n) from statuses where status in ('link_sent', 'hot_lead', 'company', 'human_followup')), 0),
      'closed', coalesce((select sum(n) from statuses
                           where status in ('not_interested', 'already_registered', 'do_not_call', 'wrong_number',
                                            'closed_max_attempts', 'duplicate')), 0)
    ),
    'by_status', coalesce((select jsonb_object_agg(status, n) from statuses), '{}'::jsonb),
    'contacts_total', (select count(*) from public.bot_state),
    'due_now', (select count(*) from public.bot_state s
                 where s.bot_status in ('new', 'queued', 'callback') and (s.next_call_at is null or s.next_call_at <= now())),
    'open_rep_tasks', (select count(*) from public.rep_tasks t where not t.done),
    'next_due', coalesce((select jsonb_agg(jsonb_build_object('gold_record_id', q.gold_record_id, 'full_name', q.full_name,
                                                              'bot_status', q.bot_status, 'next_call_at', q.next_call_at)
                                           order by q.rn)
                            from queue q where q.rn <= 5), '[]'::jsonb)
  )
$$;

revoke execute on function bot_use_phone(text, int), bot_mark_duplicate(text, text) from public, anon, authenticated;
grant execute on function bot_use_phone(text, int), bot_mark_duplicate(text, text) to service_role;
