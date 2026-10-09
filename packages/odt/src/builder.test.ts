import type { Block, Paragraph } from "./model";
import { describe, expect, it } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { sampleResumeData } from "@reactive-resume/schema/resume/sample";
import { buildDocument } from "./builder";

const plain = (block: Block | undefined) =>
	block?.kind === "paragraph"
		? block.children.map((child) => (child.kind === "text" ? child.text : `<${child.kind}>`)).join("")
		: `<${block?.kind}>`;

function twoPageResume() {
	const data = structuredClone(sampleResumeData);
	data.metadata.layout.pages = [
		{ fullWidth: false, main: ["summary"], sidebar: ["skills"] },
		{ fullWidth: false, main: ["experience"], sidebar: ["languages"] },
	];
	return data;
}

describe("buildDocument", () => {
	it("reads page, typography and colors from the metadata", () => {
		const data = structuredClone(defaultResumeData);
		data.metadata.page = { ...data.metadata.page, format: "letter", marginX: 20, marginY: 16 };
		data.metadata.typography.body = {
			...data.metadata.typography.body,
			fontFamily: "Lora",
			fontSize: 11,
			lineHeight: 1.4,
		};
		data.metadata.typography.heading = { ...data.metadata.typography.heading, fontFamily: "Oswald", fontSize: 16 };
		data.metadata.design.colors = {
			primary: "rgba(0, 112, 178, 1)",
			text: "rgba(20, 20, 20, 1)",
			background: "rgba(250, 250, 250, 1)",
		};
		const document = buildDocument(data);
		expect(document.page).toEqual({
			width: 215.9,
			height: 279.4,
			marginX: 20,
			marginY: 16,
			background: "#fafafa",
			rtl: false,
		});
		expect(document.defaults).toEqual({
			bodyFont: "Lora",
			bodySize: 11,
			headingFont: "Oswald",
			headingSize: 16,
			textColor: "#141414",
			primaryColor: "#0070b2",
			lineHeight: 1.4,
		});
	});

	it("falls back to A4, a default font and a white page", () => {
		const data = structuredClone(defaultResumeData);
		data.metadata.page.format = "free-form";
		data.metadata.typography.body.fontFamily = "";
		const document = buildDocument(data);
		expect(document.page).toMatchObject({ width: 210, height: 297 });
		expect(document.page.background).toBeUndefined();
		expect(document.defaults.bodyFont).toBe("Liberation Sans");
	});

	it("prints the header with name, headline and linked contact details", () => {
		const data = structuredClone(defaultResumeData);
		data.basics = {
			...data.basics,
			name: "Ada Lovelace",
			headline: "Analyst",
			email: "ada@example.com",
			phone: "+44 20 1234",
			location: "London",
			website: { url: "https://ada.example", label: "ada.example" },
			customFields: [{ id: "c1", icon: "", text: "Portfolio", link: "javascript:alert(1)" }],
		};
		const [name, headline, contact] = buildDocument(data).blocks;
		expect(name).toMatchObject({
			children: [{ kind: "text", text: "Ada Lovelace" }],
			style: { parent: "Title", text: { bold: true, color: "#dc2626" } },
		});
		expect(plain(headline)).toBe("Analyst");
		expect(contact?.kind === "paragraph" ? contact.children : []).toEqual([
			{
				kind: "link",
				href: "mailto:ada@example.com",
				children: [{ kind: "text", text: "ada@example.com", style: expect.objectContaining({ underline: true }) }],
			},
			{ kind: "text", text: "  |  ", style: expect.objectContaining({ color: "#999999" }) },
			{ kind: "text", text: "+44 20 1234", style: expect.anything() },
			{ kind: "text", text: "  |  ", style: expect.objectContaining({ color: "#999999" }) },
			{ kind: "text", text: "London", style: expect.anything() },
			{ kind: "text", text: "  |  ", style: expect.objectContaining({ color: "#999999" }) },
			{
				kind: "link",
				href: "https://ada.example/",
				children: [{ kind: "text", text: "ada.example", style: expect.anything() }],
			},
			{ kind: "text", text: "  |  ", style: expect.objectContaining({ color: "#999999" }) },
			{ kind: "text", text: "Portfolio", style: expect.anything() },
		]);
	});

	it("resolves section titles through the caller's resolver", () => {
		const data = structuredClone(defaultResumeData);
		data.summary.content = "<p>Hi</p>";
		data.metadata.layout.pages = [{ fullWidth: true, main: ["summary"], sidebar: [] }];
		const headings = buildDocument(data, (id) => (id === "summary" ? "Profil" : undefined)).blocks.filter(
			(block): block is Paragraph => block.kind === "paragraph" && block.outlineLevel === 1,
		);
		expect(headings.map(plain)).toEqual(["Profil"]);
	});

	it("lays a two-column template out as one table, with columns flowing across layout pages", () => {
		const data = twoPageResume();
		data.metadata.template = "azurill";
		const blocks = buildDocument(data, (id) => id).blocks;
		const tables = blocks.filter((block) => block.kind === "table");
		expect(tables).toHaveLength(1);
		const [table] = tables;
		if (table?.kind !== "table") throw new Error("expected a table");
		expect(table.cells.map((cell) => cell.width)).toEqual([
			data.metadata.layout.sidebarWidth,
			100 - data.metadata.layout.sidebarWidth,
		]);
		const [sidebar, main] = table.cells;
		const headings = (cellBlocks: Block[] | undefined) =>
			(cellBlocks ?? []).filter((block) => block.kind === "paragraph" && block.outlineLevel === 1).map(plain);
		expect(headings(main?.blocks)).toEqual(["summary", "experience"]);
		expect(headings(sidebar?.blocks)).toEqual(["skills", "languages"]);
		expect(sidebar?.background).toBeUndefined();
		// The header sits above the table for a full-width header template.
		expect(plain(blocks[0])).toBe(data.basics.name);
	});

	it("puts the sidebar on the side chosen in Design, else the template's own", () => {
		const data = twoPageResume();
		data.metadata.template = "azurill";
		data.metadata.layout.sidebarSide = "right";
		const [table] = buildDocument(data).blocks.filter((block) => block.kind === "table");
		if (table?.kind !== "table") throw new Error("expected a table");
		expect(table.cells[1]?.width).toBe(data.metadata.layout.sidebarWidth);
		expect(table.cells[0]?.padding.end).toBe(data.metadata.page.gapX / 2);
	});

	it("prints a one-column template top to bottom, sidebar sections after the main ones", () => {
		const data = twoPageResume();
		data.metadata.template = "onyx";
		const blocks = buildDocument(data, (id) => id).blocks;
		expect(blocks.some((block) => block.kind === "table")).toBe(false);
		const headings = blocks.filter((block) => block.kind === "paragraph" && block.outlineLevel === 1).map(plain);
		expect(headings).toEqual(["summary", "skills", "experience", "languages"]);
	});

	it("fills a solid sidebar with the primary color and inverts its text, once, with the header inside", () => {
		const data = twoPageResume();
		data.metadata.template = "chikorita";
		const blocks = buildDocument(data, (id) => id).blocks;
		expect(blocks).toHaveLength(1);
		const [table] = blocks;
		if (table?.kind !== "table") throw new Error("expected a table");
		const [main, sidebar] = table.cells;
		expect(sidebar?.background).toBe("#0070b2");
		expect(sidebar?.padding.top).toBeGreaterThan(0);
		const sidebarHeading = sidebar?.blocks.find((block) => block.kind === "paragraph" && block.outlineLevel === 1);
		expect(sidebarHeading?.kind === "paragraph" ? sidebarHeading.style?.text?.color : null).toBe("#ffffff");
		// A main-only header prints once, at the top of the main column, not on every layout page.
		const names = main?.blocks.filter((block) => plain(block) === data.basics.name);
		expect(names).toHaveLength(1);
		expect(plain(main?.blocks[0])).toBe(data.basics.name);
	});

	it("tints the sidebar of tinted templates and prints their header in the sidebar", () => {
		const data = twoPageResume();
		data.metadata.template = "gengar";
		const [table] = buildDocument(data).blocks;
		if (table?.kind !== "table") throw new Error("expected a table");
		const [sidebar] = table.cells;
		expect(sidebar?.background).toBe("#cce2f0");
		expect(plain(sidebar?.blocks[0])).toBe(data.basics.name);
	});

	it("mirrors right-to-left resumes", () => {
		const data = twoPageResume();
		data.metadata.template = "azurill";
		data.metadata.page.locale = "he-IL";
		const document = buildDocument(data);
		expect(document.page.rtl).toBe(true);
		const [, table] = document.blocks.filter((block) => block.kind !== "paragraph" || block.style?.parent === "Title");
		expect(table).toMatchObject({ kind: "table", rtl: true });
	});

	it("prints no resume header for a document holding only a cover letter", () => {
		const data = structuredClone(defaultResumeData);
		data.basics.name = "Ada Lovelace";
		data.customSections = [
			{
				id: "letter",
				type: "cover-letter",
				title: "Cover Letter",
				icon: "envelope",
				columns: 1,
				hidden: false,
				showHeading: true,
				keepTogether: false,
				startOnNewPage: false,
				items: [{ id: "item", hidden: false, recipient: "<p>Dear Jane,</p>", content: "<p>Hire me.</p>" }],
			},
		];
		data.metadata.layout.pages = [{ fullWidth: true, main: ["letter"], sidebar: [] }];
		const blocks = buildDocument(data).blocks;
		expect(blocks.map(plain)).toEqual(["Dear Jane,", "Hire me."]);
	});
});
