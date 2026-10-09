import type { Bullet, Inline, Paragraph, ParagraphStyle, TextStyle } from "./model";
import type { HTMLElement, Node } from "node-html-parser";
import { parse, NodeType } from "node-html-parser";
import { isDarkColor, parseColorString } from "@reactive-resume/utils/color";
import { toSafeOdtLink } from "./link-utils";
import { lineBreak, link, paragraph, text } from "./model";

export interface HtmlStyleConfig {
	font?: string;
	/** Font size in points. */
	size?: number;
	color?: string;
	linkColor?: string;
	/** Space above and below each paragraph and list item, in points; the block's outer edges stay flush. */
	paragraphSpacing?: number;
}

/** Indent per `data-indent` step: 24 CSS px = 18pt. */
const INDENT_STEP_PT = 18;
/** Inset of a blockquote, and of each list level: half an inch. */
const QUOTE_INSET_PT = 36;
const CODE_FONT = "Courier New";
const DEFAULT_LINK_COLOR = "#0563c1";

/** Outline level of rich-text headings: `<h1>` nests below the resume's section headings (outline 1). */
const HEADING_LEVELS: Record<string, number> = { H1: 2, H2: 3, H3: 4, H4: 5, H5: 6, H6: 6 };

const preservesWhitespace = (node: Node) => {
	let ancestor = node.parentNode;
	while (ancestor) {
		if (/^(P|H[1-6])$/.test(ancestor.tagName) && ancestor.getAttribute("data-resume-whitespace") === "preserve")
			return true;
		ancestor = ancestor.parentNode;
	}
	return false;
};

