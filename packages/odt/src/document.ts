import type { Block, Image, Inline, Paragraph, Table } from "./model";
import { strToU8, zipSync } from "fflate";
import { AutomaticStyles, fontFaceDeclarations, textProperties } from "./styles";
import { attributes, escapeXml, pt, textContent } from "./xml";

export const ODT_MIME_TYPE = "application/vnd.oasis.opendocument.text";

type PageSettings = {
	/** Page size in millimetres. */
	width: number;
	height: number;
	/** Margins in points. */
	marginX: number;
	marginY: number;
	background?: string;
	rtl: boolean;
};

type DocumentDefaults = {
	bodyFont: string;
	bodySize: number;
	headingFont: string;
	headingSize: number;
	textColor: string;
	primaryColor: string;
	/** Multiplier of the font size. */
	lineHeight: number;
};

/** A file packaged under `Pictures/`, referenced by an image in the text. */
export type PackagedPicture = { path: string; bytes: Uint8Array; mediaType: string };

export type OdtDocument = {
	title: string;
	blocks: Block[];
	page: PageSettings;
	defaults: DocumentDefaults;
	pictures?: PackagedPicture[];
};

const NAMESPACES = attributes({
	"xmlns:office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
	"xmlns:style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
	"xmlns:text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
	"xmlns:table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
	"xmlns:draw": "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
	"xmlns:fo": "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
	"xmlns:xlink": "http://www.w3.org/1999/xlink",
	"xmlns:svg": "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
	"xmlns:dc": "http://purl.org/dc/elements/1.1/",
	"xmlns:meta": "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
	"office:version": "1.2",
});

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** Indent of each list level, and the hanging space for its bullet or number. */
const LIST_LEVEL_INDENT_PT = 36;
const LIST_LABEL_WIDTH_PT = 18;
const LIST_LEVELS = 10;

const BULLET_LIST_STYLE = "List_20_Bullet";
const NUMBER_LIST_STYLE = "List_20_Number";

// --- content.xml ---

class ContentWriter {
	readonly styles = new AutomaticStyles();
	private pictures = 1;

	blocks(blocks: Block[]): string {
		let xml = "";
		let index = 0;
		while (index < blocks.length) {
			const block = blocks[index];
			if (!block) break;
			if (block.kind === "table") {
				xml += this.table(block);
				index += 1;
				continue;
			}
			if (!block.bullet) {
				xml += this.paragraph(block);
				index += 1;
				continue;
			}
			// Consecutive list paragraphs form one list; a new top-level item of the other kind starts another.
			const ordered = block.bullet.ordered ?? false;
			let end = index + 1;
			while (end < blocks.length) {
				const next = blocks[end];
				if (next?.kind !== "paragraph" || !next.bullet) break;
				if (next.bullet.level === 0 && (next.bullet.ordered ?? false) !== ordered) break;
				end += 1;
			}
			xml += this.list(blocks.slice(index, end) as Paragraph[], 0, ordered ? NUMBER_LIST_STYLE : BULLET_LIST_STYLE);
			index = end;
		}
		return xml;
	}

	private list(items: Paragraph[], level: number, styleName?: string): string {
		let xml = `<text:list${styleName ? attributes({ "text:style-name": styleName }) : ""}>`;
		const deeperRun = (from: number) => {
			let end = from;
			while (end < items.length && (items[end]?.bullet?.level ?? 0) > level) end += 1;
			return end;
		};
		let index = 0;
		while (index < items.length) {
			const item = items[index];
			if (!item?.bullet) break;
			if (item.bullet.level > level) {
				// Deeper items without a parent at this level still nest, inside an item of their own.
				const end = deeperRun(index);
				xml += `<text:list-item>${this.list(items.slice(index, end), level + 1)}</text:list-item>`;
				index = end;
				continue;
			}
			// The item's own paragraph, then its continuation paragraphs and nested lists in order.
			let itemXml = this.paragraph(item, level);
			index += 1;
			while (index < items.length) {
				const next = items[index];
				if (!next?.bullet) break;
				if (next.bullet.level > level) {
					const end = deeperRun(index);
					itemXml += this.list(items.slice(index, end), level + 1);
					index = end;
				} else if (next.bullet.level === level && next.bullet.continuation) {
					itemXml += this.paragraph(next, level);
					index += 1;
				} else break;
			}
			xml += `<text:list-item>${itemXml}</text:list-item>`;
		}
		return `${xml}</text:list>`;
	}

