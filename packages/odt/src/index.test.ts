import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { sampleResumeData } from "@reactive-resume/schema/resume/sample";
import { buildOdt } from "./index";

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

	it("rejects data that isn't a resume", async () => {
		await expect(buildOdt({} as never)).rejects.toThrow();
	});
});
