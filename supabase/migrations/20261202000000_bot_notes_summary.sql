-- The bot's own notes summed up when they pile up (apps/backend/src/notes.ts, Guy 26.11): a summary line is ADDED at
-- the end of the contact's Gold notes - "[סיכום הבוט] DD.MM.YYYY HH:MM – ✓ ... · ✓ ...". Nothing is deleted or
-- overwritten; the reps' notes are never touched. Gold picks the change up like any bot line (gold_changed_at).
-- New function only: nothing is dropped.

create function bot_append_summary(p_id text, p_text text) returns void
language plpgsql set search_path = '' as $$
begin
  if coalesce(trim(p_text), '') = '' then return; end if;
  update public.contacts
     set notes = concat_ws(E'\n', nullif(notes, ''),
                           '[סיכום הבוט] ' || to_char(now() at time zone 'Asia/Jerusalem', 'DD.MM.YYYY HH24:MI') || ' – '
                           || regexp_replace(p_text, '[\r\n]+', ' ', 'g'))
   where gold_record_id = p_id;
  update public.bot_state set gold_changed_at = now() where gold_record_id = p_id;
end $$;
revoke execute on function bot_append_summary(text, text) from public, anon, authenticated;
grant execute on function bot_append_summary(text, text) to service_role;
