import type { AiUsage, Settings } from "@mishlav/shared";

/**
 * USD for a call's Gemini tokens, by the price table in settings.yaml (pricing.gemini_live). A modality without a
 * price counts at the highest price of its side, so a new modality is never shown as free. null: no price table.
 */
export function aiCostUsd(usage: AiUsage, settings: Settings): number | null {
  const prices = settings.pricing?.gemini_live;
  if (!prices) return null;
  const side = (tokens: Record<string, number>, table: Record<string, number>) => {
    const top = Math.max(0, ...Object.values(table));
    return Object.entries(tokens).reduce((usd, [m, n]) => usd + (n / 1e6) * (table[m] ?? top), 0);
  };
  return Math.round((side(usage.input, prices.input) + side(usage.output, prices.output)) * 1e5) / 1e5;
}
