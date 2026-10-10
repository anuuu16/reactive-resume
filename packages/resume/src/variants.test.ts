import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { describe, expect, it } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import {
	applyBaseChanges,
	describeItem,
	isJsonEqual,
	mergeFromBase,
	reorderLikeBase,
	splitChangeKey,
	undecidedConflicts,
} from "./variants";

type Experience = ResumeData["sections"]["experience"]["items"][number];

const experience = (id: string, company: string, position: string, description = ""): Experience => ({
	id,
	hidden: false,
	company,
	position,
	location: "",
	period: "",
	dates: { start: null, end: null, present: false },
	website: { url: "", label: "", inlineLink: false },
	description,
	roles: [],
});

/** A resume with two jobs and one skill, the state a variant and its base start from. */
function createAncestor(): ResumeData {
	const data = structuredClone(defaultResumeData);
	data.basics.name = "Alex Morgan";
	data.summary.content = "<p>Hello</p>";
	data.sections.experience.items = [
		experience("e1", "Northwind Labs", "Engineer", "<ul><li>A</li><li>B</li></ul>"),
		experience("e2", "Lumen", "Lead"),
	];
	data.sections.skills.items = [
		{ id: "s1", hidden: false, icon: "", iconColor: "", name: "TypeScript", proficiency: "", level: 0, keywords: [] },
	];
	return data;
}

const keys = (changes: readonly { key: string }[]) => changes.map((change) => change.key);

