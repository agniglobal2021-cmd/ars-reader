import type { ReaderSettings, Theme } from "./settings";

export interface Palette {
	bg: string;
	fg: string;
	link: string;
	dark: boolean;
}

export interface Look {
	palettes: Record<Exclude<Theme, "auto">, Palette>;
	serif: string;
	sans: string;
}

/** Defaults; styles.css overrides them through --ars-reader-* variables, so a design lands without code. */
export const DEFAULT_LOOK: Look = {
	palettes: {
		light: { bg: "#fbfaf7", fg: "#1d1c1a", link: "#2f5c9e", dark: false },
		sepia: { bg: "#f3ead6", fg: "#4b3a28", link: "#8a4d18", dark: false },
		night: { bg: "#151514", fg: "#d3ccbf", link: "#8db2e3", dark: true },
	},
	serif: 'Georgia, "Times New Roman", serif',
	sans: '-apple-system, system-ui, "Helvetica Neue", sans-serif',
};

/** Reads the look from CSS variables on the given element. */
export function readLook(el: HTMLElement): Look {
	const css = getComputedStyle(el);
	const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
	const palette = (name: "light" | "sepia" | "night"): Palette => {
		const d = DEFAULT_LOOK.palettes[name];
		return {
			bg: v(`--ars-reader-${name}-bg`, d.bg),
			fg: v(`--ars-reader-${name}-fg`, d.fg),
			link: v(`--ars-reader-${name}-link`, d.link),
			dark: d.dark,
		};
	};
	return {
		palettes: { light: palette("light"), sepia: palette("sepia"), night: palette("night") },
		serif: v("--ars-reader-font-serif", DEFAULT_LOOK.serif),
		sans: v("--ars-reader-font-sans", DEFAULT_LOOK.sans),
	};
}

/** "auto" follows Obsidian: night in a dark theme, light otherwise. */
export function resolveTheme(theme: Theme, obsidianDark: boolean): Exclude<Theme, "auto"> {
	if (theme !== "auto") return theme;
	return obsidianDark ? "night" : "light";
}

/** CSS injected into every page of the book. */
export function bookCss(s: ReaderSettings, theme: Exclude<Theme, "auto">, look: Look): string {
	const p = look.palettes[theme];
	const family = s.font === "serif" ? look.serif : s.font === "sans" ? look.sans : "";
	const tinted = theme !== "light";
	const hyphens = s.hyphenate ? "auto" : "manual";
	return `
@namespace epub "http://www.idpf.org/2007/ops";
html {
	color-scheme: ${p.dark ? "dark" : "light"};
	background: ${p.bg} !important;
	color: ${p.fg} !important;
	font-size: ${s.fontSize}% !important;
	-webkit-text-size-adjust: none;
	text-size-adjust: none;
}
body {
	background: transparent !important;
	color: inherit !important;
	${family ? `font-family: ${family} !important;` : ""}
}
${family ? `body :not(pre, code, kbd, samp, tt, var, svg, svg *, math, math *) { font-family: inherit !important; }` : ""}
a:link, a:visited { color: ${p.link} !important; }
p, li, blockquote, dd, dt {
	line-height: ${s.lineHeight} !important;
	text-align: ${s.justify ? "justify" : "start"};
	-webkit-hyphens: ${hyphens};
	hyphens: ${hyphens};
	-webkit-hyphenate-limit-before: 3;
	-webkit-hyphenate-limit-after: 2;
	-webkit-hyphenate-limit-lines: 2;
	hanging-punctuation: allow-end last;
	widows: 2;
	orphans: 2;
}
[align="left"] { text-align: left; }
[align="right"] { text-align: right; }
[align="center"] { text-align: center; }
[align="justify"] { text-align: justify; }
pre { white-space: pre-wrap !important; }
img, svg, video { max-width: 100%; }
aside[epub|type~="endnote"],
aside[epub|type~="footnote"],
aside[epub|type~="note"],
aside[epub|type~="rearnote"] { display: none; }
${tinted ? `
body *:not(img, svg, svg *, video, canvas, math, math *) {
	color: inherit !important;
	background-color: transparent !important;
	border-color: color-mix(in srgb, currentColor 30%, transparent) !important;
}
a:link *, a:visited * { color: ${p.link} !important; }` : ""}
${p.dark ? "img { filter: brightness(0.85); }" : ""}
`;
}
