import type { OdtDocument } from "./document";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { packageOdt, renderOdtParts, ODT_MIME_TYPE } from "./document";
import { paragraph, text } from "./model";

const document = (blocks: OdtDocument["blocks"], overrides: Partial<OdtDocument["page"]> = {}): OdtDocument => ({
	title: "Ada Lovelace",
	blocks,
	page: { width: 210, height: 297, marginX: 14, marginY: 12, rtl: false, ...overrides },
	defaults: {
		bodyFont: "Inter",
		bodySize: 10,
		headingFont: "Inter",
		headingSize: 14,
		textColor: "#000000",
		primaryColor: "#dc2626",
		lineHeight: 1.5,
	},
});

const content = (blocks: OdtDocument["blocks"]) => renderOdtParts(document(blocks))["content.xml"] ?? "";

describe("packageOdt", () => {
	it("stores the mimetype first and uncompressed, with a manifest for every part", () => {
		const bytes = packageOdt(document([paragraph([text("Hello")])]));
		// "mimetype" follows the 30-byte local file header of the first entry; method 0 = stored.
		expect(strFromU8(bytes.slice(30, 38))).toBe("mimetype");
		expect(bytes[8]).toBe(0);
		const files = unzipSync(bytes);
		expect(Object.keys(files)).toEqual(["mimetype", "META-INF/manifest.xml", "content.xml", "styles.xml", "meta.xml"]);
		expect(strFromU8(files.mimetype as Uint8Array)).toBe(ODT_MIME_TYPE);
		const manifest = strFromU8(files["META-INF/manifest.xml"] as Uint8Array);
		for (const path of ["content.xml", "styles.xml", "meta.xml"])
			expect(manifest).toContain(`manifest:full-path="${path}"`);
		expect(strFromU8(files["meta.xml"] as Uint8Array)).toContain("<dc:title>Ada Lovelace</dc:title>");
	});
});

