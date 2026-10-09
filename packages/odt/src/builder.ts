import type { OdtDocument } from "./document";
import type { Block, Inline, Paragraph, TableCell } from "./model";
import type { RenderConfig } from "./section-renderers";
import type { LayoutPage, ResumeData, SectionType } from "@reactive-resume/schema/resume/data";
import type { Template } from "@reactive-resume/schema/templates";
import { templateLayouts } from "@reactive-resume/schema/templates";
import { parseColorString } from "@reactive-resume/utils/color";
import { isRTL } from "@reactive-resume/utils/locale";
import { shouldShowResumeHeader } from "./cover-letter";
import { toSafeOdtLink } from "./link-utils";
import { link, paragraph, text } from "./model";
import { renderBuiltInSection, renderCustomSection, renderSummary } from "./section-renderers";

// --- Color helpers ---

function toHex(rgba: string, fallback: string): string {
	const parsed = parseColorString(rgba);
	if (!parsed) return fallback;
	return `#${[parsed.r, parsed.g, parsed.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Blends a hex color toward white at the given opacity, as `rgba(r, g, b, opacity)` prints on a white page. */
function blendWithWhite(hex: string, opacity: number): string {
	const blend = (channel: string) =>
		Math.round(Number.parseInt(channel, 16) * opacity + 255 * (1 - opacity))
			.toString(16)
			.padStart(2, "0");
	return `#${blend(hex.slice(1, 3))}${blend(hex.slice(3, 5))}${blend(hex.slice(5, 7))}`;
}

// --- Page geometry ---

const MM_PER_PT = 25.4 / 72;

// Pages in Writer have a fixed size; free-form resumes intentionally fall back to A4.
const A4_PAGE_SIZE = { width: 210, height: 297 };
const LETTER_PAGE_SIZE = { width: 215.9, height: 279.4 };

const DEFAULT_FONT = "Liberation Sans";

// Sidebar and header placement come from `templateLayouts`, as in the PDF and DOCX; only the sidebar's background
// is the export's own: "solid" fills it with the primary colour (text inverts), "tint" with 20% of it.
const SIDEBAR_BACKGROUND: Partial<Record<Template, "solid" | "tint">> = {
	chikorita: "solid",
	ditgar: "tint",
	gengar: "tint",
	glalie: "tint",
};

type PagePlan = { kind: "single"; sections: string[] } | { kind: "split" };

/**
 * How a layout page prints, as in the PDF: a full-width page prints no sidebar, a one-column template prints its
 * sidebar sections after the main ones, and only a two-column template with sidebar sections splits the page.
 */
export function planPageColumns(page: LayoutPage, template: Template): PagePlan {
	const sidebar = page.fullWidth ? [] : page.sidebar;
	if (templateLayouts[template].columns === 1 || sidebar.length === 0) {
		return { kind: "single", sections: [...page.main, ...sidebar] };
	}
	return { kind: "split" };
}

// --- Section rendering dispatch ---

/** Resolves a section's (usually empty) stored title from its id — locale-aware, supplied by the caller. */
export type SectionTitleResolver = (sectionId: string) => string | undefined;

function renderSection(
	sectionId: string,
	data: ResumeData,
	config: RenderConfig,
	resolveTitle?: SectionTitleResolver,
): Paragraph[] {
	const titled = <T extends { title: string }>(section: T): T => ({
		...section,
		title: resolveTitle?.(sectionId)?.trim() || section.title,
	});

	if (sectionId === "summary") return renderSummary(titled(data.summary), config);

	if (sectionId in data.sections) {
		const section = data.sections[sectionId as SectionType];
		return section ? renderBuiltInSection(sectionId as SectionType, titled(section), config) : [];
	}

	const customSection = data.customSections.find((section) => section.id === sectionId);
	return customSection ? renderCustomSection(titled(customSection), config) : [];
}

// --- Header ---

function buildHeader(data: ResumeData, config: RenderConfig): Paragraph[] {
	const paragraphs: Paragraph[] = [];
	const { basics } = data;
	const run = { font: config.bodyFont, size: config.bodySize, color: config.textColor };
	const linkRun = { ...run, color: config.primaryColor, underline: true };

	if (basics.name) {
		paragraphs.push(
			paragraph([text(basics.name)], {
				style: {
					parent: "Title",
					spacingAfter: 3,
					text: { font: config.headingFont, size: config.headingSize * 1.25, bold: true, color: config.primaryColor },
				},
			}),
		);
	}

	if (basics.headline) {
		paragraphs.push(paragraph([text(basics.headline, { ...run, italics: true })], { style: { spacingAfter: 3 } }));
	}

	const contact: Inline[] = [];
	const add = (...inlines: Inline[]) => {
		if (contact.length > 0) contact.push(text("  |  ", { ...run, color: "#999999" }));
		contact.push(...inlines);
	};

	const mailto = basics.email ? toSafeOdtLink(`mailto:${basics.email}`) : null;
	if (mailto) add(link(mailto, [text(basics.email, linkRun)]));
	if (basics.phone) add(text(basics.phone, run));
	if (basics.location) add(text(basics.location, run));

	const website = basics.website.url ? toSafeOdtLink(basics.website.url) : null;
	if (website) add(link(website, [text(basics.website.label || website, linkRun)]));

	for (const field of basics.customFields) {
		if (!field.text) continue;
		const target = field.link ? toSafeOdtLink(field.link) : null;
		add(target ? link(target, [text(field.text, linkRun)]) : text(field.text, run));
	}

	if (contact.length > 0) paragraphs.push(paragraph(contact, { style: { spacingAfter: 10 } }));

	return paragraphs;
}

