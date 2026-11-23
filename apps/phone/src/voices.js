// Gemini's female voices, for the bot "נועה": Kore (Google: "firm") is the default; the others are described as
// younger / lighter (Leda "youthful", Zephyr "bright", Aoede "breezy", Laomedeia "upbeat", Autonoe "bright",
// Callirrhoe "easy-going", Despina "smooth"). The team picks the voice in the dashboard (סקירה → קול הבוט; kept in
// Supabase dialer_control.voice); PHONE_VOICE is the voice when none was picked. A test call can try another one.
export const DEFAULT_VOICE = 'Kore';
export const PHONE_VOICES = ['Kore', 'Leda', 'Zephyr', 'Aoede', 'Laomedeia', 'Autonoe', 'Callirrhoe', 'Despina'];
