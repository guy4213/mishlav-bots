/**
 * International format with +: 050-1234567 -> +972501234567.
 * Zadarma's PBX rejects a number without + (503 Service Unavailable); with + the call goes through.
 */
export function dialable(raw) {
  let n = String(raw).replace(/[^\d+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  else if (n.startsWith('00')) n = n.slice(2);
  else if (n.startsWith('0')) n = `972${n.slice(1)}`;
  if (n.startsWith('9720')) n = `972${n.slice(4)}`; // +972 0532… -> drop the 0 after the country code
  if (!/^\d{6,15}$/.test(n)) throw new Error(`invalid phone number: ${raw}`);
  return `+${n}`;
}

/** +972501234567 -> +97250***4567: enough to tell calls apart in the console, without the full number. */
export const maskNumber = (n) => String(n).replace(/^(\+?\d{5})\d+(\d{4})$/, '$1***$2');
