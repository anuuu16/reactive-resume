import type { BaseChange, BaseDecision, BaseMerge } from "@reactive-resume/resume/variants";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { Locale } from "@reactive-resume/utils/locale";
import { ORPCError } from "@orpc/client";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { applyBaseChanges, mergeFromBase, undecidedConflicts } from "@reactive-resume/resume/variants";
import { adoptEmbeddedLetters } from "../cover-letters/embedded";
import { publishResumeUpdated } from "./events";
import { parseStoredResumeData, parseWritableResumeData } from "./resume-data-validation";
import { resumeService } from "./service";
import { writeVersion } from "./version-history";

/**
 * Variants: a resume made from a base resume that stays linked to it. Duplicate makes a dead copy, so a typo
 * fixed or a job added in the main resume never reaches the tailored copies. A variant keeps its own edits and
 * pulls the base's changes in when asked, one by one, with a conflict wherever both sides changed the same thing.
 *
 * The link is three columns on the variant: the base's id, the base's data as of the last pull (the ancestor
 * of the three-way merge in @reactive-resume/resume/variants), and when that was.
 */

type VariantBase = {
	id: string;
	name: string;
	/** The base is in Trash: its updates wait until it's restored. */
	trashedAt: Date | null;
	updatedAt: Date;
};

export type VariantStatus = {
	/** The base this resume is a variant of; null for a resume of its own (or one whose base was deleted). */
	base: VariantBase | null;
	/** Live variants made from this resume. */
	variants: { id: string; name: string; updatedAt: Date }[];
	/** When this variant last took the base's changes (or was made). */
	syncedAt: Date | null;
	/** The base's changes this variant can take as they are. */
	updates: BaseChange[];
	/** The base's changes this variant also changed; each needs a side picked. */
	conflicts: BaseChange[];
};

const notLinked = () =>
	new ORPCError("RESUME_NOT_A_VARIANT", { status: 400, message: "This resume isn't a variant of another one." });

async function readBase(userId: string, baseId: string) {
	const [base] = await db
		.select({
			id: schema.resume.id,
			name: schema.resume.name,
			data: schema.resume.data,
			trashedAt: schema.resume.trashedAt,
			updatedAt: schema.resume.updatedAt,
		})
		.from(schema.resume)
		.where(and(eq(schema.resume.id, baseId), eq(schema.resume.userId, userId)));
	return base;
}

/** The merge for one variant, from stored rows. A missing snapshot (never expected) reads as nothing to take. */
function mergeRows(variant: { data: ResumeData; baseSnapshot: ResumeData | null }, base: { data: ResumeData }) {
	const baseData = parseStoredResumeData(base.data);
	const ancestor = variant.baseSnapshot ? parseStoredResumeData(variant.baseSnapshot) : baseData;
	return { merge: mergeFromBase(ancestor, baseData, parseStoredResumeData(variant.data)), baseData };
}

const emptyMerge: BaseMerge = { updates: [], conflicts: [] };

