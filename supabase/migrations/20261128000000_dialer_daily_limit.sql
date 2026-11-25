-- Pilot: at most this many automatic calls a day (admins set it in the dashboard's סקירה). The dialer stops for the
-- day once it reached it and goes on the next morning. null: no limit. Dashboard test calls don't count.
alter table dialer_control add column daily_limit int check (daily_limit > 0);
comment on column dialer_control.daily_limit is 'Max automatic (dialer) calls a day; null = no limit (admins, dashboard)';
