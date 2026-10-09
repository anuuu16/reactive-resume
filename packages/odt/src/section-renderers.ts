import type { HtmlStyleConfig } from "./html-to-odt";
import type { Inline, Paragraph, TextStyle } from "./model";
import type { CustomSection, CustomSectionType, ResumeData, SectionType } from "@reactive-resume/schema/resume/data";
import { htmlToParagraphs } from "./html-to-odt";
import { toSafeOdtLink } from "./link-utils";
import { link, paragraph, tab, text } from "./model";

type Sections = ResumeData["sections"];

/** Typography, colors and the column width every section renderer prints with. Sizes in points. */
export type RenderConfig = {
	headingFont: string;
	headingSize: number;
	bodyFont: string;
	bodySize: number;
	textColor: string;
	primaryColor: string;
	/** Line height as a multiplier of the body size. */
	lineHeight: number;
	/** Width of the column the text flows in; dates right-align against it. */
	textWidth: number;
};

/** Rich text keeps the PDF's prose rhythm: a fifth of the line height above and below each paragraph. */
const htmlStyle = (config: RenderConfig): HtmlStyleConfig => ({
	font: config.bodyFont,
	size: config.bodySize,
	color: config.textColor,
	linkColor: config.primaryColor,
	paragraphSpacing: config.bodySize * config.lineHeight * 0.2,
});

/** Font, size and color shared by every run a section renderer prints. */
const baseRun = (config: RenderConfig): TextStyle => ({
	font: config.bodyFont,
	size: config.bodySize,
	color: config.textColor,
});

/** A section heading: primary color, a rule beneath it, and the heading typography at the template's h6 size. */
function sectionHeading(title: string, config: RenderConfig): Paragraph {
	return paragraph([text(title)], {
		outlineLevel: 1,
		style: {
			parent: "Heading_20_1",
			spacingBefore: 12,
			spacingAfter: 6,
			keepWithNext: true,
			borderBottom: { width: 0.5, color: config.primaryColor },
			paddingBottom: 2,
			text: { font: config.headingFont, size: config.headingSize * 0.75, bold: true, color: config.primaryColor },
		},
	});
}

function sectionHeadingParagraph<T extends { showHeading?: boolean | undefined }>(
	section: T,
	title: string,
	config: RenderConfig,
): Paragraph[] {
	return section.showHeading !== false && title ? [sectionHeading(title, config)] : [];
}

/** `Primary — Secondary` with an optional date pushed to the right edge by a tab stop. */
function titleAndSubtitle(
	primary: string,
	secondary: string,
	config: RenderConfig,
	rightText?: string,
	bold = true,
): Paragraph {
	const run = baseRun(config);
	const children: Inline[] = [text(primary, { ...run, bold })];

	if (secondary) children.push(text(` — ${secondary}`, run));
	if (rightText) children.push(tab(), text(rightText, { ...run, italics: true }));

	return paragraph(children, {
		style: { spacingBefore: 6, keepWithNext: true, tabStops: [{ position: config.textWidth, type: "right" }] },
	});
}

function locationAndPeriod(location: string, period: string, config: RenderConfig): Paragraph | null {
	const parts = [location, period].filter(Boolean);
	if (parts.length === 0) return null;

	return paragraph([text(parts.join(" | "), { ...baseRun(config), italics: true })], { style: { spacingAfter: 3 } });
}

function websiteParagraph(url: string, label: string, config: RenderConfig): Paragraph | null {
	const safeUrl = toSafeOdtLink(url);
	if (!safeUrl) return null;

	const run = { ...baseRun(config), color: config.primaryColor, underline: true };
	return paragraph([link(safeUrl, [text(label || safeUrl, run)])], { style: { spacingAfter: 3 } });
}

function visibleItems<T extends { hidden: boolean }>(section: { hidden: boolean; items: T[] }): T[] {
	if (section.hidden) return [];
	return section.items.filter((item) => !item.hidden);
}

// --- Section-specific renderers ---

export function renderSummary(summary: ResumeData["summary"], config: RenderConfig): Paragraph[] {
	if (summary.hidden || !summary.content) return [];

	return [
		...sectionHeadingParagraph(summary, summary.title, config),
		...htmlToParagraphs(summary.content, htmlStyle(config)),
	];
}

