// The page curl's geometry and the PDF helpers: pure functions, no browser.
import { area, arc, constrain, cornerFor, fold, gradient, isDark, origin, toHost, turned, type Leaf } from "../src/curl";
import { canvasScale, isPdfBytes, outlineToc, pageHtml, people, usefulTitle } from "../src/pdf";
import { check, same } from "./check";

const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

// ── folding a page ──
{
	const leaf: Leaf = { rect: { x: 0, y: 0, w: 400, h: 600 }, spine: "left" };
	const W = 400, H = 600;
	let seed = 7;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	let areaOk = true, flapOk = true, spineOk = true, reachOk = true;
	for (let i = 0; i < 400; i++) {
		const corner = i % 2 ? "top" : "bottom";
		const p = constrain(leaf, corner, { x: -W + rnd() * 2 * W, y: -H * 0.5 + rnd() * 2 * H });
		const f = fold(leaf, corner, p);
		if (!f) continue;
		// nothing is lost or made: what lies flat and what lifted make the page
		if (!near(area(f.flat) + area(f.lifted), W * H, 1)) areaOk = false;
		// the flap is the lifted part laid over: the same size
		if (f.lifted.length >= 3 && !near(area(f.flap), area(f.lifted), 1)) flapOk = false;
		// the spine never lifts
		for (const s of [{ x: 0, y: 0 }, { x: 0, y: H }]) {
			const side = (s.x - f.mid.x) * f.normal.x + (s.y - f.mid.y) * f.normal.y;
			if (side > 0.5) spineOk = false;
		}
		// the corner stays within reach of the spine's ends
		const o = origin(leaf, corner);
		for (const s of [{ x: 0, y: 0 }, { x: 0, y: H }]) {
			if (Math.hypot(p.x - s.x, p.y - s.y) > Math.hypot(o.x - s.x, o.y - s.y) + 0.5) reachOk = false;
		}
	}
	check("fold: flat and lifted parts make the whole page", areaOk);
	check("fold: the flap is as big as the lifted part", flapOk);
	check("fold: the spine never lifts", spineOk);
	check("fold: the corner stays within reach of the spine", reachOk);

	const start = fold(leaf, "bottom", origin(leaf, "bottom"));
	check("fold: untouched, the page lies flat", !!start && near(area(start.flat), W * H) && start.lifted.length === 0 && start.progress === 0);
	const end = fold(leaf, "bottom", turned(leaf, "bottom"));
	check("fold: turned over, nothing lies flat and the flap is on the other side",
		!!end && area(end.flat) < 1 && near(area(end.lifted), W * H) && end.flap.every((q) => q.x <= 0.01) && end.progress === 1,
		JSON.stringify(end?.flap));

	same("corner: lifting starts at the corner", cornerFor(leaf, "bottom", "lift", { x: 0, y: 0 }), origin(leaf, "bottom"));
	same("corner: bringing back starts turned over", cornerFor(leaf, "bottom", "return", { x: 0, y: 0 }), turned(leaf, "bottom"));
	const mid = cornerFor(leaf, "bottom", "lift", { x: -W, y: 0 });
	check("corner: halfway the bottom corner rides up", mid.y < H - 10 && near(mid.x, 0, 1), JSON.stringify(mid));
	const top = cornerFor(leaf, "top", "lift", { x: -W, y: 0 });
	check("corner: the top corner rides down", top.y > 10, JSON.stringify(top));
	check("arc: nothing at either end", arc(leaf, W) === 0 && near(arc(leaf, -W), 0, 1e-9) && arc(leaf, 0) > 0);

	const right: Leaf = { rect: { x: 500, y: 0, w: 500, h: 700 }, spine: "right" };
	same("host: a leaf bound on the right is mirrored", toHost(right, { x: 0, y: 10 }), { x: 1000, y: 10 });
	same("host: its outer edge is on the left", toHost(right, { x: 500, y: 10 }), { x: 500, y: 10 });
}

// ── shading: gradient stops measured from the fold ──
{
	same("gradient: to the right, stops from the fold", gradient(100, 50, { x: 30, y: 10 }, { x: 1, y: 0 }, [["red", 0], ["blue", 20]]),
		"linear-gradient(90deg, red 30px, blue 50px)");
	same("gradient: downward", gradient(100, 50, { x: 0, y: 40 }, { x: 0, y: 1 }, [["red", 0]]), "linear-gradient(180deg, red 40px)");
	check("paper: night is dark, sepia is light", isDark("rgb(21, 21, 20)") && !isDark("rgb(243, 234, 214)") && !isDark("#fff"));
}

// ── PDF helpers ──
{
	const enc = (s: string) => new TextEncoder().encode(s);
	check("pdf: magic at the start", isPdfBytes(enc("%PDF-1.7\n...")));
	check("pdf: magic after some junk", isPdfBytes(enc(`${"x".repeat(300)}%PDF-1.4`)));
	check("pdf: not a pdf", !isPdfBytes(enc("PK\x03\x04 epub")) && !isPdfBytes(enc("%PD")));
	same("pdf title: a real one stays", usefulTitle("  Мастер  и Маргарита "), "Мастер и Маргарита");
	check("pdf title: what made the file is no title",
		["Microsoft Word - глава1.doc", "untitled", "Документ1", "book.pdf", "1234_5678", "Без названия"].every((t) => usefulTitle(t) === ""));
	same("pdf people: XMP list", people(["Иванов И. И.", " Петров П. П. ", "Иванов И. И."]), ["Иванов И. И.", "Петров П. П."]);
	same("pdf people: info string", people("Иванов И. И.; Петров П. П."), ["Иванов И. И.", "Петров П. П."]);
	same("pdf canvas: sharp on a Retina screen", canvasScale(600, 800, 1.5, 2), 3);
	const big = canvasScale(2000, 3000, 2, 3);
	check("pdf canvas: never past what iOS can draw", 2000 * 3000 * big * big <= 16_000_001, String(big));
	const html = pageHtml(595.276, 841.89);
	check("pdf page: frame sized to the page, text layer inside", html.includes('content="width=595.28, height=841.89"') && html.includes('class="textLayer"'));
}

// ── a PDF's outline as a table of contents ──
await (async () => {
	const refs = [{ num: 10 }, { num: 11 }, { num: 12 }, { num: 13 }];
	const pdf = {
		numPages: 4,
		getDestination: async (name: string) => (name === "named" ? [refs[3], { name: "XYZ" }] : null),
		getPageIndex: async (ref: { num: number }) => refs.indexOf(ref),
	};
	const toc = await outlineToc(pdf, [
		{ title: " Глава  1 ", dest: [refs[0]] },
		{ title: "Глава 2", dest: null, items: [{ title: "Часть 2.1", dest: [refs[1]] }, { title: "Часть 2.2", dest: [2] }] },
		{ title: "", dest: [refs[2]], items: [{ title: "Без родителя", dest: [refs[2]] }] },
		{ title: "Именованная", dest: "named" },
		{ title: "Битая", dest: "nowhere" },
	]);
	same("pdf outline: pages as hrefs, a chapter without a page takes its first child's", toc, [
		{ label: "Глава 1", href: "0" },
		{ label: "Глава 2", href: "1", subitems: [{ label: "Часть 2.1", href: "1" }, { label: "Часть 2.2", href: "2" }] },
		{ label: "Без родителя", href: "2" },
		{ label: "Именованная", href: "3" },
	]);
})();
