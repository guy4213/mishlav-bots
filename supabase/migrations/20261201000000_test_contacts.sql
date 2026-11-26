-- The automatic-dialing test (dashboard "בדיקות חיוג אוטומטי", admins): 10 made-up contacts in the SAME tables as
-- Gold's leads - so the test runs exactly the code that goes live - told apart by their id: gold_record_id 'TEST-..'.
-- They never mix with the real ones:
--   * the real dialer (bot_next_due_for), the dashboard queue (bot_queue) and summary, and the Gold feed
--     (gold_changes) leave every 'TEST-%' out;
--   * only the test dialer reads them (bot_next_due_tests), and it dials only the phone of the admin who started it
--     (apps/backend/src/test-dialer.ts) - a second lock that doesn't depend on any table.
-- bot_tests_reset(phone) puts the 10 back as they start (notes, status, queue), all on that phone.
-- Everything here is create-or-replace with the same signatures, or new: nothing is dropped.

create or replace function bot_next_due_for(p_now timestamptz, p_skip text[] default '{}', p_courses text[] default null)
returns table (gold_record_id text, bot_status public.contact_status, next_call_at timestamptz)
language sql stable set search_path = '' as $$
  select s.gold_record_id, s.bot_status, s.next_call_at
    from public.bot_state s
    join public.contacts c on c.gold_record_id = s.gold_record_id
   where s.bot_status in ('new', 'queued', 'callback')
     and s.gold_record_id not like 'TEST-%'
     and (s.next_call_at is null or s.next_call_at <= p_now)
     and not (s.gold_record_id = any (coalesce(p_skip, '{}')))
     and (coalesce(cardinality(p_courses), 0) = 0 or trim(c.requested_course) = any (p_courses))
   order by case s.bot_status when 'callback' then 0 when 'queued' then 1 else 2 end,
            s.next_call_at nulls last,
            s.gold_record_id
   limit 1
$$;

-- the test dialer: the same order, only the test contacts (no course filter: they are all test leads)
create function bot_next_due_tests(p_now timestamptz, p_skip text[] default '{}')
returns table (gold_record_id text, bot_status public.contact_status, next_call_at timestamptz)
language sql stable set search_path = '' as $$
  select s.gold_record_id, s.bot_status, s.next_call_at
    from public.bot_state s
   where s.bot_status in ('new', 'queued', 'callback')
     and s.gold_record_id like 'TEST-%'
     and (s.next_call_at is null or s.next_call_at <= p_now)
     and not (s.gold_record_id = any (coalesce(p_skip, '{}')))
   order by case s.bot_status when 'callback' then 0 when 'queued' then 1 else 2 end,
            s.next_call_at nulls last,
            s.gold_record_id
   limit 1
$$;
revoke execute on function bot_next_due_tests(timestamptz, text[]) from public, anon, authenticated;
grant execute on function bot_next_due_tests(timestamptz, text[]) to service_role;

create or replace function bot_queue(p_now timestamptz, p_courses text[] default null, p_limit int default 50)
returns table (gold_record_id text, due boolean)
language sql stable set search_path = '' as $$
  select q.gold_record_id, q.due
    from (select s.gold_record_id, s.bot_status, s.next_call_at,
                 (s.next_call_at is null or s.next_call_at <= p_now) as due
            from public.bot_state s
            join public.contacts c on c.gold_record_id = s.gold_record_id
           where s.bot_status in ('new', 'queued', 'callback')
             and s.gold_record_id not like 'TEST-%'
             and (coalesce(cardinality(p_courses), 0) = 0 or trim(c.requested_course) = any (p_courses))) q
   order by not q.due,
            case when q.due then case q.bot_status when 'callback' then 0 when 'queued' then 1 else 2 end else 0 end,
            q.next_call_at nulls last,
            q.gold_record_id
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

create or replace function gold_changes(p_since timestamptz default null) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'until', now(),
    'contacts', coalesce(jsonb_agg(to_jsonb(c) order by s.gold_changed_at, c.gold_record_id), '[]'::jsonb))
    from public.contacts c
    join public.bot_state s using (gold_record_id)
   where s.gold_changed_at is not null and (p_since is null or s.gold_changed_at > p_since)
     and c.gold_record_id not like 'TEST-%'
$$;

