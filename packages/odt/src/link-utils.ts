const SAFE_ODT_LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** A hyperlink target Writer may open, or null for anything else (javascript:, file:, data:, malformed). */
export function toSafeOdtLink(value: string): string | null {
	const input = value.trim();
	if (!input) return null;

	if (input.startsWith("mailto:")) {
		const email = input.slice("mailto:".length).trim();
		if (!email) return null;
		return `mailto:${email}`;
	}

	try {
		const url = new URL(input);
		if (!SAFE_ODT_LINK_SCHEMES.has(url.protocol)) return null;
		return url.toString();
	} catch {
		return null;
	}
}
