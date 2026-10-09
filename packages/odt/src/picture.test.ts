import { describe, expect, it, vi } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { decodePictureHeader, loadPicture, pictureFrame } from "./picture";
import { pngHeader } from "./picture.fixture";

const jpegHeader = (width: number, height: number) => {
	const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3]);
	new DataView(bytes.buffer).setUint16(7, height);
	new DataView(bytes.buffer).setUint16(9, width);
	return bytes;
};

const webpHeader = (width: number, height: number) => {
	const bytes = new Uint8Array(30);
	bytes.set([
		...new TextEncoder().encode("RIFF"),
		0,
		0,
		0,
		0,
		...new TextEncoder().encode("WEBPVP8L"),
		0,
		0,
		0,
		0,
		0x2f,
	]);
	const bits = (width - 1) | ((height - 1) << 14);
	new DataView(bytes.buffer).setUint32(21, bits, true);
	return bytes;
};

const picture = (overrides: Partial<typeof defaultResumeData.picture> = {}) => ({
	...defaultResumeData.picture,
	url: "https://example.com/api/uploads/u/pictures/p.png",
	...overrides,
});

describe("decodePictureHeader", () => {
	it("reads the media type and size of PNG, JPEG and WebP files", () => {
		expect(decodePictureHeader(pngHeader(640, 480))).toEqual({ mediaType: "image/png", width: 640, height: 480 });
		expect(decodePictureHeader(jpegHeader(300, 200))).toEqual({ mediaType: "image/jpeg", width: 300, height: 200 });
		expect(decodePictureHeader(webpHeader(128, 64))).toEqual({ mediaType: "image/webp", width: 128, height: 64 });
	});

	it("rejects anything else", () => {
		expect(decodePictureHeader(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
		expect(decodePictureHeader(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
		expect(decodePictureHeader(new Uint8Array())).toBeNull();
	});
});

describe("loadPicture", () => {
	it("reads the picture through the given reader", async () => {
		const read = vi.fn().mockResolvedValue(pngHeader(200, 100));
		await expect(loadPicture(picture(), read)).resolves.toEqual({
			bytes: pngHeader(200, 100),
			mediaType: "image/png",
			width: 200,
			height: 100,
		});
		expect(read).toHaveBeenCalledWith("https://example.com/api/uploads/u/pictures/p.png");
	});

	it("leaves a hidden or blank picture out without reading it", async () => {
		const read = vi.fn();
		await expect(loadPicture(picture({ hidden: true }), read)).resolves.toBeUndefined();
		await expect(loadPicture(picture({ url: "  " }), read)).resolves.toBeUndefined();
		expect(read).not.toHaveBeenCalled();
	});

	it("leaves the picture out when it can't be read or isn't an image", async () => {
		await expect(loadPicture(picture(), vi.fn().mockRejectedValue(new Error("refused")))).resolves.toBeUndefined();
		await expect(
			loadPicture(picture(), vi.fn().mockResolvedValue(new TextEncoder().encode("not an image"))),
		).resolves.toBeUndefined();
		await expect(loadPicture(picture(), vi.fn().mockResolvedValue(pngHeader(0, 10)))).resolves.toBeUndefined();
	});
});

describe("pictureFrame", () => {
	it("keeps the image's proportions inside the size and aspect ratio chosen in the editor", () => {
		expect(pictureFrame({ size: 64, aspectRatio: 1 }, { width: 100, height: 100 })).toEqual({ width: 64, height: 64 });
		expect(pictureFrame({ size: 64, aspectRatio: 1 }, { width: 200, height: 100 })).toEqual({ width: 64, height: 32 });
		expect(pictureFrame({ size: 64, aspectRatio: 2 }, { width: 100, height: 200 })).toEqual({ width: 16, height: 32 });
	});
});
