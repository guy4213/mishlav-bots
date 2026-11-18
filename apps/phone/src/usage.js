// What a call cost in Gemini tokens. The Live API bills every turn on the whole session context so far (the
// instructions, all earlier audio and answers), and reports each turn's counts in usageMetadata: the sum over the
// call's messages is what Google bills (AI Studio / Cloud Console stay the final word).

/** @typedef {{ input: Record<string, number>, output: Record<string, number>, messages: number }} UsageTotals */

const MODALITIES = ['TEXT', 'AUDIO', 'IMAGE', 'VIDEO'];

export class UsageMeter {
  constructor() {
    /** @type {UsageTotals} */
    this.totals = { input: {}, output: {}, messages: 0 };
  }

  /** One usageMetadata from the Live API (camelCase, as on the wire). */
  add(md) {
    if (!md || typeof md !== 'object') return;
    this.totals.messages++;
    addDetails(this.totals.input, md.promptTokensDetails, md.promptTokenCount);
    // thinking tokens are billed as text output
    addDetails(this.totals.output, md.responseTokensDetails, md.responseTokenCount);
    if (md.thoughtsTokenCount) this.totals.output.TEXT = (this.totals.output.TEXT ?? 0) + md.thoughtsTokenCount;
  }

  /** A copy, with only the modalities that were used. */
  snapshot() {
    return JSON.parse(JSON.stringify(this.totals));
  }
}

function addDetails(into, details, total) {
  if (Array.isArray(details) && details.length) {
    for (const d of details) {
      const m = MODALITIES.includes(d?.modality) ? d.modality : 'TEXT';
      into[m] = (into[m] ?? 0) + (Number(d?.tokenCount) || 0);
    }
  } else if (Number(total) > 0) {
    into.TEXT = (into.TEXT ?? 0) + Number(total); // no breakdown: counted as text (the cheaper rate)
  }
}

/** "in 61,240 (text 48,000, audio 13,240) · out 1,180 (audio 1,180)" for the call log */
export function usageLine(t) {
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const parts = (o) => Object.entries(o).map(([m, n]) => `${m.toLowerCase()} ${n.toLocaleString('en-US')}`).join(', ');
  return `in ${sum(t.input).toLocaleString('en-US')} (${parts(t.input) || '-'}) · out ${sum(t.output).toLocaleString('en-US')} (${parts(t.output) || '-'})`;
}
