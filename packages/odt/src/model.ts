/**
 * A small document model the section renderers build and `document.ts` serializes to OpenDocument XML.
 * Keeping renderers away from XML lets them read like the DOCX ones and keeps every style decision in
 * one place. Lengths are in points; colors are lowercase `#rrggbb`.
 */

export type TextStyle = {
	bold?: boolean;
	italics?: boolean;
	underline?: boolean;
	strike?: boolean;
	font?: string;
	/** Font size in points. */
	size?: number;
	color?: string;
	/** Highlight behind the text. */
	background?: string;
};

/** An embedded picture, anchored as a character; `href` is its path inside the package. */
export type Image = {
	kind: "image";
	href: string;
	width: number;
	height: number;
	border?: { width: number; color: string };
};

export type Inline =
	| { kind: "text"; text: string; style?: TextStyle }
	| { kind: "link"; href: string; children: Inline[] }
	| { kind: "break" }
	| { kind: "tab" }
	| Image;

type TabStop = { position: number; type: "left" | "right" | "center" };

export type ParagraphStyle = {
	/** A common style from styles.xml (`Standard`, `Title`, `Heading_20_1` …) the paragraph builds on. */
	parent?: string;
	spacingBefore?: number;
	spacingAfter?: number;
	/** Indent from the leading page edge ("before text" in Writer, which mirrors it for RTL paragraphs). */
	marginStart?: number;
	/** First-line indent; negative for hanging list labels. */
	textIndent?: number;
	align?: "start" | "center" | "end";
	borderBottom?: { width: number; color: string };
	paddingBottom?: number;
	tabStops?: TabStop[];
	keepWithNext?: boolean;
	/** Text formatting for the whole paragraph; inline runs can override it. */
	text?: TextStyle;
};

export type Bullet = {
	level: number;
	ordered?: boolean;
	/** A further paragraph of the previous list item, printed without a label of its own. */
	continuation?: boolean;
};

export type Paragraph = {
	kind: "paragraph";
	children: Inline[];
	style?: ParagraphStyle;
	/** A heading at this outline level; shown in Writer's Navigator. */
	outlineLevel?: number;
	/** A list item; consecutive bulleted paragraphs become one (nested) list. */
	bullet?: Bullet;
};

export type TableCell = {
	blocks: Block[];
	/** Percentage of the table width. */
	width: number;
	padding: { top: number; end: number; bottom: number; start: number };
	background?: string;
};

/** A borderless one-row table laying columns side by side; `width` is the text area it spans, in points. */
export type Table = { kind: "table"; width: number; cells: TableCell[]; rtl: boolean };

export type Block = Paragraph | Table;

export const text = (value: string, style?: TextStyle): Inline =>
	style && Object.keys(style).length > 0 ? { kind: "text", text: value, style } : { kind: "text", text: value };

export const link = (href: string, children: Inline[]): Inline => ({ kind: "link", href, children });

export const lineBreak = (): Inline => ({ kind: "break" });

export const tab = (): Inline => ({ kind: "tab" });

export const paragraph = (
	children: Inline[],
	options: { style?: ParagraphStyle | undefined; outlineLevel?: number | undefined; bullet?: Bullet | undefined } = {},
): Paragraph => ({
	kind: "paragraph",
	children,
	...(options.style ? { style: options.style } : {}),
	...(options.outlineLevel ? { outlineLevel: options.outlineLevel } : {}),
	...(options.bullet ? { bullet: options.bullet } : {}),
});
