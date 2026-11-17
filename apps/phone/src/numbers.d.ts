// Types for numbers.js (the tools server masks numbers in its logs too).
export function dialable(raw: string): string;
/** +972501234567 -> +97250***4567 */
export function maskNumber(n: string): string;
