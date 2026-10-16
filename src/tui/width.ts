/** East-Asian wide / fullwidth / common emoji ranges → 2 cells; else 1. */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff);
  return wide ? 2 : 1;
}

/** Terminal cell width of a string (CJK/emoji ≈ 2 cells). */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Truncate to a cell budget, never splitting a wide char, appending `…`. */
export function truncateToWidth(text: string, limit: number): string {
  const budget = Math.max(0, Math.floor(limit));
  if (budget <= 0) return "";
  if (displayWidth(text) <= budget) return text;
  if (budget === 1) return "…";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (used + cw > budget - 1) break;
    out += ch;
    used += cw;
  }
  return `${out}…`;
}

/** Hard-truncate by cells (no ellipsis) then pad with spaces to exact cell width. */
export function fitWidth(text: string, limit: number): string {
  const budget = Math.max(0, Math.floor(limit));
  if (budget <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (used + cw > budget) break;
    out += ch;
    used += cw;
  }
  return out + " ".repeat(budget - used);
}
