-- The dashboard with the real leads (5,298 contacts, 4,214 of them in the course the dialer calls):
--
--   bot_queue           the next contacts the dialer will call, in its order (bot_next_due_for: due now first -
--                       callbacks, retries, new - then the ones whose time is ahead, by time), only the courses it
--                       calls. The contacts screen's "הבאים בתור" reads it, so nobody pages through 5,000 rows.
--   dashboard_summary   takes the same course list: "לחיוג עכשיו" and the overview's queue counted and listed every
--                       contact (solar systems too), not the ones the dialer calls. p_courses defaults to null
--                       (everyone), so the server on the previous version, which sends only p_day_start, still works.
--                       Otherwise the same as 20261129000000_dialer_phones.

create function bot_queue(p_now timestamptz, p_courses text[] default null, p_limit int default 50)
returns table (gold_record_id text, due boolean)
language sql stable set search_path = '' as $$
  select q.gold_record_id, q.due
    from (select s.gold_record_id, s.bot_status, s.next_call_at,
                 (s.next_call_at is null or s.next_call_at <= p_now) as due
            from public.bot_state s
            join public.contacts c on c.gold_record_id = s.gold_record_id
           where s.bot_status in ('new', 'queued', 'callback')
             and (coalesce(cardinality(p_courses), 0) = 0 or trim(c.requested_course) = any (p_courses))) q
   order by not q.due,
            case when q.due then case q.bot_status when 'callback' then 0 when 'queued' then 1 else 2 end else 0 end,
            q.next_call_at nulls last,
            q.gold_record_id
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

drop function dashboard_summary(timestamptz);
create function dashboard_summary(p_day_start timestamptz, p_courses text[] default null) returns jsonb
language sql stable set search_path = '' as $$
  with today as (
    select k.outcome, k.answered from public.calls k where k.origin = 'dialer' and k.started_at >= p_day_start
  ),
  statuses as (
    select s.bot_status::text as status, count(*)::int as n from public.bot_state s group by s.bot_status
  ),
  dialable as (
    select s.gold_record_id, s.bot_status, s.next_call_at
      from public.bot_state s
      join public.contacts c on c.gold_record_id = s.gold_record_id
     where s.bot_status in ('new', 'queued', 'callback')
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
    'contacts_total', (select count(*) from public.bot_state),
    'dialable_total', (select count(*) from dialable),
    'due_now', (select count(*) from dialable d where d.next_call_at is null or d.next_call_at <= now()),
    'open_rep_tasks', (select count(*) from public.rep_tasks t where not t.done),
    'next_due', coalesce((select jsonb_agg(jsonb_build_object('gold_record_id', q.gold_record_id, 'full_name', c.full_name,
                                                              'bot_status', s.bot_status, 'next_call_at', s.next_call_at)
                                           order by q.n)
                            from public.bot_queue(now(), p_courses, 5) with ordinality as q(gold_record_id, due, n)
                            join public.contacts c on c.gold_record_id = q.gold_record_id
                            join public.bot_state s on s.gold_record_id = q.gold_record_id), '[]'::jsonb)
  )
$$;

revoke execute on function bot_queue(timestamptz, text[], int), dashboard_summary(timestamptz, text[]) from public, anon, authenticated;
grant execute on function bot_queue(timestamptz, text[], int), dashboard_summary(timestamptz, text[]) to service_role;