describe("mergeFromBase", () => {
	it("finds nothing when the base hasn't changed, whatever the variant did", () => {
		const ancestor = createAncestor();
		const mine = createAncestor();
		mine.summary.content = "<p>Tailored</p>";
		mine.sections.experience.items.pop();

		expect(mergeFromBase(ancestor, createAncestor(), mine)).toEqual({ updates: [], conflicts: [] });
	});

	it("lists the base's edits, additions and removals the variant left alone as clean updates", () => {
		const ancestor = createAncestor();
		const base = createAncestor();
		base.basics.name = "Alex J. Morgan";
		base.sections.experience.items.push(experience("e3", "Fieldnote", "CTO"));
		base.sections.skills.items = [];

		const merge = mergeFromBase(ancestor, base, createAncestor());

		expect(merge.conflicts).toEqual([]);
		expect(merge.updates).toEqual([
			expect.objectContaining({
				key: "basics/name",
				kind: "edit",
				base: "Alex J. Morgan",
				mine: "Alex Morgan",
				ancestor: "Alex Morgan",
				location: { scope: "basics", field: "name" },
			}),
			expect.objectContaining({
				key: "sections/experience/items/e3",
				kind: "add",
				location: {
					scope: "section",
					section: { id: "experience", title: "" },
					item: { id: "e3", label: "Fieldnote · CTO" },
				},
			}),
			expect.objectContaining({
				key: "sections/skills/items/s1",
				kind: "remove",
				location: expect.objectContaining({ item: { id: "s1", label: "TypeScript" } }),
			}),
		]);
	});

	it("keeps the variant's own edits out of the way: hiding an entry doesn't block the base's edit to it", () => {
		const ancestor = createAncestor();
		const mine = createAncestor();
		(mine.sections.experience.items[1] as Experience).hidden = true;
		const base = createAncestor();
		(base.sections.experience.items[1] as Experience).position = "Staff Engineer";

		const merge = mergeFromBase(ancestor, base, mine);

		expect(keys(merge.updates)).toEqual(["sections/experience/items/e2/position"]);
		expect(merge.conflicts).toEqual([]);
		const applied = applyBaseChanges(mine, base, merge);
		expect(applied.sections.experience.items[1]).toMatchObject({ hidden: true, position: "Staff Engineer" });
	});

	it("flags the same field edited on both sides as a conflict, and the same edit on both as nothing", () => {
		const ancestor = createAncestor();
		const mine = createAncestor();
		mine.summary.content = "<p>Tailored</p>";
		mine.basics.name = "A. Morgan";
		const base = createAncestor();
		base.summary.content = "<p>Hello world</p>";
		base.basics.name = "A. Morgan";

		const merge = mergeFromBase(ancestor, base, mine);

		expect(merge.updates).toEqual([]);
		expect(merge.conflicts).toEqual([
			expect.objectContaining({
				key: "summary/content",
				conflict: "both-edited",
				base: "<p>Hello world</p>",
				mine: "<p>Tailored</p>",
				ancestor: "<p>Hello</p>",
			}),
		]);
	});

	it("treats a removed bullet against a base edit of the same description as a conflict", () => {
		const ancestor = createAncestor();
		const mine = createAncestor();
		(mine.sections.experience.items[0] as Experience).description = "<ul><li>A</li></ul>";
		const base = createAncestor();
		(base.sections.experience.items[0] as Experience).description = "<ul><li>A!</li><li>B</li></ul>";

		const merge = mergeFromBase(ancestor, base, mine);

		expect(keys(merge.conflicts)).toEqual(["sections/experience/items/e1/description"]);
		expect(merge.conflicts[0]?.location).toEqual({
			scope: "section",
			section: { id: "experience", title: "" },
			item: { id: "e1", label: "Northwind Labs · Engineer" },
			field: "description",
		});
	});

	it("asks when the base removed an entry the variant edited, or edited one the variant removed", () => {
		const ancestor = createAncestor();
		const mine = createAncestor();
		(mine.sections.experience.items[0] as Experience).position = "Senior Engineer";
		mine.sections.experience.items.splice(1, 1);
		const base = createAncestor();
		base.sections.experience.items.splice(0, 1);
		(base.sections.experience.items[0] as Experience).position = "Principal";

		const merge = mergeFromBase(ancestor, base, mine);

		expect(merge.updates).toEqual([]);
		expect(merge.conflicts).toEqual([
			expect.objectContaining({ key: "sections/experience/items/e1", kind: "remove", conflict: "edited-here" }),
			expect.objectContaining({ key: "sections/experience/items/e2", kind: "edit", conflict: "removed-here" }),
		]);

		const kept = applyBaseChanges(mine, base, merge, [
			{ key: "sections/experience/items/e1", take: "mine" },
			{ key: "sections/experience/items/e2", take: "mine" },
		]);
		expect(kept.sections.experience.items.map((item) => item.id)).toEqual(["e1"]);

		const taken = applyBaseChanges(mine, base, merge, [
			{ key: "sections/experience/items/e1", take: "base" },
			{ key: "sections/experience/items/e2", take: "base" },
		]);
		expect(taken.sections.experience.items).toEqual([expect.objectContaining({ id: "e2", position: "Principal" })]);
	});

	it("follows the base's reorder unless the variant reordered too", () => {
		const ancestor = createAncestor();
		const base = createAncestor();
		base.sections.experience.items.reverse();

		const clean = mergeFromBase(ancestor, base, createAncestor());
		expect(clean.updates).toEqual([
			expect.objectContaining({
				key: "sections/experience/items/@order",
				kind: "reorder",
				base: ["e2", "e1"],
				location: { scope: "section", section: { id: "experience", title: "" }, field: "order" },
			}),
		]);
		expect(applyBaseChanges(createAncestor(), base, clean).sections.experience.items.map((item) => item.id)).toEqual([
			"e2",
			"e1",
		]);

		const mine = createAncestor();
		mine.sections.experience.items.reverse();
		expect(mergeFromBase(ancestor, base, mine)).toEqual({ updates: [], conflicts: [] });

		const mineWithExtra = createAncestor();
		mineWithExtra.sections.experience.items.splice(1, 0, experience("x", "Mine only", ""));
		const kept = applyBaseChanges(mineWithExtra, base, mergeFromBase(ancestor, base, mineWithExtra));
		expect(kept.sections.experience.items.map((item) => item.id)).toEqual(["e2", "x", "e1"]);
	});

	it("places an entry the base added after the base neighbour the variant still has", () => {
		const ancestor = createAncestor();
		const base = createAncestor();
		base.sections.experience.items.splice(1, 0, experience("e3", "Fieldnote", "CTO"));
		const mine = createAncestor();
		mine.sections.experience.items.splice(1, 1); // e2 is gone here.

		const merge = mergeFromBase(ancestor, base, mine);
		const applied = applyBaseChanges(mine, base, merge);

		expect(applied.sections.experience.items.map((item) => item.id)).toEqual(["e1", "e3"]);
		// Whole entries come through with their date text, which the tree itself leaves out.
		expect(applied.sections.experience.items[1]).toHaveProperty("period", "");
	});

	it("compares dates as one value and ignores the text written from them", () => {
		const ancestor = createAncestor();
		const base = createAncestor();
		const job = base.sections.experience.items[0] as Experience;
		job.dates = { start: "2020-01", end: "2022-06", present: false };
		job.period = "Jan 2020 – Jun 2022";

		const merge = mergeFromBase(ancestor, base, createAncestor());

		expect(keys(merge.updates)).toEqual(["sections/experience/items/e1/dates"]);
	});

	it("compares the layout, the stylesheet and Check's choices as single values", () => {
		const ancestor = createAncestor();
		const base = createAncestor();
		base.metadata.layout.pages[0]?.main.push("projects");
		base.metadata.page.marginX = 20;

		const merge = mergeFromBase(ancestor, base, createAncestor());

		expect(merge.updates).toEqual([
			expect.objectContaining({ key: "metadata/layout", location: { scope: "metadata", field: "layout" } }),
			expect.objectContaining({ key: "metadata/page/marginX", location: { scope: "metadata", field: "page/marginX" } }),
		]);
	});

	it("keeps a skipped update out of the result and leaves the variant untouched", () => {
		const ancestor = createAncestor();
		const base = createAncestor();
		base.basics.name = "Changed";
		base.basics.headline = "New headline";
		const mine = createAncestor();

		const merge = mergeFromBase(ancestor, base, mine);
		const applied = applyBaseChanges(mine, base, merge, [{ key: "basics/name", take: "mine" }]);

		expect(applied.basics).toMatchObject({ name: "Alex Morgan", headline: "New headline" });
		expect(mine.basics.headline).toBe("");
	});

	it("reports the conflicts still to decide", () => {
		const ancestor = createAncestor();
		const base = createAncestor();
		base.summary.content = "<p>Base</p>";
		const mine = createAncestor();
		mine.summary.content = "<p>Mine</p>";
		const merge = mergeFromBase(ancestor, base, mine);

		expect(undecidedConflicts(merge, [])).toHaveLength(1);
		expect(undecidedConflicts(merge, [{ key: "summary/content", take: "mine" }])).toEqual([]);
	});
});

