-- The deployed server now calls bot_call_ended(text, int, timestamptz[], int, int) (20261117030000_no_answer_streak.sql).
-- The old overload, kept only for the server that ran before it, goes.
drop function if exists bot_call_ended(text, int, int, int);