	private paragraph(block: Paragraph, listLevel?: number): string {
		let style = block.style;
		// A list paragraph with an inset of its own (inside a quote) keeps the list's hanging label.
		if (listLevel !== undefined && style?.marginStart) {
			style = {
				...style,
				marginStart: style.marginStart + (listLevel + 1) * LIST_LEVEL_INDENT_PT,
				textIndent: -LIST_LABEL_WIDTH_PT,
			};
		}
		const tag = block.outlineLevel ? "text:h" : "text:p";
		const attrs = attributes({
			"text:style-name": this.styles.paragraph(style),
			"text:outline-level": block.outlineLevel,
		});
		return `<${tag}${attrs}>${this.inlines(block.children, true)}</${tag}>`;
	}

	private inlines(children: Inline[], atParagraphStart: boolean): string {
		let xml = "";
		let atStart = atParagraphStart;
		for (const child of children) {
			switch (child.kind) {
				case "text": {
					const content = textContent(child.text, atStart);
					const span = this.styles.span(child.style);
					xml += span ? `<text:span${attributes({ "text:style-name": span })}>${content}</text:span>` : content;
					atStart = false;
					break;
				}
				case "link":
					xml += `<text:a${attributes({
						"xlink:type": "simple",
						"xlink:href": child.href,
						"text:style-name": "Internet_20_link",
						"text:visited-style-name": "Visited_20_Internet_20_Link",
					})}>${this.inlines(child.children, atStart)}</text:a>`;
					atStart = false;
					break;
				case "break":
					xml += "<text:line-break/>";
					atStart = true;
					break;
				case "tab":
					xml += "<text:tab/>";
					atStart = false;
					break;
				case "image":
					xml += this.image(child);
					atStart = false;
					break;
			}
		}
		return xml;
	}

	private image(image: Image): string {
		const frame = attributes({
			"draw:style-name": this.styles.graphic(image.border),
			"draw:name": `Picture${this.pictures++}`,
			"text:anchor-type": "as-char",
			"svg:width": pt(image.width),
			"svg:height": pt(image.height),
		});
		const source = attributes({
			"xlink:href": image.href,
			"xlink:type": "simple",
			"xlink:show": "embed",
			"xlink:actuate": "onLoad",
		});
		return `<draw:frame${frame}><draw:image${source}/></draw:frame>`;
	}

	private table(block: Table): string {
		const names = this.styles.table(block.width, block.cells, block.rtl);
		const columns = names.columns.map((name) => `<table:table-column${attributes({ "table:style-name": name })}/>`);
		const cells = block.cells.map((cell, index) => {
			// A cell needs a paragraph, even when the column is empty.
			const content = cell.blocks.length > 0 ? this.blocks(cell.blocks) : '<text:p text:style-name="Standard"/>';
			return `<table:table-cell${attributes({ "table:style-name": names.cells[index], "office:value-type": "string" })}>${content}</table:table-cell>`;
		});
		return `<table:table${attributes({ "table:name": names.table, "table:style-name": names.table })}>${columns.join("")}<table:table-row>${cells.join("")}</table:table-row></table:table>`;
	}
}

function contentXml(document: OdtDocument): string {
	const writer = new ContentWriter();
	const body = writer.blocks(document.blocks);
	return `${XML_DECLARATION}<office:document-content${NAMESPACES}>${fontFaceDeclarations(writer.styles.fonts)}${writer.styles.toXml()}<office:body><office:text>${body}</office:text></office:body></office:document-content>`;
}

