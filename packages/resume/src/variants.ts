import type { ResumeData } from "@reactive-resume/schema/resume/data";

/**
 * Variants: a resume that stays linked to the base resume it was made from. The variant keeps its own edits
 * (a reworded summary, hidden or reordered entries, removed bullets) and can pull in what changed in the base
 * since it last did, one change at a time, with a conflict wherever both sides changed the same thing.
 *
 * This module is the pure three-way merge between the base as it was when the variant last synced (the
 * ancestor), the base as it is now, and the variant as it is now. The API computes it; the editor shows it.
 *
 * A resume is compared as a tree. Objects are compared field by field; arrays of entries with an `id` are
 * compared entry by entry (by id) plus their order; everything else (strings, numbers, arrays of keywords,
 * a `dates` object, the layout) is one value. Each such value or entry is a "change key", written as a path
 * such as `sections/experience/items/<id>/description`.
 */

/** What the base did: edited a value, added an entry, removed an entry, or reordered entries. */
export type BaseChangeKind = "edit" | "add" | "remove" | "reorder";

/**
 * Why a change can't be taken without asking: both sides edited the same value; the base removed an entry
 * this variant edited; or the base edited an entry this variant removed.
 */
export type BaseConflictReason = "both-edited" | "edited-here" | "removed-here";

export type ChangeScope = "basics" | "picture" | "summary" | "section" | "sections" | "metadata";

/** Where a change lands, for people: the section, the entry (and role) in it, and the field. */
export type ChangeLocation = {
	scope: ChangeScope;
	/** A built-in section's type ("experience") or a custom section's id, with its title as shown. */
	section?: { id: string; title: string };
	/** The entry's id and a label such as "Northwind Labs · Engineer". */
	item?: { id: string; label: string };
	/** A role inside an experience entry. */
	role?: { id: string; label: string };
	/** The field, as a path inside its owner: "description", "page/marginX", "website/url". */
	field?: string;
};

export type BaseChange = {
	key: string;
	kind: BaseChangeKind;
	location: ChangeLocation;
	/** The base's value now; `undefined` when the base removed it. For reorders, the base's ids in order. */
	base?: unknown;
	/** This variant's value; `undefined` when it has none. */
	mine?: unknown;
	/** The value both started from; `undefined` when the base added it. */
	ancestor?: unknown;
	/** Set when the variant changed the same thing, so the user has to pick a side. */
	conflict?: BaseConflictReason;
};

export type BaseMerge = {
	/** Changes that apply cleanly: the base changed something this variant left as it was. */
	updates: BaseChange[];
	/** Changes both sides made differently. */
	conflicts: BaseChange[];
};

/** "base" takes the base's version; "mine" keeps this variant's. */
export type BaseDecision = { key: string; take: "base" | "mine" };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasId = (value: unknown): value is JsonObject & { id: string } =>
	isObject(value) && typeof value.id === "string" && value.id.length > 0;

/** An array of entries with ids (items, roles, custom fields, custom sections, style rules), or an empty one. */
const isKeyedArray = (value: unknown): value is (JsonObject & { id: string })[] =>
	Array.isArray(value) && value.every(hasId);

/** JSON equality: key order doesn't matter, and a missing key equals `undefined`. */
export function isJsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((value, index) => isJsonEqual(value, b[index]));
	}
	if (isObject(a) && isObject(b)) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const key of keys) if (!isJsonEqual(a[key], b[key])) return false;
		return true;
	}
	return false;
}

// Paths use JSON Pointer escaping, so an id or key with "/" in it stays one segment.
const escapeSegment = (segment: string) => segment.replaceAll("~", "~0").replaceAll("/", "~1");
const unescapeSegment = (segment: string) => segment.replaceAll("~1", "/").replaceAll("~0", "~");
const joinPath = (segments: readonly string[]) => segments.map(escapeSegment).join("/");
export const splitChangeKey = (key: string) => (key === "" ? [] : key.split("/").map(unescapeSegment));

/** The segment that stands for a keyed array's order. */
const ORDER = "@order";

