import type { SectionTitleResolver } from "./builder";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { parseResumeData } from "@reactive-resume/schema/resume/data";
import { buildDocument } from "./builder";
import { ODT_MIME_TYPE, packageOdt } from "./document";

/**
 * Builds an OpenDocument Text (`.odt`) file from resume data and returns it as a Blob. Pass `resolveTitle` to fill
 * in locale-aware section headings (titles are stored empty and resolved at render time).
 */
// oxlint-disable-next-line require-await -- keep synchronous renderer errors on the public Promise rejection path.
export async function buildOdt(data: ResumeData, resolveTitle?: SectionTitleResolver): Promise<Blob> {
	const document = buildDocument(parseResumeData(data), resolveTitle);
	// fflate types its output over ArrayBufferLike; the bytes come from a fresh ArrayBuffer, as Blob requires.
	return new Blob([packageOdt(document) as Uint8Array<ArrayBuffer>], { type: ODT_MIME_TYPE });
}