function renderExperience(section: Sections["experience"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);
	const run = baseRun(config);

	for (const item of items) {
		const roles = item.roles.filter((role) => role.position.trim());
		if (roles.length > 0) {
			paragraphs.push(titleAndSubtitle(item.company, "", config, item.period));

			const location = locationAndPeriod(item.location, "", config);
			if (location) paragraphs.push(location);

			for (const role of roles) {
				paragraphs.push(
					paragraph(
						[
							text(role.position, { ...run, bold: true, italics: true }),
							...(role.period ? [text(` — ${role.period}`, { ...run, italics: true })] : []),
						],
						{ style: { spacingBefore: 4 } },
					),
				);
				if (role.description) paragraphs.push(...htmlToParagraphs(role.description, htmlStyle(config)));
			}
		} else {
			paragraphs.push(titleAndSubtitle(item.company, item.position, config, item.period));

			const location = locationAndPeriod(item.location, "", config);
			if (location) paragraphs.push(location);
		}
		if (item.description) paragraphs.push(...htmlToParagraphs(item.description, htmlStyle(config)));

		const website = websiteParagraph(item.website.url, item.website.label, config);
		if (website) paragraphs.push(website);
	}

	return paragraphs;
}

function renderEducation(section: Sections["education"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);
	const run = baseRun(config);

	for (const item of items) {
		const degreeArea = [item.degree, item.area].filter(Boolean).join(", ");
		paragraphs.push(titleAndSubtitle(item.school, degreeArea, config, item.period));

		if (item.grade) paragraphs.push(paragraph([text(`Grade: ${item.grade}`, { ...run, italics: true })]));

		const location = locationAndPeriod(item.location, "", config);
		if (location) paragraphs.push(location);

		if (item.description) paragraphs.push(...htmlToParagraphs(item.description, htmlStyle(config)));

		const website = websiteParagraph(item.website.url, item.website.label, config);
		if (website) paragraphs.push(website);
	}

	return paragraphs;
}

function renderProjects(section: Sections["projects"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);

	for (const item of items) {
		paragraphs.push(titleAndSubtitle(item.name, "", config, item.period));

		if (item.description) paragraphs.push(...htmlToParagraphs(item.description, htmlStyle(config)));

		const website = websiteParagraph(item.website.url, item.website.label, config);
		if (website) paragraphs.push(website);
	}

	return paragraphs;
}

function renderSkills(section: Sections["skills"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);
	const run = baseRun(config);

	for (const item of items) {
		const children: Inline[] = [text(item.name, { ...run, bold: true })];

		if (item.proficiency) children.push(text(` — ${item.proficiency}`, run));
		if (section.keywordLayout !== "list" && item.keywords.length > 0) {
			children.push(text(`: ${item.keywords.join(", ")}`, run));
		}

		paragraphs.push(paragraph(children, { style: { spacingBefore: 3 } }));
		if (section.keywordLayout === "list") {
			for (const keyword of item.keywords) {
				paragraphs.push(paragraph([text(keyword, run)], { bullet: { level: 0 } }));
			}
		}
	}

	return paragraphs;
}

function renderLanguages(section: Sections["languages"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);
	const run = baseRun(config);

	for (const item of items) {
		const children: Inline[] = [text(item.language, { ...run, bold: true })];
		if (item.fluency) children.push(text(` — ${item.fluency}`, run));
		paragraphs.push(paragraph(children, { style: { spacingBefore: 3 } }));
	}

	return paragraphs;
}

function renderInterests(section: Sections["interests"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);
	const run = baseRun(config);

	for (const item of items) {
		const children: Inline[] = [text(item.name, { ...run, bold: true })];
		if (item.keywords.length > 0) children.push(text(`: ${item.keywords.join(", ")}`, run));
		paragraphs.push(paragraph(children, { style: { spacingBefore: 3 } }));
	}

	return paragraphs;
}

/** Entries with a title, an issuer, a date, a description and a link: awards, certifications, publications. */
function renderDatedEntries<T extends { hidden: boolean }>(
	section: { hidden: boolean; title: string; showHeading?: boolean | undefined; items: T[] },
	config: RenderConfig,
	map: (item: T) => {
		title: string;
		subtitle: string;
		date: string;
		description: string;
		website: ResumeData["basics"]["website"];
		boldTitle?: boolean;
	},
): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);

	for (const item of items) {
		const entry = map(item);
		paragraphs.push(titleAndSubtitle(entry.title, entry.subtitle, config, entry.date, entry.boldTitle ?? true));

		if (entry.description) paragraphs.push(...htmlToParagraphs(entry.description, htmlStyle(config)));

		const website = websiteParagraph(entry.website.url, entry.website.label, config);
		if (website) paragraphs.push(website);
	}

	return paragraphs;
}

const renderAwards = (section: Sections["awards"], config: RenderConfig) =>
	renderDatedEntries(section, config, (item) => ({
		title: item.title,
		subtitle: item.awarder,
		date: item.date,
		description: item.description,
		website: item.website,
		boldTitle: false,
	}));

const renderCertifications = (section: Sections["certifications"], config: RenderConfig) =>
	renderDatedEntries(section, config, (item) => ({
		title: item.title,
		subtitle: item.issuer,
		date: item.date,
		description: item.description,
		website: item.website,
	}));