/** Objects compared as one value rather than field by field. */
const ATOMIC_PATHS = new Set(["metadata/layout", "metadata/stylesheet", "metadata/check"]);
const ATOMIC_FIELDS = new Set(["dates"]);

/** The text written from `dates` on every save; the dates are the change, the text follows. */
const DERIVED_DATE_TEXT = new Set(["period", "date"]);

type Node =
	| { type: "leaf"; value: unknown }
	| { type: "object"; fields: Map<string, Node> }
	| { type: "keyed"; ids: string[]; entries: Map<string, Node> };

function toNode(value: unknown, path: readonly string[]): Node {
	const last = path.at(-1) ?? "";
	if (ATOMIC_PATHS.has(joinPath(path)) || ATOMIC_FIELDS.has(last)) return { type: "leaf", value };
	if (isKeyedArray(value)) {
		const ids: string[] = [];
		const entries = new Map<string, Node>();
		for (const entry of value) {
			// Duplicate ids can't be told apart; the first one wins, the rest are ignored.
			if (entries.has(entry.id)) continue;
			ids.push(entry.id);
			entries.set(entry.id, toNode(entry, [...path, entry.id]));
		}
		return { type: "keyed", ids, entries };
	}
	if (isObject(value)) {
		const fields = new Map<string, Node>();
		const hasDates = "dates" in value;
		for (const [key, field] of Object.entries(value)) {
			if (field === undefined) continue;
			if (hasDates && DERIVED_DATE_TEXT.has(key)) continue;
			fields.set(key, toNode(field, [...path, key]));
		}
		return { type: "object", fields };
	}
	return { type: "leaf", value };
}

function materialize(node: Node | undefined): unknown {
	if (!node) return undefined;
	if (node.type === "leaf") return node.value;
	if (node.type === "keyed") return node.ids.map((id) => materialize(node.entries.get(id)));
	return Object.fromEntries([...node.fields].map(([key, field]) => [key, materialize(field)]));
}

const nodesEqual = (a: Node | undefined, b: Node | undefined) => isJsonEqual(materialize(a), materialize(b));

/** Whether two orders agree on the ids they share. */
function sameRelativeOrder(a: readonly string[], b: readonly string[]) {
	const common = new Set(a.filter((id) => b.includes(id)));
	const left = a.filter((id) => common.has(id));
	const right = b.filter((id) => common.has(id));
	return left.every((id, index) => right[index] === id);
}

type Walk = {
	changes: BaseChange[];
	/** The three documents as given, so a change carries whole values (an added entry keeps its date text). */
	roots: { ancestor: ResumeData; base: ResumeData; mine: ResumeData };
	locate: (path: readonly string[]) => ChangeLocation;
};

function pushChange(
	walk: Walk,
	path: readonly string[],
	kind: BaseChangeKind,
	conflict?: BaseConflictReason,
	values: { base?: unknown; mine?: unknown; ancestor?: unknown } = {
		base: getAt(walk.roots.base, path),
		mine: getAt(walk.roots.mine, path),
		ancestor: getAt(walk.roots.ancestor, path),
	},
) {
	const change: BaseChange = { key: joinPath(path), kind, location: walk.locate(path) };
	if (values.base !== undefined) change.base = structuredClone(values.base);
	if (values.mine !== undefined) change.mine = structuredClone(values.mine);
	if (values.ancestor !== undefined) change.ancestor = structuredClone(values.ancestor);
	if (conflict) change.conflict = conflict;
	walk.changes.push(change);
}

/** The three-way compare of one value: nothing, a clean update, or a conflict. */
function compareLeaf(
	walk: Walk,
	path: readonly string[],
	a: Node | undefined,
	b: Node | undefined,
	v: Node | undefined,
) {
	if (nodesEqual(a, b)) return;
	const kind = b === undefined ? "remove" : "edit";
	if (nodesEqual(a, v)) return pushChange(walk, path, kind);
	if (nodesEqual(b, v)) return;
	pushChange(walk, path, kind, "both-edited");
}

