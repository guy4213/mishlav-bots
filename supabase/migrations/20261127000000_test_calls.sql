-- Test calls in the call history, with their recordings: a call to a typed number (dashboard "בדיקות"), a team
-- member's "שיחה אליי" and an incoming call have no contact, so until now they left nothing once the server's disk was
-- gone (every deploy) - no transcript, no recording, not in the list. Now each is a calls row of its own:
-- gold_record_id null, origin 'manual' (a dashboard test, counted in dashboard_summary's manual_total).
-- Every call also keeps the number it was on and who the bot talked to, so the dashboard lists name + phone.
-- The functions that follow a contact (bot_tool_event, bot_call_number) already do nothing for a call without one.
alter table calls alter column gold_record_id drop not null;
alter table calls add column number text;
alter table calls add column contact_name text;
alter table calls add column direction text not null default 'out' check (direction in ('in', 'out'));
alter table calls add column scenario text;

comment on column calls.gold_record_id is 'The contact the call was with; null: a test call without a contact (a typed number, "שיחה אליי", an incoming call)';
comment on column calls.number is 'The number the call was on (+972...): the one dialed, or the caller''s on an incoming call';
comment on column calls.contact_name is 'Who the bot talked to on a call without a contact (the name it was given); a contact''s call: contacts.full_name';
comment on column calls.direction is 'out: the bot dialed; in: someone called the line';
comment on column calls.scenario is 'The test scenario the call ran with (dashboard tests), if any';