// --- styles.xml ---

function listStyle(name: string, displayName: string, ordered: boolean): string {
	const levels = Array.from({ length: LIST_LEVELS }, (_, index) => {
		const level = index + 1;
		const properties = `<style:list-level-properties${attributes({
			"text:list-level-position-and-space-mode": "label-alignment",
		})}><style:list-level-label-alignment${attributes({
			"text:label-followed-by": "listtab",
			"text:list-tab-stop-position": pt(level * LIST_LEVEL_INDENT_PT),
			"fo:text-indent": pt(-LIST_LABEL_WIDTH_PT),
			"fo:margin-left": pt(level * LIST_LEVEL_INDENT_PT),
		})}/></style:list-level-properties>`;
		return ordered
			? `<text:list-level-style-number${attributes({ "text:level": level, "style:num-suffix": ".", "style:num-format": "1" })}>${properties}</text:list-level-style-number>`
			: `<text:list-level-style-bullet${attributes({ "text:level": level, "text:bullet-char": level % 2 === 1 ? "•" : "◦" })}>${properties}</text:list-level-style-bullet>`;
	});
	return `<text:list-style${attributes({ "style:name": name, "style:display-name": displayName })}>${levels.join("")}</text:list-style>`;
}

function stylesXml(document: OdtDocument): string {
	const { defaults, page } = document;
	const fonts = new Set<string>();
	const linkProperties = textProperties({ color: defaults.primaryColor, underline: true }, fonts);
	const headingSizes = [1.4, 1.3, 1.2, 1.1, 1.05, 1];

	// Writer reads `start`/`end` as left/right whatever the direction, so right-to-left text is aligned to `end`.
	const defaultStyle = `<style:default-style style:family="paragraph"><style:paragraph-properties${attributes({
		"style:tab-stop-distance": pt(36),
		"style:writing-mode": page.rtl ? "rl-tb" : "lr-tb",
		"fo:text-align": page.rtl ? "end" : undefined,
		"fo:line-height": `${Math.round(defaults.lineHeight * 100)}%`,
	})}/>${textProperties({ font: defaults.bodyFont, size: defaults.bodySize, color: defaults.textColor }, fonts)}</style:default-style>`;

	const commonStyles = [
		`<style:style${attributes({ "style:name": "Standard", "style:family": "paragraph", "style:class": "text" })}/>`,
		`<style:style${attributes({ "style:name": "Text_20_body", "style:display-name": "Text body", "style:family": "paragraph", "style:parent-style-name": "Standard", "style:class": "text" })}/>`,
		`<style:style${attributes({ "style:name": "Heading", "style:family": "paragraph", "style:parent-style-name": "Standard", "style:next-style-name": "Text_20_body", "style:class": "text" })}><style:paragraph-properties${attributes(
			{ "fo:margin-top": pt(6), "fo:margin-bottom": pt(3), "fo:keep-with-next": "always" },
		)}/>${textProperties({ font: defaults.headingFont, size: defaults.headingSize, bold: true }, fonts)}</style:style>`,
		`<style:style${attributes({ "style:name": "Title", "style:family": "paragraph", "style:parent-style-name": "Heading", "style:next-style-name": "Text_20_body", "style:class": "chapter" })}><style:paragraph-properties${attributes(
			{ "fo:margin-top": pt(0), "fo:margin-bottom": pt(3) },
		)}/>${textProperties({ size: defaults.headingSize * 1.25, color: defaults.primaryColor }, fonts)}</style:style>`,
		...headingSizes.map(
			(scale, index) =>
				`<style:style${attributes({
					"style:name": `Heading_20_${index + 1}`,
					"style:display-name": `Heading ${index + 1}`,
					"style:family": "paragraph",
					"style:parent-style-name": "Heading",
					"style:next-style-name": "Text_20_body",
					"style:default-outline-level": index + 1,
					"style:class": "text",
				})}>${textProperties({ size: defaults.bodySize * scale }, fonts)}</style:style>`,
		),
		`<style:style${attributes({ "style:name": "Internet_20_link", "style:display-name": "Internet link", "style:family": "text" })}>${linkProperties}</style:style>`,
		`<style:style${attributes({ "style:name": "Visited_20_Internet_20_Link", "style:display-name": "Visited Internet Link", "style:family": "text" })}>${linkProperties}</style:style>`,
		listStyle(BULLET_LIST_STYLE, "List Bullet", false),
		listStyle(NUMBER_LIST_STYLE, "List Number", true),
		`<text:outline-style style:name="Outline">${Array.from(
			{ length: LIST_LEVELS },
			(_, index) => `<text:outline-level-style${attributes({ "text:level": index + 1, "style:num-format": "" })}/>`,
		).join("")}</text:outline-style>`,
	];

	const pageLayout = `<style:page-layout style:name="pm1"><style:page-layout-properties${attributes({
		"fo:page-width": `${page.width}mm`,
		"fo:page-height": `${page.height}mm`,
		"style:print-orientation": page.width > page.height ? "landscape" : "portrait",
		"fo:margin-top": pt(page.marginY),
		"fo:margin-bottom": pt(page.marginY),
		"fo:margin-left": pt(page.marginX),
		"fo:margin-right": pt(page.marginX),
		"fo:background-color": page.background,
		"style:writing-mode": page.rtl ? "rl-tb" : "lr-tb",
	})}/></style:page-layout>`;

	return `${XML_DECLARATION}<office:document-styles${NAMESPACES}>${fontFaceDeclarations(fonts)}<office:styles>${defaultStyle}${commonStyles.join("")}</office:styles><office:automatic-styles>${pageLayout}</office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`;
}