function walkKeyed(walk: Walk, path: readonly string[], a: Node, b: Node, v: Node) {
	if (a.type !== "keyed" || b.type !== "keyed" || v.type !== "keyed") return compareLeaf(walk, path, a, b, v);

	const ids = new Set([...a.ids, ...b.ids, ...v.ids]);
	for (const id of ids) {
		const entryPath = [...path, id];
		const inA = a.entries.get(id);
		const inB = b.entries.get(id);
		const inV = v.entries.get(id);

		if (!inA) {
			if (!inB) continue; // Added here only.
			if (!inV) pushChange(walk, entryPath, "add");
			else if (!nodesEqual(inB, inV)) pushChange(walk, entryPath, "add", "both-edited");
			continue;
		}
		if (!inB) {
			if (!inV) continue; // Removed on both sides.
			if (nodesEqual(inA, inV)) pushChange(walk, entryPath, "remove");
			else pushChange(walk, entryPath, "remove", "edited-here");
			continue;
		}
		if (!inV) {
			if (!nodesEqual(inA, inB)) pushChange(walk, entryPath, "edit", "removed-here");
			continue;
		}
		walkNode(walk, entryPath, inA, inB, inV);
	}

	const baseReordered = !sameRelativeOrder(a.ids, b.ids);
	const mineReordered = !sameRelativeOrder(a.ids, v.ids);
	if (!baseReordered) return;
	const values = { base: b.ids, mine: v.ids, ancestor: a.ids };
	if (!mineReordered) pushChange(walk, [...path, ORDER], "reorder", undefined, values);
	else if (!sameRelativeOrder(b.ids, v.ids)) pushChange(walk, [...path, ORDER], "reorder", "both-edited", values);
}

function walkNode(walk: Walk, path: readonly string[], a: Node | undefined, b: Node | undefined, v: Node | undefined) {
	if (a?.type === "keyed" && b?.type === "keyed" && v?.type === "keyed") return walkKeyed(walk, path, a, b, v);
	if (a?.type === "object" && b?.type === "object" && v?.type === "object") {
		const keys = new Set([...a.fields.keys(), ...b.fields.keys(), ...v.fields.keys()]);
		for (const key of keys) walkNode(walk, [...path, key], a.fields.get(key), b.fields.get(key), v.fields.get(key));
		return;
	}
	compareLeaf(walk, path, a, b, v);
}

// ── Locations ──────────────────────────────────────────────────────────────────────────────────────────

const stripHtml = (html: string) =>
	html
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const PRIMARY_FIELDS = ["name", "title", "company", "school", "organization", "network", "language", "text"];
const SECONDARY_FIELDS = [
	"position",
	"degree",
	"area",
	"publisher",
	"issuer",
	"awarder",
	"username",
	"fluency",
	"proficiency",
	"label",
];

/** An entry as people know it: "Northwind Labs · Engineer", "University of Porto · BSc", or its first words. */
export function describeItem(item: unknown): string {
	if (!isObject(item)) return "";
	const text = (key: string) => {
		const value = item[key];
		return typeof value === "string" ? stripHtml(value) : "";
	};
	const primary = PRIMARY_FIELDS.map(text).find(Boolean) ?? "";
	const secondary = SECONDARY_FIELDS.map(text).find(Boolean) ?? "";
	if (primary && secondary) return `${primary} · ${secondary}`;
	if (primary || secondary) return primary || secondary;
	const body = ["content", "description", "recipient"].map(text).find(Boolean) ?? "";
	return body.length > 60 ? `${body.slice(0, 57).trimEnd()}…` : body;
}

type SectionLike = { title?: unknown; items?: unknown };

function findEntry(items: unknown, id: string): unknown {
	return Array.isArray(items) ? items.find((entry) => hasId(entry) && entry.id === id) : undefined;
}

