-- The bot's voice, picked by the team in the dashboard (סקירה → קול הבוט). One of the phone line's Gemini voices
-- (apps/phone/src/voices.js); null: the server's PHONE_VOICE. Every call from the next one on uses it.
alter table dialer_control add column voice text;
comment on column dialer_control.voice is 'The Gemini voice for every call (dashboard); null: PHONE_VOICE';
