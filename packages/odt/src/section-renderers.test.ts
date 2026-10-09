import type { RenderConfig } from "./section-renderers";
import type { CustomSection, ResumeData } from "@reactive-resume/schema/resume/data";
import { describe, expect, it } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { getDefaultSectionIconName } from "@reactive-resume/schema/resume/section-icons";
import { renderBuiltInSection, renderCustomSection, renderSummary } from "./section-renderers";

const config: RenderConfig = {
	headingFont: "Inter",
	headingSize: 14,
	bodyFont: "Inter",
	bodySize: 10,
	textColor: "#111111",
	primaryColor: "#0563c1",
	lineHeight: 1.5,
	textWidth: 500,
};

const summary = (overrides: Partial<ResumeData["summary"]>): ResumeData["summary"] => ({
	title: "Summary",
	icon: getDefaultSectionIconName("summary"),
	content: "<p>Hello world</p>",
	hidden: false,
	showHeading: true,
	columns: 1,
	keepTogether: false,
	startOnNewPage: false,
	...overrides,
});

describe("renderSummary", () => {
	it("returns nothing when the section is hidden or empty", () => {
		expect(renderSummary(summary({ hidden: true }), config)).toEqual([]);
		expect(renderSummary(summary({ content: "" }), config)).toEqual([]);
	});

	it("prints a section heading in the primary color with a rule beneath, then the content", () => {
		const [heading, content] = renderSummary(summary({}), config);
		expect(heading).toMatchObject({
			outlineLevel: 1,
			children: [{ kind: "text", text: "Summary" }],
			style: {
				parent: "Heading_20_1",
				borderBottom: { width: 0.5, color: "#0563c1" },
				text: { font: "Inter", size: 10.5, bold: true, color: "#0563c1" },
			},
		});
		expect(content?.children).toEqual([
			{ kind: "text", text: "Hello world", style: { font: "Inter", size: 10, color: "#111111" } },
		]);
	});

	it("omits a disabled heading while retaining summary content", () => {
		expect(renderSummary(summary({ showHeading: false }), config)).toHaveLength(1);
	});
});

describe("renderBuiltInSection", () => {
	it("prints an experience entry with its date at the right tab stop, then location, description and link", () => {
		const section = structuredClone(defaultResumeData.sections.experience);
		section.title = "Experience";
		section.items = [
			{
				id: "one",
				hidden: false,
				company: "Acme",
				position: "Engineer",
				location: "Berlin",
				period: "2020 – 2022",
				website: { url: "https://acme.example", label: "", inlineLink: false },
				description: "<ul><li><p>Built things</p></li></ul>",
				roles: [],
			},
		];
		const paragraphs = renderBuiltInSection("experience", section, config);
		expect(paragraphs.map((paragraph) => paragraph.children)).toEqual([
			[{ kind: "text", text: "Experience" }],
			[
				{ kind: "text", text: "Acme", style: { font: "Inter", size: 10, color: "#111111", bold: true } },
				{ kind: "text", text: " — Engineer", style: { font: "Inter", size: 10, color: "#111111" } },
				{ kind: "tab" },
				{ kind: "text", text: "2020 – 2022", style: { font: "Inter", size: 10, color: "#111111", italics: true } },
			],
			[{ kind: "text", text: "Berlin", style: { font: "Inter", size: 10, color: "#111111", italics: true } }],
			[{ kind: "text", text: "Built things", style: { font: "Inter", size: 10, color: "#111111" } }],
			[
				{
					kind: "link",
					href: "https://acme.example/",
					children: [
						{
							kind: "text",
							text: "https://acme.example/",
							style: { font: "Inter", size: 10, color: "#0563c1", underline: true },
						},
					],
				},
			],
		]);
		expect(paragraphs[1]?.style?.tabStops).toEqual([{ position: 500, type: "right" }]);
		expect(paragraphs[3]?.bullet).toEqual({ level: 0, ordered: false });
	});

	it("prints each role of a multi-role experience entry", () => {
		const section = structuredClone(defaultResumeData.sections.experience);
		section.items = [
			{
				id: "one",
				hidden: false,
				company: "Acme",
				position: "",
				location: "",
				period: "2018 – 2022",
				website: { url: "", label: "", inlineLink: false },
				description: "",
				roles: [
					{ id: "r1", position: "Senior", period: "2020 – 2022", description: "<p>Led</p>" },
					{ id: "r2", position: "Junior", period: "2018 – 2020", description: "" },
				],
			},
		];
		const lines = renderBuiltInSection("experience", { ...section, title: "Experience" }, config).map((paragraph) =>
			paragraph.children.map((child) => (child.kind === "text" ? child.text : `<${child.kind}>`)).join(""),
		);
		expect(lines).toEqual([
			"Experience",
			"Acme<tab>2018 – 2022",
			"Senior — 2020 – 2022",
			"Led",
			"Junior — 2018 – 2020",
		]);
	});

	it("leaves out hidden sections and items", () => {
		const section = structuredClone(defaultResumeData.sections.languages);
		section.items = [
			{ id: "shown", hidden: false, language: "English", fluency: "Native", level: 5 },
			{ id: "hidden", hidden: true, language: "Klingon", fluency: "", level: 1 },
		];
		const json = JSON.stringify(renderBuiltInSection("languages", { ...section, title: "Languages" }, config));
		expect(json).toContain("English");
		expect(json).toContain(" — Native");
		expect(json).not.toContain("Klingon");
		expect(renderBuiltInSection("languages", { ...section, hidden: true }, config)).toEqual([]);
	});
});

describe("renderCustomSection", () => {
	const baseCustom: CustomSection = {
		id: "custom-1",
		type: "summary",
		title: "Notes",
		icon: getDefaultSectionIconName("summary"),
		columns: 1,
		hidden: false,
		showHeading: true,
		keepTogether: false,
		startOnNewPage: false,
		items: [],
	};

	it("returns nothing when all items are hidden or empty", () => {
		expect(renderCustomSection({ ...baseCustom, items: [{ id: "x", hidden: true } as never] }, config)).toEqual([]);
	});

	it("renders recipient and content for a cover-letter custom section, without a heading", () => {
		const section: CustomSection = {
			...baseCustom,
			type: "cover-letter",
			title: "Cover Letter",
			items: [{ id: "x", hidden: false, recipient: "<p>Dear Jane,</p>", content: "<p>Body</p>" } as never],
		};
		const paragraphs = renderCustomSection(section, config);
		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[0]?.outlineLevel).toBeUndefined();
	});

	it("lists skill keywords as bullets when the section asks for a list", () => {
		const section = structuredClone(defaultResumeData.sections.skills);
		Object.assign(section, { keywordLayout: "list" });
		section.items = [
			{
				id: "one",
				hidden: false,
				name: "Engineering",
				proficiency: "Expert",
				level: 3,
				icon: "",
				iconColor: "",
				keywords: ["Alpha", "Beta", "Gamma"],
			},
		];
		const paragraphs = renderCustomSection({ ...section, id: "custom", type: "skills", title: "Skills" }, config);
		expect(paragraphs.filter((paragraph) => paragraph.bullet)).toHaveLength(3);
		expect(JSON.stringify(paragraphs)).not.toContain("Alpha, Beta");
		const inline = renderCustomSection(
			{ ...section, keywordLayout: "inline", id: "custom", type: "skills", title: "Skills" },
			config,
		);
		expect(JSON.stringify(inline)).toContain(": Alpha, Beta, Gamma");
	});
});
