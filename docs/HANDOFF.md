# Handoff — the phone bot after the night of 23–24 Nov 2026 (v1.8)

For the next session (cloud). Read `CLAUDE.md` first: answer Guy **in Hebrew**, short; fix the bot with context
(catalogue, tool answers, prompt facts) and deterministic code, not word lists; check yourself before saying something
works; commit/push only when he asks; **every push to main raises `package.json` version by 0.1** (admins see
"גרסה vX.Y" in the dashboard — that is how Guy knows Render deployed).

## Where things stand

Production: Render (auto-deploys `main`), Supabase (shared by local + Render), Zadarma SIP line → Gemini Live
`gemini-3.1-flash-live-preview` (`apps/phone`). Dashboard logins work (users table `dashboard_users`: admins Guy, Yair;
Mishlav users Eden, Ofer, Anat, Yehuda, Amit — temporary passwords, they should change them).

**The reference call** — Guy, 24.11 ~02:30, v1.8, "the best call so far". This is what good sounds like; keep it that way:

```
בוט:  היי גיא, כאן נועה, נציגת הבינה המלאכותית של מכללת מישלב. מה נשמע?        ← played 0.3 s after his "הלו"
לקוח: כמו, אלן.
בוט:  אני מתקשרת בהמשך להתעניינות בימי העיון בחשבונאות. זה זמן טוב לדבר?
לקוח: כן...
בוט:  מעולה. יש לנו ימי עיון לאורך כל השנה, בנושאים הכי חמים של שכר וחשבונאות. מה נוח לך יותר – זום או יום במלון?
לקוח: אני רוצה את היום עיון הכי קרוב שיש לכם.
בוט:  הכי קרוב שיש זה ב-21 וב-22 בפברואר, בזום, בנושא דיני עבודה ומס הכנסה. זה מתאים לך?
לקוח: אני אבל רוצה לשמוע יותר פרטים, מי המרצים? כאילו תן לי את כל הפרטים בבקשה.
בוט:  בשמחה. יום העיון בזום מתקיים ב-21 וב-22 בפברואר, מהשעה עשר בבוקר עד אחת ורבע בצהריים בכל מפגש. הנושאים הם
      דיני עבודה ומס הכנסה, והמרצים הם מיקי בן דב ואפי נדיב. המחיר הוא 370 שקלים כולל מע"מ. לשלוח לך קישור להרשמה?
לקוח: רגע, שנייה אחת, אין אפשרות להנחה כאן?
בוט:  אני מבינה, לגבי הנחה נציג יצטרך לחזור אליך. מתי נוח שיתקשרו?
לקוח: למה? אתה לא יכול לעשות לי הנחה?
בוט:  אני מבינה, אבל אני לא יכולה לתת הנחות. נציג יחזור אליך לגבי זה, רק תגיד מתי נוח שיתקשרו.
לקוח: ...מחר ב-12:30.
בוט:  העברתי את הבקשה, נציג יחזור מחר בשתים עשרה וחצי בצהריים. יום נעים, להתראות!         ← once, then the line hangs up
```

What makes it good: instant opening; one general sentence, then one easy question (Zoom / hotel); "the nearest" = one
date; all details in one answer with real data (dates in words, hours in words, lecturers, price); one discount
refusal, no haggling, one question ("when?"), the fixed closing sentence once.

## What changed tonight, and why (lessons — don't undo these)

