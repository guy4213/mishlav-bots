/**
 * The bot's closing sentences: fixed, built by the server, said word for word (`say_he` in a tool response).
 * Gender-neutral on purpose, so the last thing the customer hears is never in the wrong gender, and no
 * creative goodbyes ("I'm ending the call", "pleasant payment").
 * Every one ends with GOODBYE: the phone line uses it to know the goodbye was already said.
 */
import { addDays, dateKey, toLocalParts, type EndCallReason } from "@mishlav/shared";

// a period, not "!": with "!" the bot said "להתראות" rising, like a question (Guy, 24.11)
export const GOODBYE = "יום נעים, להתראות.";

// the link goes only by WhatsApp (Mishlav: never by SMS). Said only once Texter confirmed it (or failed): while it
// goes out the bot says SAY_LINK_SENDING and waits for the server's update (routes/tools.ts -> line.notify)
export const SAY_LINK_SENDING = "אני שולחת לך עכשיו את הקישור בוואטסאפ, רק רגע.";
export const SAY_LINK_SENT = `הקישור נשלח אליך בוואטסאפ. ${GOODBYE}`;
export const SAY_LINK_FAILED = `הייתה תקלה בשליחת הקישור, נציג יחזור אליך איתו בהקדם. ${GOODBYE}`;
export const SAY_HANDED_TO_REP = `העברתי את הבקשה, נציג יחזור בהקדם. ${GOODBYE}`;

export const SAY_END_CALL: Record<Exclude<EndCallReason, "voicemail">, string> = {
  // one short sentence each: a reaction before it plus a long goodbye sounded like a machine (R2)
  completed: `תודה, ${GOODBYE}`,
  not_interested: `בסדר גמור, ${GOODBYE}`,
  do_not_call: `בסדר, המספר הוסר מהרשימה. ${GOODBYE}`,
  already_registered: `מעולה, ${GOODBYE}`,
  wrong_number: `סליחה על ההפרעה, ${GOODBYE}`,
};

// Hours as said on the phone ("בשלוש", not "ב-15:00": the bot read "15:00" as "חמש עשרה").
const HOURS_HE = ["שתים עשרה", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע", "עשר", "אחת עשרה"];
const UNITS_HE = ["", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע"];
const TEENS_HE = ["עשרה", "אחת עשרה", "שתים עשרה", "שלוש עשרה", "ארבע עשרה", "רבע", "שש עשרה", "שבע עשרה", "שמונה עשרה", "תשע עשרה"];
const TENS_HE = ["", "", "עשרים", "שלושים", "ארבעים", "חמישים"];

/** 1..59 minutes after the hour, as said: "עשרה", "רבע", "עשרים ושלוש", "חצי" */
function minutesHe(m: number): string {
  if (m === 30) return "חצי";
  if (m < 10) return UNITS_HE[m]!;
  if (m < 20) return TEENS_HE[m - 10]!;
  const u = m % 10;
  return u ? `${TENS_HE[Math.floor(m / 10)]} ו${UNITS_HE[u]}` : TENS_HE[m / 10]!;
}

const partOfDayHe = (h: number) => (h < 12 ? "בבוקר" : h < 16 ? "בצהריים" : h < 19 ? "אחר הצהריים" : "בערב");

/** 15:10 -> "שלוש ועשרה בצהריים", 9:45 -> "רבע לעשר בבוקר", 10:00 -> "עשר בבוקר" (without the "ב") */
export function timeHe(hour: number, minute: number): string {
  if (minute === 45 || minute === 50 || minute === 55) {
    const next = (hour + 1) % 24;
    const before = minute === 45 ? "רבע" : minute === 50 ? "עשרה" : "חמש";
    return `${before} ל${HOURS_HE[next % 12]} ${partOfDayHe(next)}`;
  }
  const h = HOURS_HE[hour % 12]!;
  return minute ? `${h} ו${minutesHe(minute)} ${partOfDayHe(hour)}` : `${h} ${partOfDayHe(hour)}`;
}

/** "היום בשלוש ועשרה בצהריים" / "מחר בעשר בבוקר" / "ביום שלישי, 24 בנובמבר, בעשר בבוקר" — as said on the phone. */
export function whenHe(t: Date, now: Date, tz: string): string {
  const p = toLocalParts(t, tz);
  const time = `ב${timeHe(p.hour, p.minute)}`;
  const today = toLocalParts(now, tz);
  if (dateKey(p) === dateKey(today)) return `היום ${time}`;
  if (dateKey(p) === dateKey(addDays(today, 1))) return `מחר ${time}`;
  const day = new Intl.DateTimeFormat("he-IL", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(t);
  return `ב${day}, ${time}`;
}

export const sayCallback = (t: Date, now: Date, tz: string) => `בסדר גמור, נדבר ${whenHe(t, now, tz)}. ${GOODBYE}`;
export const sayHandedToRepAt = (t: Date, now: Date, tz: string) =>
  `העברתי את הבקשה, נציג יחזור ${whenHe(t, now, tz)}. ${GOODBYE}`;
