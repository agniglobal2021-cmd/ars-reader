// Tiny assertion helpers shared by the unit test files.
let passed = 0;
const failures: string[] = [];

export const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

export const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compares and, on a mismatch, shows both sides with visible tabs and line breaks. */
export const same = (name: string, got: unknown, want: unknown) => {
	const show = (v: unknown) => JSON.stringify(v);
	check(name, eq(got, want), `got ${show(got)}, want ${show(want)}`);
};

export function report(): void {
	console.log(`passed: ${passed}`);
	if (failures.length) {
		console.log(`FAILED: ${failures.length}`);
		for (const fl of failures) console.log(`  ✗ ${fl}`);
		process.exit(1);
	}
}