| Ver | Change | Why |
|---|---|---|
| — | Step 2 of the flow: picture → "זום או מלון?" → one offer (the nearest of that group) | listing dates/topics confused callers |
| — | Catalogue (`buildDayCatalog`, context.ts) carries dates, hours, place, price, **lecturers** | every tool call on the phone is a silence |
| — | Hours and dates **in spoken Hebrew** in the catalogue / `structure_he` (`timeRangeHe`, `spokenDatesHe`) | given "13:15" the bot read the digits |
| v1.0 | "לפי נושא" index in the catalogue (each topic → its days, Zoom/hotel, "רק בזום") | it searched the list and invented a hotel day with national insurance |
| v1.2 | Gender classifier: `gemini-3.1-flash-lite` + `gemini-flash-lite-latest` raced, one retry | `gemini-2.5-flash-lite` is gone (404) → every call was gender-neutral |
| v1.5 | **Opening made while ringing** (warm-up turn) and played 0.3 s after the "הלו" (`_playOpening`, call-agent.js) | 5 s from pick-up to the real opening; a "הלו" cut it |
| v1.7–1.8 | **Never speech + a tool call in the same answer.** No "רגע, אני בודקת", no end_call after a closing sentence (the line hangs up by itself) | Gemini Live then repeated the sentence (twice), or said "I'm checking", called nothing and **made up lecturers** |
| v1.8 | `note` on request_human / schedule_callback → `rep_tasks.note` + the bot's Gold note line (migration `20261126000000_tool_note.sql`, applied) | reps saw "בקשת הנחה" but not what the customer asked |
| v1.8 | Follow-up calls get the end of the contact's Gold notes in `customer_context` (`recentNotes`, dial.ts) + prompt step 0 | the bot knew nothing about earlier calls |

The pattern behind most fixes: **the model is good at talking, bad at searching/computing/announcing.** Precompute in
code what it must say exactly; give it the answer, not the data to search.

## Open — in this order

1. **Purchase links + course numbers** for the 8 study days are empty (`study_days`, dashboard tab "ימי עיון"). Until
   filled, "send me the link" always ends with "a rep will call with the link". This blocks launch. Mishlav's data — ask Guy.
2. **Verify v1.8 on real calls** (Guy calls; you read logs): the follow-up path and the notes need a **contact in the
   DB** (dashboard "לקוחות" → dial), not "שיחת בדיקה אליי" (a manual number writes nothing to Supabase).
   Check: rep task "הערה" filled; Gold note line ends with the note; a second call to the same contact picks up
   ("חזרתי אליך כמו שביקשת…").
3. Not yet checked on a real call: voicemail with the new opening (a long greeting → the made-in-advance opening is
   dropped, Gemini hears it all → `end_call voicemail`); a callee who says nothing (opening plays after 1.3 s).
4. `GOLD_API_KEY` isn't set on Render → Gold's `/api/gold/changes` is off.
5. Options discussed, not done: `gemini-3.8-live` (supports non-blocking tools; untested on this line); answer-speed
   tuning (`DEFAULT_SILENCE_MS` 500 → 300). Guy chose to keep the current model for now.
6. Text runs (`npm run text:all`) don't run here: no Gemini quota on the local key. Real calls are the test now.
7. Small debt: hours-in-words exists twice (`closings.ts` minutesHe/HOURS_HE and `knowledge.ts` timeHe) — merge.

## How to check a call (no dashboard needed)

The server's log lines are kept in Supabase `server_logs` (14 days), Render's too:

```bash
supabase db query --linked "select to_char(ts at time zone 'Asia/Jerusalem','HH24:MI:SS') t, left(text,200) txt
  from server_logs where ts > now() - interval '20 minutes' order by ts, seq;"
```

Useful lines: `opening made while ringing, played …ms after the callee's hello`, `first answer: …ms`,
`🔧 tool(args) → result`, `latency: N turns, median …ms`, `call phone-…: first_name X (גבר/אישה/מגדר לא ידוע)`,
`gender of "X" unknown: …` (classifier failure), a Render start = a `logs: /opt/render…` line (deploy done).
Bot lines joined like `…להתראות!העברתי…` (punctuation glued to the next word) = Gemini repeated itself.

Rules that still hold: no ElevenLabs runs without asking; never print `.env`; real call recordings/transcripts are
personal data (no external services); vitest from `C:\Users\...` (capital C) on Windows.
