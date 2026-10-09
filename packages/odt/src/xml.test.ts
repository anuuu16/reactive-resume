import { describe, expect, it } from "vitest";
import { escapeXml, pt, textContent } from "./xml";

describe("escapeXml", () => {
	it("escapes markup characters and drops control characters", () => {
		expect(escapeXml(`<a href="x">Tom & Jerry's</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;",
		);
		expect(escapeXml("a\u0000b\u0007c")).toBe("abc");
	});
});

describe("pt", () => {
	it("rounds to two decimals", () => {
		expect(pt(12)).toBe("12pt");
		expect(pt(595.2755905)).toBe("595.28pt");
	});
});

describe("textContent", () => {
	it("encodes runs of spaces, tabs and newlines as OpenDocument whitespace elements", () => {
		expect(textContent("A\tB    C\nD")).toBe('A<text:tab/>B <text:s text:c="3"/>C<text:line-break/>D');
	});

	it("keeps a single space between words as is", () => {
		expect(textContent("one two")).toBe("one two");
	});

	it("preserves leading spaces at the start of a paragraph", () => {
		expect(textContent(" lead", true)).toBe("<text:s/>lead");
		expect(textContent("   lead", true)).toBe('<text:s text:c="3"/>lead');
		expect(textContent(" inner", false)).toBe(" inner");
	});
});
