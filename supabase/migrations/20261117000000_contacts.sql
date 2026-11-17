-- Mishlav study-day bot: the contacts the bot calls (from the Gold CRM export), its calls, and the tasks it
-- leaves for the reps. The backend uses the service role; RLS is on with no policies, so the public API keys
-- see nothing. Gold CRM later reads the changes through the Export Feed (updated_at).

create type contact_status as enum (
  'new',                 -- imported, not called yet
  'queued',              -- waiting for a dial (next_call_at)
  'in_call',
  'link_sent',
  'callback',            -- the customer asked to be called back (callback_at)
  'hot_lead',            -- a rep should call back (wants a person, discount, another course, pays via a rep)
  'company',             -- the company pays: a rep handles it
  'human_followup',      -- an open question for a rep; the call went on
  'not_interested',
  'already_registered',
  'do_not_call',
  'wrong_number',
  'voicemail',
  'no_answer',
  'closed_max_attempts'
);

create table contacts (
  id               uuid primary key default gen_random_uuid(),
  -- from the Gold export (one column each, same names as config/settings.yaml gold_import.columns)
  gold_record_id   text not null unique,      -- the unnamed first column
  national_id      text,                      -- ת.ז
  company          text,                      -- חברה
  full_name        text,                      -- שם מלא
  first_name       text,                      -- derived from full_name at import
  email            text,                      -- אימייל
  phone            text,                      -- טלפון (as in the file)
  phone2           text,                      -- טלפון 2
  phone3           text,                      -- טלפון 3
  phone_e164       text,                      -- normalized dial number (+972...) of the phone in use
  gold_notes       text,                      -- הערות
  city             text,                      -- עיר
  address          text,                      -- כתובת
  address2         text,                      -- כתובת 2
  department       text,                      -- מחלקה
  requested_course text,                      -- קורס מבוקש
  source           text,                      -- מקור
  gold_status      text,                      -- סטטוס
  -- the bot's side
  status           contact_status not null default 'new',
  interested_day_id text,                     -- a day_id from the catalogue, when known
  customer_gender  text check (customer_gender in ('male', 'female', 'unknown')),
  attempts         int not null default 0,
  next_call_at     timestamptz,
  callback_at      timestamptz,
  last_call_at     timestamptz,
  last_outcome     text,
  bot_notes        text,                      -- what the bot wrote; Gold sees it as a "[BOT] ..." note
  imported_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index contacts_due on contacts (status, next_call_at);
create index contacts_updated on contacts (updated_at);

create table calls (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contacts (id) on delete cascade,
  call_id      text not null unique,          -- the voice layer's call id
  started_at   timestamptz not null default now(),
  duration_sec int,
  outcome      text,
  reason       text,
  summary      text
);
create index calls_contact on calls (contact_id, started_at desc);

-- "A rep should call this lead back" (request_human): the note the reps work from
create table rep_tasks (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contacts (id) on delete cascade,
  call_id      text,
  reason       text not null,                 -- wants_human, pay_via_rep, company_purchase, discount_request, course_interest, other
  callback_at  timestamptz,                   -- when the customer asked the rep to call (null = as soon as possible)
  note         text,
  done         boolean not null default false,
  created_at   timestamptz not null default now()
);
create index rep_tasks_open on rep_tasks (done, callback_at);

create function touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger contacts_touch before update on contacts for each row execute function touch_updated_at();

alter table contacts enable row level security;
alter table calls enable row level security;
alter table rep_tasks enable row level security;
