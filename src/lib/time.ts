/** Timezone-aware helpers built on Intl only (no date library). All persisted instants are UTC. */

export const DEFAULT_TZ = "Asia/Kolkata";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function zonedParts(date: Date, timeZone: string = DEFAULT_TZ): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(map.weekday ?? "");
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: wd,
  };
}

export function isoDateInZone(date: Date, timeZone: string = DEFAULT_TZ): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export interface BusinessHours {
  startHour: number;
  endHour: number;
  timezone: string;
  openDays: number[];
}

export function isAfterHours(date: Date, hours: BusinessHours): boolean {
  const p = zonedParts(date, hours.timezone);
  if (!hours.openDays.includes(p.weekday)) return true;
  const minutes = p.hour * 60 + p.minute;
  return minutes < hours.startHour * 60 || minutes >= hours.endHour * 60;
}

/** Whole + fractional weeks from `now` (calendar date in the zone) to a YYYY-MM-DD date. */
export function weeksUntil(isoDate: string, now: Date, timeZone: string = DEFAULT_TZ): number {
  const today = isoDateInZone(now, timeZone);
  const ms = Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return ms / (7 * 24 * 3600 * 1000);
}

export function weeksBetween(fromIso: string, toIso: string): number {
  return (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / (7 * 24 * 3600 * 1000);
}

function hour12(h: number, m: number): string {
  const suffix = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hh} ${suffix}` : `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Tuesday 14 October at 4 pm" - for the voice agent to read aloud. */
export function speakableSlot(date: Date, timeZone: string = DEFAULT_TZ, now: Date = new Date()): string {
  const p = zonedParts(date, timeZone);
  const today = isoDateInZone(now, timeZone);
  const slotDay = isoDateInZone(date, timeZone);
  const diffDays = Math.round((Date.parse(`${slotDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const dayLabel =
    diffDays === 0
      ? "today"
      : diffDays === 1
        ? "tomorrow"
        : `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}`;
  return `${dayLabel} at ${hour12(p.hour, p.minute)}`;
}

export function formatDateTimeInZone(date: Date, timeZone: string = DEFAULT_TZ): string {
  const p = zonedParts(date, timeZone);
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${hour12(p.hour, p.minute)} (${timeZone})`;
}

/** Start of a day in `timeZone` expressed as a UTC instant. Works across DST via iterative correction. */
export function startOfDayUtc(isoDate: string, timeZone: string = DEFAULT_TZ): Date {
  let guess = new Date(`${isoDate}T00:00:00Z`);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const asIso = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const dayDiff = (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${asIso}T00:00:00Z`)) / 60_000;
    const minuteDiff = -(p.hour * 60 + p.minute);
    const delta = dayDiff + minuteDiff;
    if (delta === 0) break;
    guess = new Date(guess.getTime() + delta * 60_000);
  }
  return guess;
}

export function addDaysIso(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
