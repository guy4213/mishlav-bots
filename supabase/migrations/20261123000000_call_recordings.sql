-- Call recordings: every call is recorded (one channel, both voices) and kept in a PRIVATE Storage bucket. Only the
-- backend (service role) reads and writes it; the dashboard gets an hour-long signed link per recording.
-- Recordings hold what customers said: deleted after settings.yaml recordings.retention_days (the backend).
insert into storage.buckets (id, name, public) values ('recordings', 'recordings', false)
on conflict (id) do nothing;

alter table calls add column recording_path text;
comment on column calls.recording_path is 'The call''s recording in Storage (bucket recordings); null: not recorded or deleted';
