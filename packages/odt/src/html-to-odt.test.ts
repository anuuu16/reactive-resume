import type { Paragraph } from "./model";
import { describe, expect, it } from "vitest";
import { htmlToParagraphs } from "./html-to-odt";

const plain = (paragraph: Paragraph | undefined) =>
	(paragraph?.children ?? [])
		.map((child) =>
			child.kind === "text" ? child.text : child.kind === "link" ? `[${child.href}]` : `<${child.kind}>`,
		)
		.join("");

describe("htmlToParagraphs", () => {
	it("converts plain text nodes at the root into a paragraph", () => {
		const result = htmlToParagraphs("Just some plain text");
		expect(result).toHaveLength(1);
		expect(plain(result[0])).toBe("Just some plain text");
	});

	it("applies the base typography and inline marks", () => {
		const [paragraph] = htmlToParagraphs(
			"<p>Hi <strong>bold</strong> <em>it</em> <u>u</u> <s>s</s> <code>c</code></p>",
			{
				font: "Inter",
				size: 10,
				color: "#111111",
			},
		);
		expect(paragraph?.children).toEqual([
			{ kind: "text", text: "Hi ", style: { font: "Inter", size: 10, color: "#111111" } },
			{ kind: "text", text: "bold", style: { font: "Inter", size: 10, color: "#111111", bold: true } },
			{ kind: "text", text: " ", style: { font: "Inter", size: 10, color: "#111111" } },
			{ kind: "text", text: "it", style: { font: "Inter", size: 10, color: "#111111", italics: true } },
			{ kind: "text", text: " ", style: { font: "Inter", size: 10, color: "#111111" } },
			{ kind: "text", text: "u", style: { font: "Inter", size: 10, color: "#111111", underline: true } },
			{ kind: "text", text: " ", style: { font: "Inter", size: 10, color: "#111111" } },
			{ kind: "text", text: "s", style: { font: "Inter", size: 10, color: "#111111", strike: true } },
			{ kind: "text", text: " ", style: { font: "Inter", size: 10, color: "#111111" } },
			{ kind: "text", text: "c", style: { font: "Courier New", size: 10, color: "#111111" } },
		]);
	});

	it("reads custom background-color from <mark> style, inverting text on dark highlights", () => {
		const [green] = htmlToParagraphs('<p><mark style="background-color: rgba(204, 255, 204, 1)">green</mark></p>');
		expect(green?.children[0]).toEqual({ kind: "text", text: "green", style: { background: "#ccffcc" } });
		const [dark] = htmlToParagraphs('<p><mark style="background-color: rgb(20, 20, 120)">dark</mark></p>');
		expect(dark?.children[0]).toEqual({
			kind: "text",
			text: "dark",
			style: { background: "#141478", color: "#ffffff" },
		});
		const [plainMark] = htmlToParagraphs("<p><mark>yellow</mark></p>");
		expect(plainMark?.children[0]).toEqual({ kind: "text", text: "yellow", style: { background: "#ffff00" } });
	});

	it("leaves script and style text out of the document", () => {
		const json = JSON.stringify(
			htmlToParagraphs("<p>Hello<style>.x { color: red }</style></p><script>alert(1)</script>"),
		);
		expect(json).toContain("Hello");
		expect(json).not.toContain("color: red");
		expect(json).not.toContain("alert(1)");
	});

	it("links safe hrefs in the link color and unwraps unsafe ones", () => {
		const [safe] = htmlToParagraphs('<p><a href="https://example.com">site</a></p>', { linkColor: "#123456" });
		expect(safe?.children[0]).toEqual({
			kind: "link",
			href: "https://example.com/",
			children: [{ kind: "text", text: "site", style: { color: "#123456", underline: true } }],
		});
		const [unsafe] = htmlToParagraphs('<p><a href="javascript:alert(1)">text</a></p>');
		expect(unsafe?.children).toEqual([{ kind: "text", text: "text" }]);
	});

	it("bullets every list item, including the TipTap shape <li><p>…</p></li>", () => {
		const result = htmlToParagraphs("<ul><li><p>One</p></li><li>Two</li><li><p>Three</p><p>More</p></li></ul>");
		expect(result.map((paragraph) => [plain(paragraph), paragraph.bullet])).toEqual([
			["One", { level: 0, ordered: false }],
			["Two", { level: 0, ordered: false }],
			["Three", { level: 0, ordered: false }],
			["More", { level: 0, ordered: false, continuation: true }],
		]);
	});

	it("nests lists by level and numbers ordered lists", () => {
		const result = htmlToParagraphs(
			"<ol><li><p>First</p><ul><li><p>Nested</p><ol><li><p>Deep</p></li></ol></li></ul></li><li><p>Second</p></li></ol>",
		);
		expect(result.map((paragraph) => [plain(paragraph), paragraph.bullet?.level, paragraph.bullet?.ordered])).toEqual([
			["First", 0, true],
			["Nested", 1, true],
			["Deep", 2, true],
			["Second", 0, true],
		]);
	});

	it("maps rich-text headings below the section headings, without the body font and size", () => {
		const result = htmlToParagraphs("<h1>Top</h1><h3>Third</h3><h6>Sixth</h6>", { font: "Inter", size: 10 });
		expect(result.map((paragraph) => [paragraph.outlineLevel, paragraph.style?.parent])).toEqual([
			[2, "Heading_20_2"],
			[4, "Heading_20_4"],
			[6, "Heading_20_6"],
		]);
		expect(result[0]?.children).toEqual([{ kind: "text", text: "Top" }]);
	});

	it("indents paragraphs and headings by data-indent while lists keep their own indentation", () => {
		const [paragraph, heading] = htmlToParagraphs('<p data-indent="2">P</p><h2 data-indent="1">H</h2>');
		expect(paragraph?.style?.marginStart).toBe(36);
		expect(heading?.style?.marginStart).toBe(18);
		expect(htmlToParagraphs('<ul><li><p data-indent="2">First</p></li></ul>')).toEqual(
			htmlToParagraphs("<ul><li><p>First</p></li></ul>"),
		);
		expect(htmlToParagraphs('<p data-indent="0">P</p>')).toEqual(htmlToParagraphs("<p>P</p>"));
	});

	it("insets quoted paragraphs in italics, adding any paragraph indentation", () => {
		const result = htmlToParagraphs(
			'<blockquote><p data-indent="1"><strong>First</strong></p><p>Second</p>loose <em>text</em></blockquote>',
		);
		expect(result).toHaveLength(3);
		expect(result[0]?.style?.marginStart).toBe(54);
		expect(result[0]?.children[0]).toEqual({ kind: "text", text: "First", style: { italics: true, bold: true } });
		expect(result[1]?.style?.marginStart).toBe(36);
		expect(plain(result[2])).toBe("loose text");
	});

	it("keeps code blocks as monospace text without their markup", () => {
		const [block] = htmlToParagraphs("<pre><code>const x = 1;\n  y &lt; 2</code></pre>");
		expect(block?.children).toEqual([{ kind: "text", text: "const x = 1;\n  y < 2", style: { font: "Courier New" } }]);
	});

	it("expands marked tabs to spaces while unmarked tabs stay tabs", () => {
		expect(plain(htmlToParagraphs('<p data-resume-whitespace="preserve">A\tB</p>')[0])).toBe("A    B");
		expect(plain(htmlToParagraphs("<p>A\tB</p>")[0])).toBe("A\tB");
	});

	it("turns <br> into line breaks and <hr> into an empty paragraph", () => {
		expect(plain(htmlToParagraphs("<p>one<br>two</p>")[0])).toBe("one<break>two");
		expect(htmlToParagraphs("<p>a</p><hr><p>b</p>")).toHaveLength(3);
	});

	it("spaces paragraphs and list items by the prose spacing, keeping the block's edges flush", () => {
		const result = htmlToParagraphs('<p>One</p><ul><li><p>Two</p></li></ul><p data-indent="1">Three</p>', {
			paragraphSpacing: 3,
		});
		expect(result.map((paragraph) => [paragraph.style?.spacingBefore, paragraph.style?.spacingAfter])).toEqual([
			[0, 3],
			[3, 3],
			[3, 0],
		]);
		expect(result[2]?.style?.marginStart).toBe(18);
		expect(htmlToParagraphs("<p>Alone</p>", { paragraphSpacing: 3 })[0]?.style).toEqual({
			spacingBefore: 0,
			spacingAfter: 0,
		});
		expect(htmlToParagraphs("<p>Alone</p>")[0]?.style).toBeUndefined();
	});

	it("returns nothing for blank input", () => {
		expect(htmlToParagraphs("")).toEqual([]);
		expect(htmlToParagraphs("   ")).toEqual([]);
	});
});
