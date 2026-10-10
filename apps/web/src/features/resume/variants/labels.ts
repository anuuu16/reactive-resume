import type { BaseChange } from "./queries";
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { describeItem } from "@reactive-resume/resume/variants";
import { formatResumeDates, resumeDatesSchema } from "@reactive-resume/schema/resume/dates";
import { getSectionTitle } from "@/libs/resume/section";

type Scope = BaseChange["location"]["scope"];

const BUILT_IN_SECTIONS = new Set([
	"profiles",
	"experience",
	"education",
	"projects",
	"skills",
	"languages",
	"interests",
	"awards",
	"certifications",
	"publications",
	"volunteer",
	"references",
]);

/** Field names as the editor labels them; anything else shows as written. */
function fieldLabel(field: string): string {
	switch (field) {
		case "name":
			return t`Name`;
		case "headline":
			return t`Headline`;
		case "email":
			return t`Email`;
		case "phone":
			return t`Phone`;
		case "location":
			return t`Location`;
		case "website":
		case "website/url":
			return t`Website`;
		case "website/label":
			return t`Website label`;
		case "content":
			return t`Content`;
		case "description":
			return t`Description`;
		case "title":
			return t`Title`;
		case "hidden":
			return t`Visibility`;
		case "columns":
			return t`Columns`;
		case "order":
			return t`Order`;
		case "roles/order":
			return t`Order of roles`;
		case "dates":
			return t`Dates`;
		case "company":
			return t`Company`;
		case "position":
			return t`Position`;
		case "school":
			return t`School`;
		case "degree":
			return t`Degree`;
		case "area":
			return t`Area of study`;
		case "grade":
			return t`Grade`;
		case "keywords":
			return t`Keywords`;
		case "level":
			return t`Level`;
		case "proficiency":
			return t`Proficiency`;
		case "fluency":
			return t`Fluency`;
		case "organization":
			return t`Organization`;
		case "publisher":
			return t`Publisher`;
		case "issuer":
			return t`Issuer`;
		case "awarder":
			return t`Awarder`;
		case "network":
			return t`Network`;
		case "username":
			return t`Username`;
		case "icon":
			return t`Icon`;
		case "url":
			return t`Picture`;
		case "template":
			return t`Template`;
		case "layout":
			return t`Layout`;
		case "notes":
			return t`Notes`;
		case "stylesheet":
			return t`Custom styles`;
		case "styleRules":
			return t`Style rules`;
		case "check":
			return t`Check choices`;
		default:
			return field.startsWith("page/")
				? `${t`Page`} · ${field.slice(5)}`
				: field.startsWith("typography/")
					? `${t`Typography`} · ${field.slice(11).replaceAll("/", " · ")}`
					: field.startsWith("design/")
						? `${t`Design`} · ${field.slice(7).replaceAll("/", " · ")}`
						: field.replaceAll("/", " · ");
	}
}

function scopeLabel(scope: Scope, section: BaseChange["location"]["section"]): string {
	switch (scope) {
		case "basics":
			return getSectionTitle("basics");
		case "picture":
			return getSectionTitle("picture");
		case "summary":
			return getSectionTitle("summary");
		case "sections":
			return getSectionTitle("custom");
		case "metadata":
			return getSectionTitle("design");
		case "section":
			if (!section) return "";
			if (section.title) return section.title;
			return BUILT_IN_SECTIONS.has(section.id) ? getSectionTitle(section.id as never) : t`Custom section`;
	}
}

/** "Experience · Northwind Labs · Engineer · Description": where a change lands, for people. */
export function describeChangeLocation(change: BaseChange): string {
	const { location } = change;
	const parts = [scopeLabel(location.scope, location.section)];
	if (location.item) parts.push(location.item.label || t`Untitled entry`);
	if (location.role) parts.push(location.role.label || t`Role`);
	const fieldSaysNothingNew =
		(change.kind === "reorder" && location.field === "order") ||
		(location.scope === "picture" && location.field === "url");
	if (location.field && !fieldSaysNothingNew) parts.push(fieldLabel(location.field));
	return parts.filter(Boolean).join(" · ");
}

/** What the base did, as a verb phrase. */
export function describeChangeKind(change: BaseChange): string {
	switch (change.kind) {
		case "add":
			return change.location.item || change.location.role ? t`Added entry` : t`Added`;
		case "remove":
			return change.location.item || change.location.role ? t`Removed entry` : t`Removed`;
		case "reorder":
			return t`Reordered`;
		case "edit":
			return change.conflict === "removed-here" ? t`Edited an entry you removed` : t`Edited`;
	}
}

/** Why a conflict needs a decision. */
export function describeConflict(change: BaseChange): string {
	switch (change.conflict) {
		case "both-edited":
			return t`Changed in both`;
		case "edited-here":
			return t`Removed in the base, edited here`;
		case "removed-here":
			return t`Edited in the base, removed here`;
		default:
			return "";
	}
}

const stripHtml = (html: string) =>
	html
		.replace(/<\/(p|li|h[1-6]|div|br)>/gi, " ")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();

const MAX_PREVIEW = 240;

/** A value as a short line of text: rich text without tags, booleans as words, lists joined, entries by label. */
export function previewValue(value: unknown, change?: BaseChange): string {
	if (value === undefined || value === null) return t`(none)`;
	if (typeof value === "string") {
		const text = stripHtml(value);
		if (!text) return t`(empty)`;
		return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 1).trimEnd()}…` : text;
	}
	if (typeof value === "boolean") {
		if (change?.location.field === "hidden") return value ? t`Hidden` : t`Shown`;
		return value ? t`Yes` : t`No`;
	}
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) {
		if (change?.kind === "reorder") return t`${value.length} entries in the base's order`;
		if (value.every((entry) => typeof entry === "string")) return value.join(", ") || t`(empty)`;
		return t`${value.length} entries`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		// A whole entry (added, removed, or re-added): what it's called, then its text.
		if (typeof record.id === "string" && (change?.location.item || change?.location.role) && !change.location.field) {
			const label = describeItem(record);
			const body = ["description", "content", "keywords"]
				.map((key) => {
					const text = record[key];
					if (Array.isArray(text)) return text.join(", ");
					return typeof text === "string" ? stripHtml(text) : "";
				})
				.find(Boolean);
			const summary = [label, body].filter(Boolean).join(" — ") || t`(empty)`;
			return summary.length > MAX_PREVIEW ? `${summary.slice(0, MAX_PREVIEW - 1).trimEnd()}…` : summary;
		}
		if ("start" in record || "present" in record) {
			const dates = resumeDatesSchema.safeParse(record);
			const text = dates.success ? formatResumeDates(dates.data, { locale: i18n.locale }) : "";
			return text || t`(empty)`;
		}
		if (typeof record.url === "string" && "label" in record)
			return (record.label as string) || record.url || t`(empty)`;
		return t`Updated settings`;
	}
	return String(value);
}
