/** The Hebrew labels and the status colours, exactly as the old dashboard's ui.js has them. */

export const TZ = "Asia/Jerusalem";

export const CONTACT_STATUS_HE: Record<string, string> = {
  new: "חדש", queued: "בתור", in_call: "בשיחה", link_sent: "נשלח קישור", callback: "שיחה חוזרת", hot_lead: "ליד חם לנציג",
  company: "דרך החברה", human_followup: "שאלה לנציג", not_interested: "לא מעוניין", already_registered: "כבר רשום",
  do_not_call: "לא להתקשר", wrong_number: "מספר שגוי", voicemail: "תא קולי", no_answer: "לא ענה",
  closed_max_attempts: "נסגר – מקסימום ניסיונות", duplicate: "כפול",
};
export const OUTCOME_HE: Record<string, string> = {
  LINK_SENT: "נשלח קישור", CALLBACK: "שיחה חוזרת", HOT_LEAD: "ליד חם לנציג", DO_NOT_CALL: "הסרה מהרשימה", VOICEMAIL: "תא קולי",
  HUMAN_FOLLOWUP: "מעקב נציג", NOT_INTERESTED: "לא מעוניין", COMPANY: "רכישת חברה", ALREADY_REGISTERED: "כבר רשום",
  WRONG_NUMBER: "מספר שגוי", UNKNOWN: "לא זוהתה תוצאה", NO_RESULT: "בלי תוצאה", NO_PHONE: "אין מספר תקין", DUPLICATE: "כפול", COMPLETED: "הסתיים",
};
export const REP_REASON_HE: Record<string, string> = {
  wants_human: "רוצה נציג", pay_via_rep: "תשלום דרך נציג", company_purchase: "רכישה דרך החברה", discount_request: "בקשת הנחה",
  course_interest: "מתעניין בקורס", other: "שאלה פתוחה", unreachable: "ביקש שנחזור ולא השגנו",
};
export const GENDER_HE: Record<string, string> = { male: "גבר", female: "אישה", unknown: "לא ידוע" };
export const TOOL_HE: Record<string, string> = {
  get_day_info: "בדק פרטי יום עיון", send_purchase_link: "שלח קישור לרכישה", schedule_callback: "קבע שיחה חוזרת",
  request_human: "העביר לנציג", end_call: "סיים את השיחה",
};
export const REASON_HE: Record<string, string> = {
  completed: "הסתיים", not_interested: "לא מעוניין", do_not_call: "הסרה מהרשימה", voicemail: "תא קולי", already_registered: "כבר רשום",
  wrong_number: "מספר שגוי", wants_human: "רוצה נציג", pay_via_rep: "תשלום דרך נציג", company_purchase: "רכישה דרך החברה",
  discount_request: "בקשת הנחה", course_interest: "מתעניין בקורס", other: "אחר",
};
export const DIALER_STATE_HE: Record<string, string> = {
  running: "פעיל", stopped: "כבוי", outside_hours: "מחוץ לשעות הפעילות", queue_empty: "התור ריק", in_call: "בשיחה", error: "תקלה",
  daily_limit: "הגיע למגבלה היומית",
};
export const ORIGIN_HE: Record<string, string> = { dialer: "אוטומטי", manual: "🧪 בדיקה" };
export const TRI_HE: Record<string, string> = { PASS: "עבר", FAIL: "נכשל", PENDING: "ממתין לבדיקה ידנית", NONE: "עוד לא נבדק" };
/** Gold's 16 columns (the export's Hebrew headers) */
export const GOLD_FIELDS: [string, string][] = [
  ["gold_record_id", "מזהה רשומה"], ["full_name", "שם מלא"], ["national_id", "ת.ז"], ["phone", "טלפון"], ["phone2", "טלפון 2"],
  ["phone3", "טלפון 3"], ["email", "אימייל"], ["company", "חברה"], ["city", "עיר"], ["address", "כתובת"], ["address2", "כתובת 2"],
  ["department", "מחלקה"], ["requested_course", "קורס מבוקש"], ["source", "מקור"], ["status", "סטטוס"], ["notes", "הערות"],
];
export const PHONE_COL = ["phone", "phone2", "phone3"] as const;

// one tone per status / outcome
const STATUS_TONE: Record<string, string> = {
  new: "info", queued: "info", callback: "violet", in_call: "live", link_sent: "success", hot_lead: "warning", company: "teal",
  human_followup: "warning", not_interested: "muted", already_registered: "success", do_not_call: "danger", wrong_number: "danger",
  voicemail: "muted", no_answer: "muted", closed_max_attempts: "muted", duplicate: "muted",
};
export const OUTCOME_TONE: Record<string, string> = {
  LINK_SENT: "success", CALLBACK: "violet", HOT_LEAD: "warning", COMPANY: "teal", HUMAN_FOLLOWUP: "warning", NOT_INTERESTED: "muted",
  DO_NOT_CALL: "danger", ALREADY_REGISTERED: "success", WRONG_NUMBER: "danger", VOICEMAIL: "muted", NO_RESULT: "muted",
  NO_PHONE: "danger", UNKNOWN: "muted",
};
export const statusTone = (s: string | null | undefined) => STATUS_TONE[s ?? ""] ?? "muted";

export const outcomeLabel = (o: string | string[] | null | undefined): string =>
  Array.isArray(o) ? o.map((x) => OUTCOME_HE[x] ?? x).join(" / ") : (OUTCOME_HE[o ?? "NO_RESULT"] ?? String(o));
