import type { BaseChange } from "./queries";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@lingui/core";
import { describeChangeKind, describeChangeLocation, describeConflict, previewValue } from "./labels";

const change = (partial: Partial<BaseChange> & Pick<BaseChange, "key" | "location">): BaseChange => ({
	kind: "edit",
	...partial,
});

beforeEach(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

describe("describeChangeLocation", () => {
	it("names the part of the resume, the entry and the field as the editor does", () => {
		expect(
			describeChangeLocation(change({ key: "basics/headline", location: { scope: "basics", field: "headline" } })),
		).toBe("Basics · Headline");
		expect(
			describeChangeLocation(
				change({
					key: "sections/experience/items/e1/description",
					location: {
						scope: "section",
						section: { id: "experience", title: "" },
						item: { id: "e1", label: "Northwind Labs · Engineer" },
						field: "description",
					},
				}),
			),
		).toBe("Experience · Northwind Labs · Engineer · Description");
		expect(
			describeChangeLocation(
				change({
					key: "customSections/c1/title",
					location: { scope: "section", section: { id: "c1", title: "Talks" }, field: "title" },
				}),
			),
		).toBe("Talks · Title");
		expect(
			describeChangeLocation(
				change({ key: "metadata/page/marginX", location: { scope: "metadata", field: "page/marginX" } }),
			),
		).toBe("Design · Page · marginX");
	});

	it("leaves out fields that say nothing more: an order, or the picture's file", () => {
		expect(
			describeChangeLocation(
				change({
					key: "sections/skills/items/@order",
					kind: "reorder",
					location: { scope: "section", section: { id: "skills", title: "" }, field: "order" },
				}),
			),
		).toBe("Skills");
		expect(describeChangeLocation(change({ key: "picture/url", location: { scope: "picture", field: "url" } }))).toBe(
			"Picture",
		);
	});
});

describe("describeChangeKind and describeConflict", () => {
	it("says what the base did and why a conflict needs a decision", () => {
		const entry = { scope: "section", item: { id: "x", label: "X" } } as const;
		expect(describeChangeKind(change({ key: "k", kind: "add", location: entry }))).toBe("Added entry");
		expect(describeChangeKind(change({ key: "k", kind: "remove", location: entry }))).toBe("Removed entry");
		expect(describeChangeKind(change({ key: "k", kind: "reorder", location: { scope: "section" } }))).toBe("Reordered");
		expect(describeChangeKind(change({ key: "k", kind: "edit", location: entry, conflict: "removed-here" }))).toBe(
			"Edited an entry you removed",
		);
		expect(describeConflict(change({ key: "k", location: entry, conflict: "both-edited" }))).toBe("Changed in both");
		expect(describeConflict(change({ key: "k", location: entry, conflict: "edited-here" }))).toBe(
			"Removed in the base, edited here",
		);
	});
});

describe("previewValue", () => {
	it("reads rich text as plain text, and shortens long values", () => {
		expect(previewValue("<ul><li>Shipped <strong>v2</strong></li><li>Led a team</li></ul>")).toBe(
			"Shipped v2 Led a team",
		);
		expect(previewValue("")).toBe("(empty)");
		expect(previewValue("x".repeat(300))).toHaveLength(240);
	});

	it("words booleans by their field, and dates as they print", () => {
		const hidden = change({ key: "k", location: { scope: "section", field: "hidden" } });
		expect(previewValue(true, hidden)).toBe("Hidden");
		expect(previewValue(false, hidden)).toBe("Shown");
		expect(previewValue(true)).toBe("Yes");
		expect(previewValue({ start: "2020-03", end: null, present: true })).toBe("Mar 2020 – Present");
		expect(previewValue(["a", "b"])).toBe("a, b");
	});

	it("sums up a whole entry by its label and its text", () => {
		const added = change({
			key: "sections/experience/items/e3",
			kind: "add",
			location: {
				scope: "section",
				section: { id: "experience", title: "" },
				item: { id: "e3", label: "Fieldnote · CTO" },
			},
		});
		expect(
			previewValue({ id: "e3", company: "Fieldnote", position: "CTO", description: "<p>Built the team</p>" }, added),
		).toBe("Fieldnote · CTO — Built the team");
	});
});
