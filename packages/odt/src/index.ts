import type { SectionTitleResolver } from "./builder";
import type { ImageReader } from "./picture";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { parseResumeData } from "@reactive-resume/schema/resume/data";
import { buildDocument } from "./builder";
import { ODT_MIME_TYPE, packageOdt } from "./document";
import { loadPicture } from "./picture";

export type BuildOdtOptions = {
	/**
	 * Reads the resume picture by URL. Defaults to `fetch`, which suits the browser; the server passes a reader
	 * that refuses private addresses. A picture that can't be read is left out.
	 */
	readImage?: ImageReader | undefined;
};

/**
 * Builds an OpenDocument Text (`.odt`) file from resume data and returns it as a Blob. Pass `resolveTitle` to fill
 * in locale-aware section headings (titles are stored empty and resolved at render time).
 */
export async function buildOdt(
	data: ResumeData,
	resolveTitle?: SectionTitleResolver,
	options: BuildOdtOptions = {},
): Promise<Blob> {
	const parsed = parseResumeData(data);
	const picture = await loadPicture(parsed.picture, options.readImage);
	const document = buildDocument(parsed, resolveTitle, { picture });
	// fflate types its output over ArrayBufferLike; the bytes come from a fresh ArrayBuffer, as Blob requires.
	return new Blob([packageOdt(document) as Uint8Array<ArrayBuffer>], { type: ODT_MIME_TYPE });
}
