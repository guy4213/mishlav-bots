/**
 * The bot's closing sentences: fixed, built by the server, said word for word (`say_he` in a tool response).
 * Gender-neutral on purpose, so the last thing the customer hears is never in the wrong gender, and no
 * creative goodbyes ("I'm ending the call", "pleasant payment").
 * Every one ends with GOODBYE: the phone line uses it to know the goodbye was already said.
 */
import { addDays, dateKey, toLocalParts, type EndCallReason } from "@mishlav/shared";

export const GOODBYE = "יום נעים, להתראות!";

export const SAY_LINK_SENT = `הקישור נשלח עכשיו במסרון. ${GOODBYE}`;
export const SAY_HANDED_TO_REP = `העברתי את הבקשה, נציג יחזור בהקדם. ${GOODBYE}`;

export const SAY_END_CALL: Record<Exclude<EndCallReason, "voicemail">, string> = {
  completed: `תודה רבה. ${GOODBYE}`,
  not_interested: `בסדר גמור, תודה רבה. ${GOODBYE}`,
  do_not_call: `בסדר, המספר הוסר מהרשימה. ${GOODBYE}`,
  already_registered: `מעולה, תודה רבה. ${GOODBYE}`,
  wrong_number: `סליחה על ההפרעה. ${GOODBYE}`,
};

/** "היום ב-12:23" / "מחר ב-10:00" / "ביום שלישי, 24 בנובמבר, ב-10:00" — as it is said on the phone. */
export function whenHe(t: Date, now: Date, tz: string): string {
  const p = toLocalParts(t, tz);
  const time = `${p.hour}:${String(p.minute).padStart(2, "0")}`;
  const today = toLocalParts(now, tz);
  if (dateKey(p) === dateKey(today)) return `היום ב-${time}`;
  if (dateKey(p) === dateKey(addDays(today, 1))) return `מחר ב-${time}`;
  const day = new Intl.DateTimeFormat("he-IL", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(t);
  return `ב${day}, ב-${time}`;
}

export const sayCallback = (t: Date, now: Date, tz: string) => `בסדר גמור, נדבר ${whenHe(t, now, tz)}. ${GOODBYE}`;
export const sayHandedToRepAt = (t: Date, now: Date, tz: string) =>
  `העברתי את הבקשה, נציג יחזור ${whenHe(t, now, tz)}. ${GOODBYE}`;
