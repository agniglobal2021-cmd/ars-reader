// Bundles the unit tests with the real sources and runs them in Node. Browser tests: test/browser.mjs.
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "ars-reader-test-")), "unit.mjs");

execFileSync("python3", [join(root, "test/make_books.py")], { stdio: "ignore" });
await esbuild.build({
	entryPoints: [join(root, "test/unit.test.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	outfile: out,
	external: ["obsidian"],
	define: { __dirname_: JSON.stringify(join(root, "test")) },
	logLevel: "warning",
});

execFileSync(process.execPath, [out], { stdio: "inherit" });
