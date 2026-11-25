// Gemini's female voices, for the bot "נועה" (Google's own one-word descriptions, in Hebrew for the dashboard).
// Kore ("firm") is the default. The team picks the voice in the dashboard (סקירה → קול הבוט; kept in Supabase
// dialer_control.voice); PHONE_VOICE is the voice when none was picked. A test call can try another one.
// On the phone line (8 kHz) the voices sound closer to each other than on Google's samples (Guy, 25.11): the last
// five were added for more choice. Gacrux ("mature") is left out on purpose - the voice was found too old.
export const DEFAULT_VOICE = 'Kore';
export const VOICE_HE = {
  Kore: 'תקיף',
  Leda: 'צעיר',
  Zephyr: 'בהיר',
  Aoede: 'קליל',
  Laomedeia: 'שמח',
  Autonoe: 'בהיר',
  Callirrhoe: 'רגוע',
  Despina: 'חלק',
  Erinome: 'צלול',
  Achernar: 'רך',
  Vindemiatrix: 'עדין',
  Sulafat: 'חם',
  Pulcherrima: 'נלהב',
};
export const PHONE_VOICES = Object.keys(VOICE_HE);
