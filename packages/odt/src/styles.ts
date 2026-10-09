import type { ParagraphStyle, TableCell, TextStyle } from "./model";
import { attributes, pt } from "./xml";

/** Fonts Writer substitutes sensibly; declared up front so every `style:font-name` resolves. */
const MONOSPACE_FONTS = new Set(["Courier New", "Liberation Mono", "DejaVu Sans Mono"]);

function stableKey(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
			: item,
	);
}

/**
 * `style:text-properties` for a run or paragraph. Western, Asian and complex-script variants are all set so
 * CJK and right-to-left text pick up the same font, size and weight.
 */
export function textProperties(style: TextStyle | undefined, fonts: Set<string>): string {
	if (!style) return "";
	const props: Record<string, string | undefined> = {};
	if (style.font) {
		fonts.add(style.font);
		props["style:font-name"] = style.font;
		props["style:font-name-asian"] = style.font;
		props["style:font-name-complex"] = style.font;
	}
	if (style.size) {
		props["fo:font-size"] = pt(style.size);
		props["style:font-size-asian"] = pt(style.size);
		props["style:font-size-complex"] = pt(style.size);
	}
	if (style.bold) {
		props["fo:font-weight"] = "bold";
		props["style:font-weight-asian"] = "bold";
		props["style:font-weight-complex"] = "bold";
	}
	if (style.italics) {
		props["fo:font-style"] = "italic";
		props["style:font-style-asian"] = "italic";
		props["style:font-style-complex"] = "italic";
	}
	if (style.underline) {
		props["style:text-underline-style"] = "solid";
		props["style:text-underline-width"] = "auto";
		props["style:text-underline-color"] = "font-color";
	}
	if (style.strike) props["style:text-line-through-style"] = "solid";
	if (style.color) props["fo:color"] = style.color;
	if (style.background) props["fo:background-color"] = style.background;
	const xml = attributes(props);
	return xml ? `<style:text-properties${xml}/>` : "";
}

function paragraphProperties(style: ParagraphStyle): string {
	const props: Record<string, string | undefined> = {};
	if (style.spacingBefore !== undefined) props["fo:margin-top"] = pt(style.spacingBefore);
	if (style.spacingAfter !== undefined) props["fo:margin-bottom"] = pt(style.spacingAfter);
	if (style.marginStart !== undefined) props["fo:margin-left"] = pt(style.marginStart);
	if (style.textIndent !== undefined) props["fo:text-indent"] = pt(style.textIndent);
	if (style.align) props["fo:text-align"] = style.align;
	if (style.keepWithNext) props["fo:keep-with-next"] = "always";
	if (style.borderBottom) {
		props["fo:border-bottom"] = `${pt(style.borderBottom.width)} solid ${style.borderBottom.color}`;
		props["fo:padding-bottom"] = pt(style.paddingBottom ?? 2);
	}
	const tabStops = style.tabStops?.length
		? `<style:tab-stops>${style.tabStops
				.map(
					(stop) => `<style:tab-stop${attributes({ "style:position": pt(stop.position), "style:type": stop.type })}/>`,
				)
				.join("")}</style:tab-stops>`
		: "";
	const xml = attributes(props);
	return xml || tabStops ? `<style:paragraph-properties${xml}>${tabStops}</style:paragraph-properties>` : "";
}

/**
 * The automatic styles of content.xml: one named style per distinct set of properties, handed out to
 * paragraphs (`P1`…), text spans (`T1`…) and layout tables (`Table1`…). Also tracks every font used.
 */
export class AutomaticStyles {
	readonly fonts = new Set<string>();
	private readonly paragraphs = new Map<string, string>();
	private readonly spans = new Map<string, string>();
	private readonly definitions: string[] = [];
	private readonly graphics = new Map<string, string>();
	private tables = 0;

	/** The style name for a paragraph; `Standard` when it carries no properties of its own. */
	paragraph(style: ParagraphStyle | undefined): string {
		if (!style || Object.keys(style).length === 0) return "Standard";
		const key = stableKey(style);
		const existing = this.paragraphs.get(key);
		if (existing) return existing;

		const name = `P${this.paragraphs.size + 1}`;
		this.paragraphs.set(key, name);
		this.definitions.push(
			`<style:style${attributes({
				"style:name": name,
				"style:family": "paragraph",
				"style:parent-style-name": style.parent ?? "Standard",
			})}>${paragraphProperties(style)}${textProperties(style.text, this.fonts)}</style:style>`,
		);
		return name;
	}

