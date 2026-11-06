import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Partial MD5, the way KOReader identifies a book: 1 KB samples at 0, 1 KB, 4 KB, 16 KB … 1 GB.
 * The library server and the reader recognise the same book by it, whatever the file is called.
 * In LuaJIT, lshift(1024, -2) wraps to 0, and so does JavaScript's 1024 << -2: the first sample is at 0.
 */
export function partialMd5(data: Uint8Array): string {
	const step = 1024;
	const size = 1024;
	const hash = md5.create();
	for (let i = -1; i <= 10; i++) {
		const offset = step << (2 * i);
		if (offset >= data.length) break;
		hash.update(data.subarray(offset, Math.min(offset + size, data.length)));
	}
	return bytesToHex(hash.digest());
}
