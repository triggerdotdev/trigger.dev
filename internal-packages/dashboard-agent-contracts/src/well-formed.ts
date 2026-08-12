// `slice` that can't end on a high surrogate — split pair or already lone, dropped
// either way. A lone surrogate is invalid UTF-8 and jsonb rejects it.
export function sliceWellFormed(s: string, n: number): string {
  if (n >= s.length) return s;
  const cut = s.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return cut.slice(0, -1);
  return cut;
}