export const variantService = {
	/** A new resume with the base's data, linked to it. */
	create: async (input: {
		userId: string;
		baseId: string;
		name?: string | undefined;
		slug?: string | undefined;
		tags?: string[] | undefined;
		locale: Locale;
	}) => {
		const base = await resumeService.getById({ id: input.baseId, userId: input.userId });
		const baseLocale = (base.data.metadata.page.locale || input.locale) as Locale;

		return resumeService.create({
			userId: input.userId,
			name: input.name ?? `${base.name} (variant)`.slice(0, 100),
			...(input.slug ? { slug: input.slug } : {}),
			tags: input.tags ?? base.tags,
			locale: baseLocale,
			data: base.data,
			base: { id: base.id, data: base.data },
		});
	},

	/** The link both ways, and what the base changed since this variant last pulled. */
	status: async (input: { id: string; userId: string }): Promise<VariantStatus> => {
		const [resume] = await db
			.select({
				id: schema.resume.id,
				data: schema.resume.data,
				baseResumeId: schema.resume.baseResumeId,
				baseSnapshot: schema.resume.baseSnapshot,
				baseSyncedAt: schema.resume.baseSyncedAt,
			})
			.from(schema.resume)
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)));
		if (!resume) throw new ORPCError("NOT_FOUND");

		const variants = await db
			.select({ id: schema.resume.id, name: schema.resume.name, updatedAt: schema.resume.updatedAt })
			.from(schema.resume)
			.where(
				and(
					eq(schema.resume.userId, input.userId),
					eq(schema.resume.baseResumeId, input.id),
					isNull(schema.resume.trashedAt),
				),
			);

		const base = resume.baseResumeId ? await readBase(input.userId, resume.baseResumeId) : undefined;
		if (!base) return { base: null, variants, syncedAt: null, ...emptyMerge };

		// A base in Trash may be restored or deleted; either way its changes aren't offered meanwhile.
		const { merge } = base.trashedAt ? { merge: emptyMerge } : mergeRows(resume, base);
		return {
			base: { id: base.id, name: base.name, trashedAt: base.trashedAt, updatedAt: base.updatedAt },
			variants,
			syncedAt: resume.baseSyncedAt,
			...merge,
		};
	},

	/**
	 * Takes the base's changes into this variant: every update unless decided "mine", and every conflict decided
	 * "base". Each conflict needs a decision. The base's data then becomes the snapshot, so a skipped update isn't
	 * offered again until the base changes that value once more.
	 */
	pull: async (input: { id: string; userId: string; decisions: BaseDecision[] }) => {
		const resume = await db.transaction(async (tx) => {
			const [variant] = await tx
				.select({
					id: schema.resume.id,
					name: schema.resume.name,
					data: schema.resume.data,
					isLocked: schema.resume.isLocked,
					baseResumeId: schema.resume.baseResumeId,
					baseSnapshot: schema.resume.baseSnapshot,
				})
				.from(schema.resume)
				.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)))
				.for("update");
			if (!variant) throw new ORPCError("NOT_FOUND");
			if (variant.isLocked) throw new ORPCError("RESUME_LOCKED", { status: 403 });
			if (!variant.baseResumeId) throw notLinked();

			const [base] = await tx
				.select({ id: schema.resume.id, data: schema.resume.data, trashedAt: schema.resume.trashedAt })
				.from(schema.resume)
				.where(and(eq(schema.resume.id, variant.baseResumeId), eq(schema.resume.userId, input.userId)));
			if (!base) throw notLinked();
			if (base.trashedAt)
				throw new ORPCError("BASE_RESUME_IN_TRASH", { status: 400, message: "Restore the base resume first." });

			const { merge, baseData } = mergeRows(variant, base);
			const undecided = undecidedConflicts(merge, input.decisions);
			if (undecided.length > 0) {
				throw new ORPCError("VARIANT_CONFLICTS_UNDECIDED", {
					status: 409,
					message: "Pick a side for every conflict first.",
					data: { keys: undecided.map((conflict) => conflict.key) },
				});
			}

			const mine = parseStoredResumeData(variant.data);
			const merged = parseWritableResumeData(applyBaseChanges(mine, baseData, merge, input.decisions));
			await adoptEmbeddedLetters(tx, {
				userId: input.userId,
				resumeId: variant.id,
				resumeName: variant.name,
				data: merged,
			});

			const [updated] = await tx
				.update(schema.resume)
				.set({ data: merged, baseSnapshot: base.data, baseSyncedAt: new Date() })
				.where(and(eq(schema.resume.id, variant.id), eq(schema.resume.userId, input.userId)))
				.returning({
					id: schema.resume.id,
					name: schema.resume.name,
					slug: schema.resume.slug,
					tags: schema.resume.tags,
					data: schema.resume.data,
					isPublic: schema.resume.isPublic,
					isLocked: schema.resume.isLocked,
					showDownloadButtons: schema.resume.showDownloadButtons,
					createdAt: schema.resume.createdAt,
					updatedAt: schema.resume.updatedAt,
					hasPassword: sql<boolean>`${schema.resume.password} IS NOT NULL`,
				});
			if (!updated) throw new ORPCError("NOT_FOUND");

			// Taking updates is a step of its own in History, so it can be undone like a restore.
			const taken = merge.updates.length + merge.conflicts.length;
			if (taken > 0) {
				await writeVersion(tx, { resumeId: updated.id, userId: input.userId, data: updated.data, kind: "base-update" });
			}
			return updated;
		});

		await publishResumeUpdated({
			type: "resume.updated",
			resumeId: resume.id,
			userId: input.userId,
			updatedAt: resume.updatedAt.toISOString(),
			mutation: "update",
		}).catch((error: unknown) => console.warn("Failed to publish resume.updated event:", error));

		return { ...resume, data: parseStoredResumeData(resume.data) };
	},

	/** Makes the variant a resume of its own: the link and the snapshot go, the data stays. */
	detach: async (input: { id: string; userId: string }) => {
		const [row] = await db
			.update(schema.resume)
			.set({ baseResumeId: null, baseSnapshot: null, baseSyncedAt: null })
			.where(
				and(
					eq(schema.resume.id, input.id),
					eq(schema.resume.userId, input.userId),
					isNotNull(schema.resume.baseResumeId),
				),
			)
			.returning({ id: schema.resume.id });
		if (!row) throw notLinked();
	},

	/**
	 * How many changes each live variant can take from its base, for the library. Only variants whose base's
	 * data differs from their snapshot are compared; the rest are up to date by definition.
	 */
	listUpdates: async (input: { userId: string }) => {
		const stale = await db
			.select({
				id: schema.resume.id,
				data: schema.resume.data,
				baseResumeId: schema.resume.baseResumeId,
				baseSnapshot: schema.resume.baseSnapshot,
			})
			.from(schema.resume)
			.where(
				and(
					eq(schema.resume.userId, input.userId),
					isNull(schema.resume.trashedAt),
					isNotNull(schema.resume.baseResumeId),
					sql`EXISTS (SELECT 1 FROM ${schema.resume} AS base WHERE base.id = ${schema.resume.baseResumeId} AND base.trashed_at IS NULL AND base.data IS DISTINCT FROM ${schema.resume.baseSnapshot})`,
				),
			);
		if (stale.length === 0) return [];

		const baseIds = [...new Set(stale.map((variant) => variant.baseResumeId as string))];
		const bases = await db
			.select({ id: schema.resume.id, data: schema.resume.data })
			.from(schema.resume)
			.where(and(eq(schema.resume.userId, input.userId), inArray(schema.resume.id, baseIds)));
		const baseById = new Map(bases.map((base) => [base.id, base]));

		return stale.flatMap((variant) => {
			const base = baseById.get(variant.baseResumeId as string);
			if (!base) return [];
			const { merge } = mergeRows(variant, base);
			if (merge.updates.length === 0 && merge.conflicts.length === 0) return [];
			return [
				{
					id: variant.id,
					baseId: base.id,
					updates: merge.updates.length,
					conflicts: merge.conflicts.length,
				},
			];
		});
	},
};