	/** The style name for a span, or null when the run needs no formatting of its own. */
	span(style: TextStyle | undefined): string | null {
		const properties = textProperties(style, this.fonts);
		if (!properties) return null;
		const existing = this.spans.get(properties);
		if (existing) return existing;

		const name = `T${this.spans.size + 1}`;
		this.spans.set(properties, name);
		this.definitions.push(
			`<style:style${attributes({ "style:name": name, "style:family": "text" })}>${properties}</style:style>`,
		);
		return name;
	}

	/** The style of a picture frame anchored in the text, with an optional border. */
	graphic(border?: { width: number; color: string }): string {
		const key = border ? `${pt(border.width)} solid ${border.color}` : "none";
		const existing = this.graphics.get(key);
		if (existing) return existing;

		const name = `fr${this.graphics.size + 1}`;
		this.graphics.set(key, name);
		this.definitions.push(
			`<style:style${attributes({ "style:name": name, "style:family": "graphic" })}><style:graphic-properties${attributes(
				{
					"style:vertical-pos": "middle",
					"style:vertical-rel": "baseline",
					"fo:border": key,
					"fo:padding": border ? pt(0) : undefined,
				},
			)}/></style:style>`,
		);
		return name;
	}

	/** Styles for a borderless layout table spanning the text area: its columns and cells. */
	table(width: number, cells: TableCell[], rtl: boolean): { table: string; columns: string[]; cells: string[] } {
		this.tables += 1;
		const table = `Table${this.tables}`;
		this.definitions.push(
			`<style:style${attributes({ "style:name": table, "style:family": "table" })}><style:table-properties${attributes({
				"style:width": pt(width),
				"table:align": "margins",
				"style:writing-mode": rtl ? "rl-tb" : undefined,
			})}/></style:style>`,
		);
		const columns = cells.map((cell, index) => {
			const name = `${table}.${String.fromCharCode(65 + index)}`;
			this.definitions.push(
				`<style:style${attributes({ "style:name": name, "style:family": "table-column" })}><style:table-column-properties${attributes(
					{
						"style:column-width": pt((width * cell.width) / 100),
						"style:rel-column-width": `${Math.round(cell.width * 100)}*`,
					},
				)}/></style:style>`,
			);
			return name;
		});
		const cellNames = cells.map((cell, index) => {
			const name = `${table}.${String.fromCharCode(65 + index)}1`;
			this.definitions.push(
				`<style:style${attributes({ "style:name": name, "style:family": "table-cell" })}><style:table-cell-properties${attributes(
					{
						"fo:padding-top": pt(cell.padding.top),
						"fo:padding-bottom": pt(cell.padding.bottom),
						"fo:padding-left": pt(rtl ? cell.padding.end : cell.padding.start),
						"fo:padding-right": pt(rtl ? cell.padding.start : cell.padding.end),
						"fo:border": "none",
						"fo:background-color": cell.background,
						"style:vertical-align": "top",
					},
				)}/></style:style>`,
			);
			return name;
		});
		return { table, columns, cells: cellNames };
	}

	toXml(): string {
		return `<office:automatic-styles>${this.definitions.join("")}</office:automatic-styles>`;
	}
}

/** `office:font-face-decls` for every font a file references. */
export function fontFaceDeclarations(fonts: Iterable<string>): string {
	const faces = [...new Set(fonts)]
		.sort()
		.map(
			(font) =>
				`<style:font-face${attributes({
					"style:name": font,
					"svg:font-family": /[\s,]/.test(font) ? `'${font}'` : font,
					"style:font-family-generic": MONOSPACE_FONTS.has(font) ? "modern" : undefined,
					"style:font-pitch": MONOSPACE_FONTS.has(font) ? "fixed" : undefined,
				})}/>`,
		)
		.join("");
	return `<office:font-face-decls>${faces}</office:font-face-decls>`;
}