create or replace function dashboard_summary(p_day_start timestamptz, p_courses text[] default null) returns jsonb
language sql stable set search_path = '' as $$
  with today as (
    select k.outcome, k.answered from public.calls k where k.origin = 'dialer' and k.started_at >= p_day_start
  ),
  statuses as (
    select s.bot_status::text as status, count(*)::int as n from public.bot_state s
     where s.gold_record_id not like 'TEST-%' group by s.bot_status
  ),
  dialable as (
    select s.gold_record_id, s.bot_status, s.next_call_at
      from public.bot_state s
      join public.contacts c on c.gold_record_id = s.gold_record_id
     where s.bot_status in ('new', 'queued', 'callback')
       and s.gold_record_id not like 'TEST-%'
       and (coalesce(cardinality(p_courses), 0) = 0 or trim(c.requested_course) = any (p_courses))
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
    'contacts_total', (select count(*) from public.bot_state s where s.gold_record_id not like 'TEST-%'),
    'dialable_total', (select count(*) from dialable),
    'due_now', (select count(*) from dialable d where d.next_call_at is null or d.next_call_at <= now()),
    'open_rep_tasks', (select count(*) from public.rep_tasks t where not t.done and t.gold_record_id not like 'TEST-%'),
    'next_due', coalesce((select jsonb_agg(jsonb_build_object('gold_record_id', q.gold_record_id, 'full_name', c.full_name,
                                                              'bot_status', s.bot_status, 'next_call_at', s.next_call_at)
                                           order by q.n)
                            from public.bot_queue(now(), p_courses, 5) with ordinality as q(gold_record_id, due, n)
                            join public.contacts c on c.gold_record_id = q.gold_record_id
                            join public.bot_state s on s.gold_record_id = q.gold_record_id), '[]'::jsonb)
  )
$$;

-- The 10 test contacts, as they start: Gold's format, all on p_phone, each with notes for one situation to check
-- (the bot reads the end of the notes on every call). Their rep tasks go; their calls stay (the test's history).
create function bot_tests_reset(p_phone text) returns int
language plpgsql set search_path = '' as $$
declare
  v_n int;
begin
  if coalesce(trim(p_phone), '') = '' then raise exception 'bot_tests_reset: a phone is required'; end if;
  delete from public.rep_tasks where gold_record_id like 'TEST-%';
  insert into public.contacts (gold_record_id, full_name, phone, phone2, phone3, email, company, city, notes,
                               department, requested_course, source, status)
  select t.id, t.name, p_phone, null, null, null, null, null, t.notes, 'ימי עיון', 'יום עיון חשבונאות', 'בדיקה', null
    from (values
      ('TEST-01', 'גיא כהן',     null),
      ('TEST-02', 'דנה לוי',     'התעניינה ביום עיון בזום בנובמבר 2027. ביקשה שיחזרו אליה ב-12:00 בצהריים.'),
      ('TEST-03', 'יוסי אברהם',  'מעדיף יום עיון פרונטלי במלון. לא זמין בבקרים.'),
      ('TEST-04', 'מיכל ברק',    'שאלה על ההטבה של 300 ש"ח למי שנרשם לשני ימי עיון.'),
      ('TEST-05', 'אבי דוד',     'כבר נרשם ליום העיון של פברואר 2027.'),
      ('TEST-06', 'רונית שמש',   'החברה משלמת. ביקשה לדבר עם נציג על תשלום דרך החברה.'),
      ('TEST-07', 'עומר פרץ',    'לא ענה פעמיים.'),
      ('TEST-08', 'שירה אלון',   'מתעניינת בביטוח לאומי ופנסיה, רק בזום.'),
      ('TEST-09', 'משה גולן',    'ביקש שלא יתקשרו אליו יותר.'),
      ('TEST-10', 'נועם שגיא',   null)
    ) as t(id, name, notes)
  on conflict (gold_record_id) do update
     set full_name = excluded.full_name, phone = excluded.phone, phone2 = null, phone3 = null, notes = excluded.notes,
         department = excluded.department, requested_course = excluded.requested_course, source = excluded.source,
         status = null;
  -- the queue as for a new lead (the insert trigger made the rows of new ones)
  insert into public.bot_state (gold_record_id) select c.gold_record_id from public.contacts c
   where c.gold_record_id like 'TEST-%' on conflict do nothing;
  update public.bot_state
     set bot_status = 'new', attempts = 0, no_answer_streak = 0, ever_answered = false, next_call_at = null,
         callback_at = null, last_call_at = null, last_outcome = null, phone_index = 1, interested_day_id = null,
         customer_gender = null, gold_changed_at = null
   where gold_record_id like 'TEST-%';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function bot_tests_reset(text) from public, anon, authenticated;
grant execute on function bot_tests_reset(text) to service_role;

-- One call per number - but the 10 test contacts share the tester's phone on purpose: a test contact is never a
-- duplicate, and a real contact is never one because of a test call. Otherwise as 20261129000000_dialer_phones.sql.
create or replace function bot_mark_duplicate(p_gold_record_id text, p_number text) returns text
language plpgsql set search_path = '' as $$
declare
  v_other text;
  v_new   public.contact_status;
begin
  if p_gold_record_id like 'TEST-%' then
    return null;
  end if;
  select k.gold_record_id into v_other
    from public.calls k
   where k.number = p_number and k.gold_record_id is not null and k.gold_record_id <> p_gold_record_id
     and k.gold_record_id not like 'TEST-%'
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
