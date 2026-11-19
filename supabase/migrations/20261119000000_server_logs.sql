-- The dashboard's live log, kept: every line of the server's log (the phone line, the dialer, tools, errors, SMS
-- and the server's own output) so a deploy or a restart doesn't wipe it. The backend writes in batches and deletes
-- lines older than 14 days. Lines of real calls hold what customers said: RLS on, service role only.
create table server_logs (
  id      bigint generated always as identity primary key,
  boot    text not null,          -- one server start (a deploy / restart): the dashboard reads older boots from here
  seq     int not null,           -- the line's number within its boot
  ts      timestamptz not null,
  kind    text not null,          -- line / dialer / tool / error / sms / server
  call_id text,
  text    text not null
);
create index server_logs_ts on server_logs (ts desc);
create index server_logs_call on server_logs (call_id) where call_id is not null;
alter table server_logs enable row level security;
comment on table server_logs is 'The server log shown in the dashboard, kept 14 days (apps/backend/src/serverlog.ts)';
