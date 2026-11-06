import esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));

const production = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	platform: "browser",
	target: "es2022",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	// custom element names in vendor/foliate-js/tags.js carry the version
	define: { __ARS_READER_TAG__: JSON.stringify(version.replaceAll(".", "-")) },
	legalComments: "eof",
	banner: {
		js: "/* Читальня (ars-reader) — book reader for Obsidian. Source: https://github.com/agniglobal2021-cmd/ars-reader. Includes foliate-js (MIT), zip.js (BSD-3-Clause), fflate (MIT), noble-hashes (MIT) */",
	},
	outfile: "main.js",
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