/** Reads the same thing from the base first, then this variant: whichever still has it names it. */
function createLocator(base: ResumeData, mine: ResumeData) {
	const sources = [base, mine];

	const sectionOf = (id: string, custom: boolean): SectionLike | undefined => {
		for (const data of sources) {
			const section = custom
				? data.customSections.find((section) => section.id === id)
				: (data.sections as Record<string, SectionLike | undefined>)[id];
			if (section) return section;
		}
		return undefined;
	};

	const entryOf = (sectionId: string, custom: boolean, itemId: string): unknown => {
		for (const data of sources) {
			const section = custom
				? data.customSections.find((section) => section.id === sectionId)
				: (data.sections as Record<string, SectionLike | undefined>)[sectionId];
			const entry = findEntry(section?.items, itemId);
			if (entry) return entry;
		}
		return undefined;
	};

	const customFieldOf = (id: string): unknown => {
		for (const data of sources) {
			const field = findEntry(data.basics.customFields, id);
			if (field) return field;
		}
		return undefined;
	};

	const fieldFrom = (segments: readonly (string | undefined)[]) => {
		const field = segments.filter((segment): segment is string => segment !== undefined);
		return field.length > 0 ? { field: joinPath(field) } : {};
	};

	return (path: readonly string[]): ChangeLocation => {
		const [root, second, third, fourth, ...rest] = path;

		if (root === "basics" || root === "picture" || root === "summary") {
			if (root === "basics" && second === "customFields" && third !== undefined && third !== ORDER) {
				return {
					scope: "basics",
					item: { id: third, label: describeItem(customFieldOf(third)) },
					...fieldFrom([fourth, ...rest]),
				};
			}
			return { scope: root, ...fieldFrom([second, third, fourth, ...rest]) };
		}

		if (root === "sections" || root === "customSections") {
			if (second === undefined || second === ORDER) return { scope: "sections", field: "order" };
			const custom = root === "customSections";
			const section = sectionOf(second, custom);
			const title = typeof section?.title === "string" ? section.title : "";
			const location: ChangeLocation = { scope: "section", section: { id: second, title } };
			if (third === undefined) return location; // A whole custom section added or removed.
			if (third !== "items") return { ...location, ...fieldFrom([third, fourth, ...rest]) };
			if (fourth === undefined || fourth === ORDER) return { ...location, field: "order" };
			const item = entryOf(second, custom, fourth);
			location.item = { id: fourth, label: describeItem(item) };
			const [fifth, sixth, ...tail] = rest;
			if (fifth === "roles") {
				if (sixth === undefined || sixth === ORDER) return { ...location, field: "roles/order" };
				const role = findEntry(isObject(item) ? item.roles : undefined, sixth);
				location.role = { id: sixth, label: describeItem(role) };
				return { ...location, ...fieldFrom(tail) };
			}
			return { ...location, ...fieldFrom([fifth, sixth, ...tail]) };
		}

		return { scope: "metadata", ...fieldFrom(path.slice(1)) };
	};
}

// ── Public API ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * What changed in the base since this variant last synced, against what this variant changed itself.
 * `ancestor` is the base as it was at that sync; `base` is the base now; `mine` is the variant now.
 */
export function mergeFromBase(ancestor: ResumeData, base: ResumeData, mine: ResumeData): BaseMerge {
	const walk: Walk = { changes: [], roots: { ancestor, base, mine }, locate: createLocator(base, mine) };
	walkNode(walk, [], toNode(ancestor, []), toNode(base, []), toNode(mine, []));
	return {
		updates: walk.changes.filter((change) => !change.conflict),
		conflicts: walk.changes.filter((change) => change.conflict),
	};
}

// Applying: removals first, so positions for additions are computed on what remains; reorders last.
const APPLY_ORDER: Record<BaseChangeKind, number> = { remove: 0, edit: 1, add: 1, reorder: 2 };

function getAt(root: unknown, segments: readonly string[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		if (Array.isArray(current)) current = current.find((entry) => hasId(entry) && entry.id === segment);
		else if (isObject(current)) current = current[segment];
		else return undefined;
	}
	return current;
}

