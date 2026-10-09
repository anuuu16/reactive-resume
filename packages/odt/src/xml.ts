const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Control characters XML 1.0 forbids even when escaped; tab, newline and carriage return are allowed. */
const isForbiddenInXml = (code: number) => code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;

/** Escapes text for an XML text node or attribute value, dropping characters XML can't carry. */
export function escapeXml(value: string): string {
	let xml = "";
	for (const character of value) {
		const escaped = XML_ESCAPES[character];
		if (escaped) xml += escaped;
		else if (!isForbiddenInXml(character.charCodeAt(0))) xml += character;
	}
	return xml;
}

/** `name="value"` pairs, skipping undefined values. */
export function attributes(pairs: Record<string, string | number | undefined>): string {
	return Object.entries(pairs)
		.filter((pair): pair is [string, string | number] => pair[1] !== undefined)
		.map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
		.join("");
}

/** A length in points, trimmed to two decimals so styles with equal values dedupe. */
export function pt(value: number): string {
	return `${Math.round(value * 100) / 100}pt`;
}

/**
 * Paragraph text with OpenDocument whitespace encoding: Writer collapses runs of spaces and ignores
 * tabs and newlines unless they're written as `text:s`, `text:tab` and `text:line-break`.
 */
export function textContent(value: string, atParagraphStart = false): string {
	let xml = "";
	let index = 0;
	for (const match of value.matchAll(/\t|\n| {2,}/g)) {
		const token = match[0];
		xml += escapeXml(value.slice(index, match.index));
		if (token === "\t") xml += "<text:tab/>";
		else if (token === "\n") xml += "<text:line-break/>";
		else if (match.index === 0 && atParagraphStart) xml += `<text:s text:c="${token.length}"/>`;
		else xml += ` <text:s text:c="${token.length - 1}"/>`;
		index = match.index + token.length;
	}
	xml += escapeXml(value.slice(index));
	if (atParagraphStart && xml.startsWith(" ")) xml = `<text:s/>${xml.slice(1)}`;
	return xml;
}