describe("helpers", () => {
	it("describes entries by what people call them", () => {
		expect(describeItem({ company: "Northwind", position: "Engineer" })).toBe("Northwind · Engineer");
		expect(describeItem({ school: "University of Porto", degree: "BSc", area: "CS" })).toBe(
			"University of Porto · BSc",
		);
		expect(describeItem({ name: "TypeScript" })).toBe("TypeScript");
		expect(describeItem({ content: "<p>Some <strong>rich</strong> text</p>" })).toBe("Some rich text");
		expect(describeItem("nope")).toBe("");
	});

	it("escapes slashes in keys and reads them back", () => {
		expect(splitChangeKey("sections/a~1b/items/x")).toEqual(["sections", "a/b", "items", "x"]);
		expect(splitChangeKey("")).toEqual([]);
	});

	it("compares JSON by value, treating a missing key as undefined", () => {
		expect(isJsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
		expect(isJsonEqual([1, { x: "y" }], [1, { x: "y" }])).toBe(true);
		expect(isJsonEqual({ a: 1 }, { a: "1" })).toBe(false);
	});

	it("reorders like the base while keeping this variant's own entries in place", () => {
		expect(reorderLikeBase(["a", "x", "b", "c"], ["c", "b", "a"])).toEqual(["c", "x", "b", "a"]);
		expect(reorderLikeBase(["a", "b"], ["b", "a", "z"])).toEqual(["b", "a"]);
	});
});