function toHexColor(value: string): string | null {
	const rgba = parseColorString(value);
	if (!rgba) return null;
	return `#${[rgba.r, rgba.g, rgba.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function styleProperty(element: HTMLElement | undefined, property: string): string | undefined {
	return element
		?.getAttribute("style")
		?.split(";")
		.reverse()
		.map((declaration) => {
			const colon = declaration.indexOf(":");
			return [declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim()];
		})
		.find(([name]) => name === property)?.[1];
}

function mergeStyle(parent: TextStyle, tag: string, element?: HTMLElement): TextStyle {
	const next = { ...parent };

	switch (tag) {
		case "STRONG":
		case "B":
			next.bold = true;
			break;
		case "EM":
		case "I":
			next.italics = true;
			break;
		case "U":
			next.underline = true;
			break;
		case "S":
		case "STRIKE":
			next.strike = true;
			break;
		case "CODE":
			next.font = CODE_FONT;
			break;
		case "MARK": {
			const bgColor = styleProperty(element, "background-color");
			next.background = (bgColor ? toHexColor(bgColor) : null) ?? "#ffff00";
			if (bgColor && isDarkColor(bgColor)) next.color = "#ffffff";
			break;
		}
	}

	const colorValue = styleProperty(element, "color");
	if (colorValue) {
		const color = toHexColor(colorValue);
		if (color) next.color = color;
	}

	return next;
}

type BlockOptions = {
	/** Depth of the list the element sits in, if any. */
	listLevel?: number;
	/** Inset accumulated from enclosing blockquotes. */
	quoteIndent?: number;
	/** Whether that list is numbered. */
	ordered?: boolean;
	/** The list label the element's paragraph carries, when it's a list item's content. */
	bullet?: Bullet;
};

type PushOptions = { style?: ParagraphStyle; outlineLevel?: number; bullet?: Bullet | undefined; marginStart?: number };

class HtmlConverter {
	private readonly paragraphs: Paragraph[] = [];

	constructor(
		private readonly linkColor: string,
		private readonly spacing: number,
	) {}

	/** The paragraphs, with the prose spacing trimmed from the first and last, as the PDF does. */
	result(): Paragraph[] {
		const first = this.paragraphs[0];
		const last = this.paragraphs.at(-1);
		if (first?.style?.spacingBefore === this.spacing) first.style = { ...first.style, spacingBefore: 0 };
		if (last?.style?.spacingAfter === this.spacing) last.style = { ...last.style, spacingAfter: 0 };
		return this.paragraphs;
	}

	collectInline(node: Node, style: TextStyle): Inline[] {
		const children: Inline[] = [];

		for (const child of node.childNodes) {
			if (child.nodeType === NodeType.TEXT_NODE) {
				// Marked tabs are literal content and become four spaces, as in the DOCX export.
				const content = (child.textContent ?? "").replace(/\t/g, preservesWhitespace(child) ? "    " : "\t");
				if (content) children.push(text(content, style));
				continue;
			}

			if (child.nodeType !== NodeType.ELEMENT_NODE) continue;

			const el = child as HTMLElement;
			const tag = el.tagName;

			if (tag === "BR") {
				children.push(lineBreak());
				continue;
			}

			if (tag === "A") {
				const href = toSafeOdtLink(el.getAttribute("href") ?? "");
				const linkChildren = this.collectInline(el, { ...style, color: this.linkColor, underline: true });
				if (linkChildren.length > 0 && href) children.push(link(href, linkChildren));
				else children.push(...this.collectInline(el, style));
				continue;
			}

			children.push(...this.collectInline(el, mergeStyle(style, tag, el)));
		}

		return children;
	}

	/** A paragraph style with the prose spacing, which explicit spacing in `style` overrides. */
	private spaced(style?: ParagraphStyle): ParagraphStyle | undefined {
		return this.spacing ? { spacingBefore: this.spacing, spacingAfter: this.spacing, ...style } : style;
	}

	push(children: Inline[], options: PushOptions = {}) {
		if (children.length === 0) return;
		const { marginStart, style, ...rest } = options;
		const spaced = this.spaced(style);
		const merged = marginStart ? { ...spaced, marginStart } : spaced;
		this.paragraphs.push(paragraph(children, merged ? { ...rest, style: merged } : rest));
	}

	processBlock(el: HTMLElement, style: TextStyle, options: BlockOptions = {}): void {
		const { listLevel, quoteIndent = 0, ordered = false, bullet } = options;
		const tag = el.tagName;
		const mergedStyle = mergeStyle(style, tag, el);
		const level = Number(el.getAttribute("data-indent"));
		// Lists keep their own indentation; only plain paragraphs and headings indent by `data-indent`.
		const paragraphIndent =
			listLevel == null && Number.isInteger(level) && level > 0 && level <= 8 ? level * INDENT_STEP_PT : 0;
		const marginStart = quoteIndent + paragraphIndent;

		const outlineLevel = HEADING_LEVELS[tag];
		if (outlineLevel) {
			// The heading style sets the font and size; runs keep only their own emphasis and color.
			const { font: _font, size: _size, ...headingStyle } = mergedStyle;
			this.push(this.collectInline(el, headingStyle), {
				outlineLevel,
				style: { parent: `Heading_20_${outlineLevel}` },
				marginStart,
				bullet,
			});
			return;
		}

		if (tag === "P" || tag === "DIV") {
			this.push(this.collectInline(el, mergedStyle), { marginStart: tag === "P" ? marginStart : quoteIndent, bullet });
			return;
		}

		if (tag === "UL" || tag === "OL") {
			const nextLevel = listLevel != null ? listLevel + 1 : 0;
			const isOrdered = listLevel != null ? ordered : tag === "OL";
			const nested = { listLevel: nextLevel, quoteIndent, ordered: isOrdered };

			for (const li of el.children) {
				if (li.tagName !== "LI") continue;

				const hasNestedBlocks = Array.from(li.children).some(
					(child) => child.tagName === "UL" || child.tagName === "OL" || child.tagName === "P",
				);
				const itemBullet = { level: nextLevel, ordered: isOrdered };

				if (!hasNestedBlocks) {
					this.push(this.collectInline(li, mergedStyle), { bullet: itemBullet, marginStart: quoteIndent });
					continue;
				}

				// The item's first paragraph carries the bullet; further paragraphs continue it; lists nest.
				let labelled = false;
				const nextBullet = () => {
					const current = labelled ? { ...itemBullet, continuation: true } : itemBullet;
					labelled = true;
					return current;
				};
				for (const liChild of li.childNodes) {
					if (liChild.nodeType === NodeType.TEXT_NODE) {
						const content = (liChild.textContent ?? "").trim();
						if (content) this.push([text(content, mergedStyle)], { bullet: nextBullet(), marginStart: quoteIndent });
					} else if (liChild.nodeType === NodeType.ELEMENT_NODE) {
						const element = liChild as HTMLElement;
						const isList = element.tagName === "UL" || element.tagName === "OL";
						this.processBlock(element, mergedStyle, isList ? nested : { ...nested, bullet: nextBullet() });
					}
				}
			}
			return;
		}

		if (tag === "BLOCKQUOTE") {
			const quoteStyle = { ...mergedStyle, italics: true };
			const quoted = { ...options, quoteIndent: quoteIndent + QUOTE_INSET_PT };
			const inline = parse("<p></p>").firstChild as HTMLElement;
			const flushInline = () => {
				if (inline.childNodes.length === 0) return;
				this.processBlock(inline, quoteStyle, quoted);
				inline.set_content([]);
			};
			// Each semantic paragraph keeps its own offset; adjacent inline content joins into one paragraph.
			for (const child of el.childNodes) {
				if (child.nodeType === NodeType.ELEMENT_NODE) {
					const element = child as HTMLElement;
					if (HEADING_LEVELS[element.tagName] || /^(P|DIV|UL|OL|BLOCKQUOTE|PRE|HR)$/.test(element.tagName)) {
						flushInline();
						this.processBlock(element, quoteStyle, quoted);
						continue;
					}
				}
				if (child.nodeType === NodeType.TEXT_NODE && !child.textContent?.trim() && inline.childNodes.length === 0)
					continue;
				inline.appendChild(child.clone());
			}
			flushInline();
			return;
		}

		if (tag === "PRE") {
			const content = el.textContent ?? "";
			if (content) {
				this.push([text(content, { ...mergedStyle, font: CODE_FONT })], { marginStart: quoteIndent, bullet });
			}
			return;
		}

		if (tag === "HR") {
			// Writer has no rule paragraph of its own; an empty paragraph keeps the gap.
			this.paragraphs.push(paragraph([], { style: this.spaced() }));
			return;
		}

		if (tag === "LI") {
			this.push(this.collectInline(el, mergedStyle), { bullet: { level: listLevel ?? 0, ordered } });
			return;
		}

		// Anything else (spans, tables, …) is read as inline content.
		this.push(this.collectInline(el, mergedStyle), { bullet });
	}
}

/**
 * Converts an HTML string (from the TipTap rich text editor) into document paragraphs: bold, italic,
 * underline, strikethrough, code, highlights, links, headings, nested lists, quotes and indentation.
 *
 * @param html - The HTML string to convert
 * @param styleConfig - Optional base typography (font, size, color) to apply to all text
 */
export function htmlToParagraphs(html: string, styleConfig?: HtmlStyleConfig): Paragraph[] {
	if (!html?.trim()) return [];

	const converter = new HtmlConverter(styleConfig?.linkColor ?? DEFAULT_LINK_COLOR, styleConfig?.paragraphSpacing ?? 0);

	const baseStyle: TextStyle = {};
	if (styleConfig?.font) baseStyle.font = styleConfig.font;
	if (styleConfig?.size) baseStyle.size = styleConfig.size;
	if (styleConfig?.color) baseStyle.color = styleConfig.color;

	// Unlike the parser's default, `pre` is parsed like any element so `<pre><code>` keeps only its text.
	const doc = parse(html, { blockTextElements: { script: true, style: true, noscript: true } });
	// Script and style text is code, not content: drop it before any walk below prints it.
	for (const element of doc.querySelectorAll("script, style")) element.remove();

	for (const child of doc.childNodes) {
		if (child.nodeType === NodeType.TEXT_NODE) {
			const content = (child.textContent ?? "").trim();
			if (content) converter.push([text(content, baseStyle)]);
			continue;
		}

		if (child.nodeType === NodeType.ELEMENT_NODE) converter.processBlock(child as HTMLElement, baseStyle);
	}

	return converter.result();
}