describe("content.xml", () => {
	it("writes paragraphs with deduplicated automatic styles and spans", () => {
		const xml = content([
			paragraph([text("One", { bold: true })], { style: { spacingBefore: 6 } }),
			paragraph([text("Two", { bold: true }), text(" plain")], { style: { spacingBefore: 6 } }),
		]);
		expect(xml).toContain('<text:p text:style-name="P1"><text:span text:style-name="T1">One</text:span></text:p>');
		expect(xml).toContain(
			'<text:p text:style-name="P1"><text:span text:style-name="T1">Two</text:span> plain</text:p>',
		);
		expect(xml.match(/<style:style style:name="P\d+"/g)).toHaveLength(1);
		expect(xml).toContain('fo:font-weight="bold"');
		expect(xml).toContain('<style:paragraph-properties fo:margin-top="6pt">');
	});

	it("writes headings with their outline level and links with Writer's link styles", () => {
		const xml = content([
			paragraph([text("Experience")], { outlineLevel: 1, style: { parent: "Heading_20_1" } }),
			paragraph([{ kind: "link", href: "https://example.com/", children: [text("site")] }]),
		]);
		expect(xml).toContain('<text:h text:style-name="P1" text:outline-level="1">Experience</text:h>');
		expect(xml).toContain('style:parent-style-name="Heading_20_1"');
		expect(xml).toContain(
			'<text:a xlink:type="simple" xlink:href="https://example.com/" text:style-name="Internet_20_link" text:visited-style-name="Visited_20_Internet_20_Link">site</text:a>',
		);
	});

	it("nests consecutive list paragraphs by level and keeps continuation paragraphs in their item", () => {
		const xml = content([
			paragraph([text("A")], { bullet: { level: 0 } }),
			paragraph([text("A more")], { bullet: { level: 0, continuation: true } }),
			paragraph([text("B")], { bullet: { level: 1 } }),
			paragraph([text("C")], { bullet: { level: 0 } }),
			paragraph([text("After")]),
			paragraph([text("1")], { bullet: { level: 0, ordered: true } }),
		]);
		expect(xml).toContain(
			'<text:list text:style-name="List_20_Bullet"><text:list-item><text:p text:style-name="Standard">A</text:p><text:p text:style-name="Standard">A more</text:p><text:list><text:list-item><text:p text:style-name="Standard">B</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p text:style-name="Standard">C</text:p></text:list-item></text:list><text:p text:style-name="Standard">After</text:p><text:list text:style-name="List_20_Number"><text:list-item><text:p text:style-name="Standard">1</text:p></text:list-item></text:list>',
		);
	});

	it("nests a list that starts below the top level and separates lists of different kinds", () => {
		const xml = content([
			paragraph([text("Deep")], { bullet: { level: 1 } }),
			paragraph([text("Numbered")], { bullet: { level: 0, ordered: true } }),
		]);
		expect(xml).toContain(
			'<text:list text:style-name="List_20_Bullet"><text:list-item><text:list><text:list-item><text:p text:style-name="Standard">Deep</text:p></text:list-item></text:list></text:list-item></text:list><text:list text:style-name="List_20_Number">',
		);
	});

	it("gives a quoted list item its inset while keeping the hanging label", () => {
		const xml = content([paragraph([text("Quoted")], { bullet: { level: 0 }, style: { marginStart: 36 } })]);
		expect(xml).toContain('fo:margin-left="72pt"');
		expect(xml).toContain('fo:text-indent="-18pt"');
	});

	it("encodes whitespace, tabs and line breaks", () => {
		const xml = content([paragraph([text(" lead  two\tC"), { kind: "break" }, text("next"), { kind: "tab" }])]);
		expect(xml).toContain('<text:s/>lead <text:s text:c="1"/>two<text:tab/>C<text:line-break/>next<text:tab/>');
	});

	it("lays columns out as a borderless table spanning the text area", () => {
		const xml = content([
			{
				kind: "table",
				width: 500,
				rtl: false,
				cells: [
					{
						blocks: [paragraph([text("Side")])],
						width: 30,
						padding: { top: 4, end: 4, bottom: 4, start: 4 },
						background: "#eeeeee",
					},
					{ blocks: [], width: 70, padding: { top: 0, end: 0, bottom: 0, start: 4 } },
				],
			},
		]);
		expect(xml).toContain('<style:table-properties style:width="500pt" table:align="margins"/>');
		expect(xml).toContain('style:column-width="150pt" style:rel-column-width="3000*"');
		expect(xml).toContain('style:column-width="350pt" style:rel-column-width="7000*"');
		expect(xml).toContain('fo:border="none" fo:background-color="#eeeeee"');
		expect(xml).toContain(
			'<table:table table:name="Table1" table:style-name="Table1"><table:table-column table:style-name="Table1.A"/><table:table-column table:style-name="Table1.B"/><table:table-row><table:table-cell table:style-name="Table1.A1" office:value-type="string"><text:p text:style-name="Standard">Side</text:p></table:table-cell><table:table-cell table:style-name="Table1.B1" office:value-type="string"><text:p text:style-name="Standard"/></table:table-cell></table:table-row></table:table>',
		);
	});

	it("mirrors table padding and writing mode for right-to-left documents", () => {
		const xml = renderOdtParts(
			document([
				{
					kind: "table",
					width: 500,
					rtl: true,
					cells: [{ blocks: [], width: 100, padding: { top: 0, end: 9, bottom: 0, start: 1 } }],
				},
			]),
		)["content.xml"];
		expect(xml).toContain('style:writing-mode="rl-tb"');
		expect(xml).toContain('fo:padding-left="9pt" fo:padding-right="1pt"');
	});

	it("declares every font it uses", () => {
		const xml = content([paragraph([text("code", { font: "Courier New" })])]);
		expect(xml).toContain(
			'<style:font-face style:name="Courier New" svg:font-family="&apos;Courier New&apos;" style:font-family-generic="modern" style:font-pitch="fixed"/>',
		);
	});
});

describe("styles.xml", () => {
	it("sets the page size, margins, typography and colors from the document", () => {
		const xml = renderOdtParts(document([], { background: "#fafafa" }))["styles.xml"] ?? "";
		expect(xml).toContain(
			'fo:page-width="210mm" fo:page-height="297mm" style:print-orientation="portrait" fo:margin-top="12pt" fo:margin-bottom="12pt" fo:margin-left="14pt" fo:margin-right="14pt" fo:background-color="#fafafa" style:writing-mode="lr-tb"',
		);
		expect(xml).toContain('style:writing-mode="lr-tb" fo:line-height="150%"');
		expect(xml).toContain(
			'style:font-name="Inter" style:font-name-asian="Inter" style:font-name-complex="Inter" fo:font-size="10pt"',
		);
		expect(xml).toContain('style:name="Internet_20_link"');
		expect(xml).toContain('fo:color="#dc2626"');
		for (const level of [1, 2, 3, 4, 5, 6]) {
			expect(xml).toContain(`style:name="Heading_20_${level}" style:display-name="Heading ${level}"`);
		}
		expect(xml).toContain('<text:list-style style:name="List_20_Bullet"');
		expect(xml).toContain('<text:list-style style:name="List_20_Number"');
	});

	it("aligns right-to-left documents to the end of the line, as Writer expects", () => {
		const xml = renderOdtParts(document([], { rtl: true }))["styles.xml"] ?? "";
		expect(xml).toContain('style:writing-mode="rl-tb" fo:text-align="end"');
		expect(xml).toContain('fo:margin-right="14pt" style:writing-mode="rl-tb"');
	});
});
