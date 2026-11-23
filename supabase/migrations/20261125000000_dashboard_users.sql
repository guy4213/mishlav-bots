-- Who may log in to the dashboard (apps/backend/src/users.ts): a phone number and a password per person.
--   admin   - us (the project team): everything, as TOOLS_SECRET does
--   mishlav - Mishlav's management and staff: calls, recordings, contacts, rep tasks, study days, a test call to
--             their own phone only. No logs, no dialer switch, no settings (apps/backend/src/access.ts).
-- Additive only. A user is never deleted: active = false blocks them (and their open sessions within a minute).
-- Changing the password (password_changed_at) ends the user's open sessions.

create table dashboard_users (
  id                  uuid primary key default gen_random_uuid(),
  phone               text not null unique check (phone ~ '^\+972\d{8,9}$'),   -- E.164, as toE164() writes it
  name                text not null check (length(trim(name)) > 0),
  role                text not null check (role in ('admin', 'mishlav')),
  password_hash       text not null,                                           -- scrypt$<salt>$<hash>, never the password
  active              boolean not null default true,
  password_changed_at timestamptz not null default now(),
  last_login_at       timestamptz,
  created_at          timestamptz not null default now()
);
comment on table dashboard_users is 'Dashboard logins (phone + password). Managed in the dashboard by an admin (משתמשים).';

alter table dashboard_users enable row level security;
revoke all on table dashboard_users from public, anon, authenticated;
grant select, insert, update on table dashboard_users to service_role;