/**
 * Builds the document from resume data.
 *
 * Mirrors the resume builder's visual layout, as the DOCX export does:
 * - Header with name, headline and contact details
 * - Two-column table layout (main + sidebar) matching `metadata.layout` and the template's column plan
 * - Typography (font family, size, line height) from `metadata.typography`
 * - Page margins and fixed page format from `metadata.page`; free-form exports as A4
 * - Primary, text and background colors from `metadata.design.colors`
 */
export function buildDocument(data: ResumeData, resolveTitle?: SectionTitleResolver): OdtDocument {
	const { colors } = data.metadata.design;
	const primaryColor = toHex(colors.primary, "#dc2626");
	const textColor = toHex(colors.text, "#000000");
	const backgroundColor = toHex(colors.background, "#ffffff");

	const { typography, page, layout: pageLayout, template } = data.metadata;
	const bodyFont = typography.body.fontFamily || DEFAULT_FONT;
	const headingFont = typography.heading.fontFamily || DEFAULT_FONT;

	const pageSize = page.format === "letter" ? LETTER_PAGE_SIZE : A4_PAGE_SIZE;
	const textWidth = pageSize.width / MM_PER_PT - 2 * page.marginX;
	const rtl = isRTL(page.locale);

	const layout = templateLayouts[template];
	const background = SIDEBAR_BACKGROUND[template];
	const sidebarBackground =
		background === "solid" ? primaryColor : background === "tint" ? blendWithWhite(primaryColor, 0.2) : undefined;
	const sidebarWidth = (textWidth * pageLayout.sidebarWidth) / 100;
	const columnGap = page.gapX / 2;
	// Text on a shaded sidebar keeps clear of its edges; on a solid one it inverts.
	const sidebarPadding = sidebarBackground ? columnGap : 0;
	const sidebarTextColor = background === "solid" ? backgroundColor : textColor;
	const sidebarPrimaryColor = background === "solid" ? backgroundColor : primaryColor;

	const mainConfig: RenderConfig = {
		headingFont,
		headingSize: typography.heading.fontSize,
		bodyFont,
		bodySize: typography.body.fontSize,
		textColor,
		primaryColor,
		lineHeight: typography.body.lineHeight,
		textWidth,
	};
	const splitMainConfig: RenderConfig = { ...mainConfig, textWidth: textWidth - sidebarWidth - columnGap };
	const sidebarConfig: RenderConfig = {
		...mainConfig,
		textColor: sidebarTextColor,
		primaryColor: sidebarPrimaryColor,
		textWidth: sidebarWidth - columnGap - sidebarPadding,
	};

	// The header prints once, on the first page, where the template puts it: across the page, over the main column
	// or in the sidebar. A one-column first page prints it at the top either way.
	let headerPending = shouldShowResumeHeader(data);
	const takeHeader = (config: RenderConfig): Paragraph[] => {
		if (!headerPending) return [];
		headerPending = false;
		return buildHeader(data, config);
	};
	const blocks: Block[] = [];
	const sidebarSide = pageLayout.sidebarSide ?? layout.sidebarSide ?? "left";

	// Consecutive two-column pages share one table, so the columns flow on without a seam between them.
	let columns: { main: Block[]; sidebar: Block[] } | null = null;
	const flushColumns = () => {
		if (columns && (columns.main.length > 0 || columns.sidebar.length > 0)) {
			const sidebarCell: TableCell = {
				blocks: columns.sidebar,
				width: pageLayout.sidebarWidth,
				padding: {
					top: sidebarPadding,
					bottom: sidebarPadding,
					start: sidebarSide === "left" ? sidebarPadding : columnGap,
					end: sidebarSide === "left" ? columnGap : sidebarPadding,
				},
				...(sidebarBackground ? { background: sidebarBackground } : {}),
			};
			const mainCell: TableCell = {
				blocks: columns.main,
				width: 100 - pageLayout.sidebarWidth,
				padding: {
					top: 0,
					bottom: 0,
					start: sidebarSide === "left" ? columnGap : 0,
					end: sidebarSide === "left" ? 0 : columnGap,
				},
			};
			blocks.push({
				kind: "table",
				width: textWidth,
				cells: sidebarSide === "left" ? [sidebarCell, mainCell] : [mainCell, sidebarCell],
				rtl,
			});
		}
		columns = null;
	};

	if (layout.headerPlacement === "full-width") blocks.push(...takeHeader(mainConfig));

	for (const layoutPage of pageLayout.pages) {
		const plan = planPageColumns(layoutPage, template);

		if (plan.kind === "single") {
			flushColumns();
			blocks.push(...takeHeader(mainConfig));
			for (const sectionId of plan.sections) blocks.push(...renderSection(sectionId, data, mainConfig, resolveTitle));
			continue;
		}

		columns ??= { main: [], sidebar: [] };
		if (layout.headerPlacement === "main-only") columns.main.push(...takeHeader(splitMainConfig));
		for (const sectionId of layoutPage.main) {
			columns.main.push(...renderSection(sectionId, data, splitMainConfig, resolveTitle));
		}
		if (layout.headerPlacement === "sidebar-only") columns.sidebar.push(...takeHeader(sidebarConfig));
		for (const sectionId of layoutPage.sidebar) {
			columns.sidebar.push(...renderSection(sectionId, data, sidebarConfig, resolveTitle));
		}
	}
	flushColumns();

	return {
		title: data.basics.name,
		blocks,
		page: {
			width: pageSize.width,
			height: pageSize.height,
			marginX: page.marginX,
			marginY: page.marginY,
			...(backgroundColor === "#ffffff" ? {} : { background: backgroundColor }),
			rtl,
		},
		defaults: {
			bodyFont,
			bodySize: typography.body.fontSize,
			headingFont,
			headingSize: typography.heading.fontSize,
			textColor,
			primaryColor,
			lineHeight: typography.body.lineHeight,
		},
	};
}
