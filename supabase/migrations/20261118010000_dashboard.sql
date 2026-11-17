-- The management dashboard (apps/backend/dashboard, routes/admin.ts). Additive only: the server deployed from main
-- keeps working (it never reads or writes these).
--
--   calls.transcript    the call's transcript, stored at its end (the server's disk is lost on every deploy):
--                       [{ts, role: user|assistant, text}], card numbers (13-19 digits) already removed
--   dashboard_summary   the overview screen in one call: today's dialer calls, the contacts' funnel, the queue

alter table calls add column transcript jsonb;
comment on column calls.transcript is
  'The call transcript [{ts, role, text}] written by the backend when the call ends; card numbers removed before storing';

-- p_day_start: midnight today in the business time zone (the backend computes it). Counts only the dialer's calls
-- (origin = 'dialer'); dashboard tests are counted apart (manual_total).
create function dashboard_summary(p_day_start timestamptz) returns jsonb
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
                           where status in ('not_interested', 'already_registered', 'do_not_call', 'wrong_number', 'closed_max_attempts')), 0)
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

revoke execute on function dashboard_summary(timestamptz) from public, anon, authenticated;
grant execute on function dashboard_summary(timestamptz) to service_role;
