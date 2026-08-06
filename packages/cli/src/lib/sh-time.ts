/**
 * @responsibility Provides fixed Asia/Shanghai display-time helpers.
 */
// Display-time helpers: fixed Asia/Shanghai wall clock (UTC+8, no DST).
export const TZ_OFFSET_MS = 8 * 3600 * 1000;

/** A UTC Date shifted into UTC+8 wall-clock, exposed via getUTC* accessors. */
export function toShanghai(d: Date): Date {
  return new Date(d.getTime() + TZ_OFFSET_MS);
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function shHHMM(d: Date): string {
  const s = toShanghai(d);
  return `${pad2(s.getUTCHours())}:${pad2(s.getUTCMinutes())}`;
}

export function shDayKey(d: Date): string {
  const s = toShanghai(d);
  return `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`;
}

export function shYmdHm(d: Date): string {
  const s = toShanghai(d);
  return `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())} ${pad2(s.getUTCHours())}:${pad2(s.getUTCMinutes())}`;
}

/** YYYY-MM-DD shifted by `deltaDays` from a given day key (display TZ). */
export function dayKeyOffset(d: Date, deltaDays: number): string {
  const s = toShanghai(d);
  const shifted = new Date(
    Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + deltaDays),
  );
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

export function shDayStartMs(dayKey: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return Date.UTC(year, month - 1, day) - TZ_OFFSET_MS;
}

export function shWindowDays(now: Date, count = 14): Array<{ key: string; startMs: number; endMs: number }> {
  const endKey = shDayKey(now);
  const endStart = shDayStartMs(endKey);
  if (endStart === null) return [];
  return Array.from({ length: count }, (_, index) => {
    const startMs = endStart - (count - 1 - index) * 24 * 3600 * 1000;
    const key = shDayKey(new Date(startMs));
    return { key, startMs, endMs: startMs + 24 * 3600 * 1000 };
  });
}