// --- meta.xml and the package manifest ---

function metaXml(document: OdtDocument): string {
	return `${XML_DECLARATION}<office:document-meta${NAMESPACES}><office:meta><meta:generator>Reactive Resume</meta:generator><dc:title>${escapeXml(document.title)}</dc:title></office:meta></office:document-meta>`;
}

function manifestXml(document: OdtDocument): string {
	const entry = (path: string, mediaType: string, version?: string) =>
		`<manifest:file-entry${attributes({ "manifest:full-path": path, "manifest:version": version, "manifest:media-type": mediaType })}/>`;
	const entries = [
		entry("/", ODT_MIME_TYPE, "1.2"),
		entry("content.xml", "text/xml"),
		entry("styles.xml", "text/xml"),
		entry("meta.xml", "text/xml"),
		...(document.pictures ?? []).map((picture) => entry(picture.path, picture.mediaType)),
	];
	return `${XML_DECLARATION}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">${entries.join("")}</manifest:manifest>`;
}

/** The text parts of the OpenDocument package, for inspection and tests. */
export function renderOdtParts(document: OdtDocument): Record<string, string> {
	return {
		mimetype: ODT_MIME_TYPE,
		"META-INF/manifest.xml": manifestXml(document),
		"content.xml": contentXml(document),
		"styles.xml": stylesXml(document),
		"meta.xml": metaXml(document),
	};
}

/**
 * Packages the document as an `.odt` file. The mimetype entry comes first and uncompressed, as the
 * OpenDocument package specification requires, so readers can identify the file without unpacking it.
 */
export function packageOdt(document: OdtDocument): Uint8Array {
	const parts = renderOdtParts(document);
	return zipSync({
		mimetype: [strToU8(ODT_MIME_TYPE), { level: 0 }],
		...Object.fromEntries(
			Object.entries(parts)
				.filter(([path]) => path !== "mimetype")
				.map(([path, xml]) => [path, [strToU8(xml), { level: 6 }]]),
		),
		// Pictures are compressed already.
		...Object.fromEntries((document.pictures ?? []).map((picture) => [picture.path, [picture.bytes, { level: 0 }]])),
	});
}