const renderPublications = (section: Sections["publications"], config: RenderConfig) =>
	renderDatedEntries(section, config, (item) => ({
		title: item.title,
		subtitle: item.publisher,
		date: item.date,
		description: item.description,
		website: item.website,
	}));

function renderVolunteer(section: Sections["volunteer"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);

	for (const item of items) {
		paragraphs.push(titleAndSubtitle(item.organization, "", config, item.period));

		const location = locationAndPeriod(item.location, "", config);
		if (location) paragraphs.push(location);

		if (item.description) paragraphs.push(...htmlToParagraphs(item.description, htmlStyle(config)));

		const website = websiteParagraph(item.website.url, item.website.label, config);
		if (website) paragraphs.push(website);
	}

	return paragraphs;
}

function renderReferences(section: Sections["references"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);
	const run = baseRun(config);

	for (const item of items) {
		const children: Inline[] = [text(item.name, { ...run, bold: true })];
		if (item.position) children.push(text(` — ${item.position}`, run));
		paragraphs.push(paragraph(children, { style: { spacingBefore: 6 } }));

		if (item.phone) paragraphs.push(paragraph([text(item.phone, run)]));

		if (item.description) paragraphs.push(...htmlToParagraphs(item.description, htmlStyle(config)));

		const website = websiteParagraph(item.website.url, item.website.label, config);
		if (website) paragraphs.push(website);
	}

	return paragraphs;
}

function renderProfiles(section: Sections["profiles"], config: RenderConfig): Paragraph[] {
	const items = visibleItems(section);
	if (items.length === 0) return [];

	const paragraphs = sectionHeadingParagraph(section, section.title, config);
	const run = baseRun(config);

	for (const item of items) {
		const children: Inline[] = [text(item.network, { ...run, bold: true })];
		if (item.username) children.push(text(` — ${item.username}`, run));
		paragraphs.push(paragraph(children, { style: { spacingBefore: 3 } }));

		const website = websiteParagraph(item.website.url, item.website.label, config);
		if (website) paragraphs.push(website);
	}

	return paragraphs;
}

type SectionRenderer = (section: Sections[SectionType], config: RenderConfig) => Paragraph[];

/** Mapping from built-in section type to its renderer. */
const sectionRenderers: Record<SectionType, SectionRenderer> = {
	experience: renderExperience as SectionRenderer,
	education: renderEducation as SectionRenderer,
	projects: renderProjects as SectionRenderer,
	skills: renderSkills as SectionRenderer,
	languages: renderLanguages as SectionRenderer,
	interests: renderInterests as SectionRenderer,
	awards: renderAwards as SectionRenderer,
	certifications: renderCertifications as SectionRenderer,
	publications: renderPublications as SectionRenderer,
	volunteer: renderVolunteer as SectionRenderer,
	references: renderReferences as SectionRenderer,
	profiles: renderProfiles as SectionRenderer,
};

/** Renders a built-in section by type. */
export function renderBuiltInSection(
	type: SectionType,
	section: Sections[SectionType],
	config: RenderConfig,
): Paragraph[] {
	const renderer = sectionRenderers[type];
	if (!renderer) return [];
	return renderer(section, config);
}

/** Renders a custom section by dispatching to the matching built-in renderer based on its type. */
export function renderCustomSection(section: CustomSection, config: RenderConfig): Paragraph[] {
	if (section.hidden) return [];

	const items = section.items.filter((item) => !item.hidden);
	if (items.length === 0) return [];

	const sectionType = section.type as CustomSectionType;

	// Summary-type custom sections render HTML content
	if (sectionType === "summary") {
		const paragraphs = sectionHeadingParagraph(section, section.title, config);
		for (const item of items) {
			if ("content" in item && item.content) paragraphs.push(...htmlToParagraphs(item.content, htmlStyle(config)));
		}
		return paragraphs;
	}

	// Cover letter type — render recipient + content
	if (sectionType === "cover-letter") {
		const paragraphs: Paragraph[] = [];
		for (const item of items) {
			if ("recipient" in item && item.recipient) {
				paragraphs.push(...htmlToParagraphs(item.recipient, htmlStyle(config)));
			}
			if ("content" in item && item.content) paragraphs.push(...htmlToParagraphs(item.content, htmlStyle(config)));
		}
		return paragraphs;
	}

	// Build a synthetic section matching the built-in type for the renderer
	const sectionKey = sectionType as SectionType;
	if (sectionKey in sectionRenderers) {
		const syntheticSection = {
			...(section.type === "skills" ? { keywordLayout: section.keywordLayout } : {}),
			title: section.title,
			columns: section.columns,
			hidden: false,
			showHeading: section.showHeading,
			items,
		} as Sections[SectionType];

		return renderBuiltInSection(sectionKey, syntheticSection, config);
	}

	return [];
}
