// Covers in the vault: one JPEG per book, small enough to sync without noticing.

/** Longest side, pixels. A cover on the library shelf is about 200 points wide, twice that on a Retina screen. */
export const COVER_MAX = 800;
const QUALITY = 0.85;

const EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
};

export interface CoverFile {
	data: ArrayBuffer;
	ext: string;
}

/**
 * The picture as a JPEG of at most 800 pixels on the long side. A small JPEG stays as it is; a
 * picture the browser cannot draw (SVG on some systems) is kept in its own format. Null when the
 * blob is not a picture at all.
 */
export async function prepareCover(blob: Blob): Promise<CoverFile | null> {
	const type = blob.type.toLowerCase();
	const pic = await decode(blob);
	if (pic) {
		try {
			const scale = Math.min(1, COVER_MAX / Math.max(pic.width, pic.height));
			if (scale === 1 && EXT[type] === "jpg") return { data: await blob.arrayBuffer(), ext: "jpg" };
			const w = Math.max(1, Math.round(pic.width * scale));
			const h = Math.max(1, Math.round(pic.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (ctx) {
				// Transparent parts of a PNG would turn black in a JPEG
				ctx.fillStyle = "#ffffff";
				ctx.fillRect(0, 0, w, h);
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = "high";
				ctx.drawImage(pic.source, 0, 0, w, h);
				const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
				if (out && out.size > 0) return { data: await out.arrayBuffer(), ext: "jpg" };
			}
		} catch {
			// Not drawable after all: the original below
		} finally {
			pic.done();
		}
	}
	const ext = EXT[type];
	return ext ? { data: await blob.arrayBuffer(), ext } : null;
}

interface Decoded {
	source: CanvasImageSource;
	width: number;
	height: number;
	done(): void;
}

/** The picture ready to draw: as a bitmap, or through an image element (SVG in Chromium). */
async function decode(blob: Blob): Promise<Decoded | null> {
	try {
		const bmp = await createImageBitmap(blob);
		return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
	} catch {
		// try the image element
	}
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		// An SVG without its own size: a book cover's proportions
		const width = img.naturalWidth || 600;
		const height = img.naturalHeight || 900;
		return { source: img, width, height, done: () => URL.revokeObjectURL(url) };
	} catch {
		URL.revokeObjectURL(url);
		return null;
	}
}

export function isImageName(name: string): boolean {
	return /\.(?:jpe?g|png|gif|webp|svg|avif|bmp|heic)$/i.test(name);
}
