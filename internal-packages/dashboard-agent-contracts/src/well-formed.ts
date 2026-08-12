// `slice` that can't end on a high surrogate — split pair or already lone, dropped
// either way. A lone surrogate is invalid UTF-8 and jsonb rejects it.
export function sliceWellFormed(s: string, n: number): string {
  if (n >= s.length) return s;
  const cut = s.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return cut.slice(0, -1);
  return cut;
}

// `toWellFormed` is ES2024; this package targets ES2022.
interface WellFormable {
  toWellFormed(): string;
}

function wellFormed(s: string): string {
  return (s as unknown as WellFormable).toWellFormed();
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Every string in a JSON-ish value made well-formed, keys included, so a lone surrogate
 * anywhere — tool input, filename, url — can't reach jsonb. Anything unchanged is returned
 * as it was, and anything with a custom prototype (a Date, a class instance) is untouched.
 */
export function toWellFormedDeep<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const fixed = toWellFormedDeep(item);
      if (fixed !== item) changed = true;
      return fixed;
    });
    return (changed ? next : value) as T;
  }
  if (value !== null && typeof value === "object" && isPlainObject(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const fixedKey = wellFormed(key);
      const fixed = toWellFormedDeep(item);
      if (fixed !== item || fixedKey !== key) changed = true;
      next[fixedKey] = fixed;
    }
    return (changed ? next : value) as T;
  }
  return value;
}
