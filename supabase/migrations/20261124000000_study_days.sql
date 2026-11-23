-- The study days (ימי עיון): Mishlav edits them in the dashboard ("ימי עיון"), the bot reads them every minute
-- (apps/backend/src/study-days.ts). Replaces the files config/knowledge/days/*.md.
-- Additive only: a server deployed before this change keeps reading its files.
--
-- A day is never deleted: archived_at hides it from the bot, while bot_state.interested_day_id and the notes in Gold
-- can still name it. The id is set once, from the first date and the format (2027-02-21-zoom).

create table study_days (
  id                    text primary key check (id ~ '^[a-z0-9-]+$'),
  title                 text not null,
  topic                 text not null,
  date                  date not null,
  end_date              date,            -- zoom: the second meeting of the same study day
  start_time            text not null check (start_time ~ '^\d{2}:\d{2}$'),
  end_time              text not null check (end_time ~ '^\d{2}:\d{2}$' and end_time > start_time),
  format                text not null check (format in ('zoom', 'hotel')),
  series                text check (series ~ '^[a-z0-9-]+$'),   -- same series = same content; null: its own id
  location              text not null,
  price_ils             numeric(10, 2) not null check (price_ils > 0),
  vat_included          boolean not null default true,
  open_for_registration boolean not null default true,
  course_number         text,
  purchase_url          text check (purchase_url ~ '^https://'),
  lecturers             text[] not null default '{}',
  academic_hours        numeric(4, 1) check (academic_hours > 0),
  description           text not null default '',
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- a Zoom study day is ONE study day in two meetings; a hotel day is one day
  constraint study_days_meetings check (
    (format = 'zoom' and end_date is not null and end_date > date) or (format = 'hotel' and end_date is null)
  )
);
comment on table study_days is 'The study days the bot offers (dashboard: ימי עיון). archived_at set: hidden from the bot.';
comment on column study_days.academic_hours is 'Academic hours for the CPA chamber requirement (Mishlav''s number, not clock hours)';
comment on column study_days.course_number is 'Mishlav''s course number (what the reps register in Gold); goes into the bot''s note';

alter table study_days enable row level security;
revoke all on table study_days from public, anon, authenticated;
grant select, insert, update on table study_days to service_role;

-- The yellow page 2027 (docs/yellow-page-2027.md). Course numbers and purchase links are not on it: filled in the dashboard.
insert into study_days (id, title, topic, date, end_date, start_time, end_time, format, location, price_ils, lecturers, academic_hours) values
  ('2027-02-21-zoom',  'דיני עבודה ומס הכנסה',                'דיני עבודה ומס הכנסה',                '2027-02-21', '2027-02-22', '10:00', '13:15', 'zoom',  'בזום', 370, '{"מיקי בן דב","אפי נדיב"}', 7.5),
  ('2027-03-17-zoom',  'ביטוח לאומי וביטוח פנסיוני',          'ביטוח לאומי וביטוח פנסיוני',          '2027-03-17', '2027-03-18', '10:00', '13:15', 'zoom',  'בזום', 370, '{"שי עופרי","דנה להב"}', 7.5),
  ('2027-05-17-hotel', 'דיני עבודה ומס הכנסה',                'דיני עבודה ומס הכנסה',                '2027-05-17', null,         '09:00', '16:00', 'hotel', 'מלון דן פנורמה, תל אביב', 790, '{"מיקי בן דב","אפי נדיב"}', 7.5),
  ('2027-06-21-zoom',  'מס הכנסה וביטוח לאומי',               'מס הכנסה וביטוח לאומי',               '2027-06-21', '2027-06-22', '10:00', '13:15', 'zoom',  'בזום', 370, '{"אפי נדיב","בועז גבאי"}', 7.5),
  ('2027-07-20-zoom',  'דיני עבודה, AI ובקרות שכר',           'דיני עבודה, AI ובקרות שכר',           '2027-07-20', '2027-07-21', '10:00', '13:15', 'zoom',  'בזום', 370, '{"מיקי בן דב","הילה אהרוני"}', 7.5),
  ('2027-09-21-zoom',  'ביטוח לאומי וביטוח פנסיוני',          'ביטוח לאומי וביטוח פנסיוני',          '2027-09-21', '2027-09-22', '10:00', '13:15', 'zoom',  'בזום', 370, '{"אורנה צח","שי עופרי"}', 7.5),
  ('2027-11-21-hotel', 'דיני עבודה, מס הכנסה וביטוח פנסיוני', 'דיני עבודה, מס הכנסה וביטוח פנסיוני', '2027-11-21', null,         '09:00', '16:00', 'hotel', 'מלון דן פנורמה, תל אביב', 790, '{"מיקי בן דב","אפי נדיב או אהרון ויזל","שי עופרי"}', 7.5),
  ('2027-12-20-zoom',  'דיני עבודה וביטוח לאומי',             'דיני עבודה וביטוח לאומי',             '2027-12-20', '2027-12-21', '10:00', '13:15', 'zoom',  'בזום', 370, '{"מיקי בן דב","אורנה צח"}', 7.5)
on conflict (id) do nothing;
