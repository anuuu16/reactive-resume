import { describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { sampleResumeData } from "@reactive-resume/schema/resume/sample";
import { buildOdt } from "./index";
import { pngHeader } from "./picture.fixture";

describe("buildOdt", () => {
	it("returns an OpenDocument Text blob for the sample resume", async () => {
		const blob = await buildOdt(sampleResumeData, (id) => (id === "experience" ? "Berufserfahrung" : undefined));
		expect(blob).toBeInstanceOf(Blob);
		expect(blob.type).toBe("application/vnd.oasis.opendocument.text");
		expect(blob.size).toBeGreaterThan(0);

		const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
		expect(strFromU8(files.mimetype as Uint8Array)).toBe("application/vnd.oasis.opendocument.text");
		const content = strFromU8(files["content.xml"] as Uint8Array);
		expect(content).toContain(sampleResumeData.basics.name);
		expect(content).toContain("Berufserfahrung");
		expect(content).toContain("<text:list ");
		expect(content).toContain("<table:table ");
	});

	it("embeds the picture read by the given reader, and leaves it out when reading fails", async () => {
		const data = structuredClone(sampleResumeData);
		data.picture = { ...data.picture, hidden: false, url: "https://example.com/api/uploads/u/pictures/p.png" };
		const read = vi.fn().mockResolvedValue(pngHeader(100, 100));
		const files = unzipSync(new Uint8Array(await (await buildOdt(data, undefined, { readImage: read })).arrayBuffer()));
		expect(read).toHaveBeenCalledWith(data.picture.url);
		expect(files["Pictures/picture.png"]).toEqual(pngHeader(100, 100));
		expect(strFromU8(files["content.xml"] as Uint8Array)).toContain('xlink:href="Pictures/picture.png"');

		const refused = vi.fn().mockRejectedValue(new Error("Private or invalid image URL refused"));
		const without = unzipSync(
			new Uint8Array(await (await buildOdt(data, undefined, { readImage: refused })).arrayBuffer()),
		);
		expect(without["Pictures/picture.png"]).toBeUndefined();
		expect(strFromU8(without["content.xml"] as Uint8Array)).toContain(sampleResumeData.basics.name);
	});

	it("rejects data that isn't a resume", async () => {
		await expect(buildOdt({} as never)).rejects.toThrow();
	});
});
