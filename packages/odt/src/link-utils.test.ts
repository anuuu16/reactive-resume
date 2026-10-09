import { describe, expect, it } from "vitest";
import { toSafeOdtLink } from "./link-utils";

describe("toSafeOdtLink", () => {
	it("accepts https URLs", () => {
		expect(toSafeOdtLink("https://example.com")).toBe("https://example.com/");
	});

	it("rejects javascript: protocol", () => {
		expect(toSafeOdtLink("javascript:alert(1)")).toBeNull();
		expect(toSafeOdtLink("data:text/html,<script>alert(1)</script>")).toBeNull();
		expect(toSafeOdtLink("file:///etc/passwd")).toBeNull();
		expect(toSafeOdtLink("ftp://example.com")).toBeNull();
	});

	it("accepts mailto: and tel: links", () => {
		expect(toSafeOdtLink("mailto:ada@example.com")).toBe("mailto:ada@example.com");
		expect(toSafeOdtLink("tel:+1 555 123 4567")).toBe("tel:+1 555 123 4567");
	});

	it("rejects malformed URLs", () => {
		expect(toSafeOdtLink("not a url at all")).toBeNull();
		expect(toSafeOdtLink("   ")).toBeNull();
	});
});
