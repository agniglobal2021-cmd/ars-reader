const pad = (n: number) => String(n).padStart(2, "0");

/** «2026-11-27» in local time. */
export function localDate(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** «14:05» in local time. */
export function localTime(d: Date): string {
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