/** Where a base entry goes in this variant's array: right after the closest base sibling before it that's here. */
function insertionIndex(mineIds: readonly string[], baseIds: readonly string[], id: string) {
	const position = baseIds.indexOf(id);
	for (let index = position - 1; index >= 0; index -= 1) {
		const sibling = baseIds[index];
		const at = sibling === undefined ? -1 : mineIds.indexOf(sibling);
		if (at >= 0) return at + 1;
	}
	return 0;
}

/** The base's order for the ids both have; ids only this variant has keep the place they had. */
export function reorderLikeBase(mineIds: readonly string[], baseIds: readonly string[]): string[] {
	const shared = baseIds.filter((id) => mineIds.includes(id));
	const result = [...shared];
	mineIds.forEach((id, index) => {
		if (!shared.includes(id)) result.splice(Math.min(index, result.length), 0, id);
	});
	return result;
}

function setAt(root: unknown, segments: readonly string[], value: unknown, base: ResumeData) {
	const parentPath = segments.slice(0, -1);
	const last = segments.at(-1);
	if (last === undefined) return;
	const parent = getAt(root, parentPath);
	if (Array.isArray(parent)) {
		const index = parent.findIndex((entry) => hasId(entry) && entry.id === last);
		if (index >= 0) parent[index] = value;
		else {
			const baseArray = getAt(base, parentPath);
			const baseIds = Array.isArray(baseArray) ? baseArray.map((entry) => (hasId(entry) ? entry.id : "")) : [];
			const mineIds = parent.map((entry) => (hasId(entry) ? entry.id : ""));
			parent.splice(insertionIndex(mineIds, baseIds, last), 0, value);
		}
	} else if (isObject(parent)) {
		if (value === undefined) delete parent[last];
		else parent[last] = value;
	}
}

function removeAt(root: unknown, segments: readonly string[]) {
	const last = segments.at(-1);
	if (last === undefined) return;
	const parent = getAt(root, segments.slice(0, -1));
	if (Array.isArray(parent)) {
		const index = parent.findIndex((entry) => hasId(entry) && entry.id === last);
		if (index >= 0) parent.splice(index, 1);
	} else if (isObject(parent)) {
		delete parent[last];
	}
}

function reorderAt(root: unknown, segments: readonly string[], baseIds: readonly string[]) {
	const array = getAt(root, segments);
	if (!Array.isArray(array)) return;
	const byId = new Map(array.filter(hasId).map((entry) => [entry.id, entry]));
	const order = reorderLikeBase([...byId.keys()], baseIds);
	array.splice(0, array.length, ...order.map((id) => byId.get(id)));
}

/**
 * This variant with the chosen base changes taken. Updates are taken unless decided "mine"; conflicts are
 * taken only when decided "base". Returns a new object; `mine` is left as it is.
 */
export function applyBaseChanges(
	mine: ResumeData,
	base: ResumeData,
	merge: BaseMerge,
	decisions: readonly BaseDecision[] = [],
): ResumeData {
	const decided = new Map(decisions.map((decision) => [decision.key, decision.take]));
	const taken = [
		...merge.updates.filter((change) => decided.get(change.key) !== "mine"),
		...merge.conflicts.filter((change) => decided.get(change.key) === "base"),
	].sort((a, b) => APPLY_ORDER[a.kind] - APPLY_ORDER[b.kind]);

	const result = structuredClone(mine) as unknown;
	for (const change of taken) {
		const segments = splitChangeKey(change.key);
		if (change.kind === "reorder") {
			reorderAt(result, segments.slice(0, -1), Array.isArray(change.base) ? (change.base as string[]) : []);
		} else if (change.kind === "remove") {
			removeAt(result, segments);
		} else {
			setAt(result, segments, structuredClone(change.base), base);
		}
	}
	return result as ResumeData;
}

/** The conflicts with no decision yet; pulling needs every one of them decided. */
export const undecidedConflicts = (merge: BaseMerge, decisions: readonly BaseDecision[]) => {
	const decided = new Set(decisions.map((decision) => decision.key));
	return merge.conflicts.filter((conflict) => !decided.has(conflict.key));
};
