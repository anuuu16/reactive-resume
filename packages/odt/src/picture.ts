import type { ResumeData } from "@reactive-resume/schema/resume/data";

/** A resume picture ready to embed: its bytes, the media type Writer reads them as, and its size in pixels. */
export type LoadedPicture = {
	bytes: Uint8Array;
	mediaType: "image/png" | "image/jpeg" | "image/webp";
	width: number;
	height: number;
};

/** Reads an image by URL; the server passes its own reader, which refuses private addresses. */
export type ImageReader = (source: string) => Promise<Uint8Array>;

const MAX_PICTURE_BYTES = 12_000_000;
const PICTURE_TIMEOUT_MS = 10_000;

const u16be = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u16le = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, at: number) => u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
const u32be = (bytes: Uint8Array, at: number) => u16be(bytes, at) * 65536 + u16be(bytes, at + 2);
const ascii = (bytes: Uint8Array, at: number, length: number) =>
	String.fromCharCode(...bytes.subarray(at, at + length));

/** Media type and pixel size of a PNG, JPEG or WebP, the formats the app uploads; null for anything else. */
export function decodePictureHeader(bytes: Uint8Array): Omit<LoadedPicture, "bytes"> | null {
	if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") {
		return { mediaType: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
	}

	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		// Walk the segments to the first start-of-frame marker, which holds the size.
		let at = 2;
		while (at + 9 < bytes.length) {
			if (bytes[at] !== 0xff) return null;
			const marker = bytes[at + 1] ?? 0;
			const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isFrame) return { mediaType: "image/jpeg", width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
			at += 2 + u16be(bytes, at + 2);
		}
		return null;
	}

	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
		const chunk = ascii(bytes, 12, 4);
		if (chunk === "VP8 ") {
			return { mediaType: "image/webp", width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
		}
		if (chunk === "VP8L") {
			const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
			return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8X") return { mediaType: "image/webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
	}
	return null;
}

/** Fetches an image, as the browser export does; the page's own pictures are on the same origin. */
async function readImageBytes(source: string): Promise<Uint8Array> {
	const response = await fetch(source, { signal: AbortSignal.timeout(PICTURE_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	if (Number(response.headers.get("content-length")) > MAX_PICTURE_BYTES) throw new Error("Image exceeds 12 MB");
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_PICTURE_BYTES) throw new Error("Image exceeds 12 MB");
	return bytes;
}

/**
 * Loads the resume picture for embedding. A hidden or blank picture, a failed download or an unreadable file leaves
 * the picture out, as the PDF export does, rather than failing the document.
 */
export async function loadPicture(
	picture: ResumeData["picture"],
	read: ImageReader = readImageBytes,
): Promise<LoadedPicture | undefined> {
	if (picture.hidden || !picture.url.trim()) return undefined;
	try {
		const bytes = await read(picture.url);
		const header = decodePictureHeader(bytes);
		if (!header || bytes.byteLength > MAX_PICTURE_BYTES || header.width < 1 || header.height < 1) return undefined;
		return { bytes, ...header };
	} catch {
		return undefined;
	}
}

/**
 * The frame a picture prints in: the size and aspect ratio chosen in the editor, shrunk to keep the image's own
 * proportions, since Writer can't crop to a frame as the page's `cover` fit does.
 */
export function pictureFrame(
	picture: Pick<ResumeData["picture"], "size" | "aspectRatio">,
	loaded: Pick<LoadedPicture, "width" | "height">,
): { width: number; height: number } {
	const box = { width: picture.size, height: picture.size / picture.aspectRatio };
	const scale = Math.min(box.width / loaded.width, box.height / loaded.height);
	return { width: loaded.width * scale, height: loaded.height * scale };
}
