import z from "zod";
import { protectedProcedure } from "../../context";
import { resumeDto } from "../../dto/resume";
import { resumeMutationRateLimit } from "../../middleware/rate-limit";
import { variantService } from "./variant-sync";

/** Variants: resumes that stay linked to the base they were made from, and pull its changes in on request. */
export const variantsRouter = {
	createVariant: protectedProcedure
		.route({
			method: "POST",
			path: "/resumes/{id}/variants",
			tags: ["Resumes"],
			operationId: "createResumeVariant",
			summary: "Create a variant of a resume",
			description:
				"Creates a new resume with the same data as the base resume, linked to it. Unlike a duplicate, a variant keeps track of what changed in the base afterwards: getResumeVariantStatus lists the base's changes, and pullResumeBaseUpdates takes them in while keeping the variant's own edits. Returns the ID of the variant. Requires authentication.",
			successDescription: "The ID of the new variant.",
		})
		.input(resumeDto.createVariant.input)
		.use(resumeMutationRateLimit)
		.output(resumeDto.createVariant.output)
		.errors({
			RESUME_SLUG_ALREADY_EXISTS: { message: "A resume with this slug already exists.", status: 400 },
		})
		.handler(({ context, input }) =>
			variantService.create({
				userId: context.user.id,
				baseId: input.id,
				name: input.name,
				slug: input.slug,
				tags: input.tags,
				locale: context.locale,
			}),
		),

	getVariantStatus: protectedProcedure
		.route({
			method: "GET",
			path: "/resumes/{id}/variant",
			tags: ["Resumes"],
			operationId: "getResumeVariantStatus",
			summary: "Get a resume's variant links and pending base updates",
			description:
				"Returns the base a resume is a variant of (if any), the live variants made from it, and what the base changed since the variant last pulled: updates the variant can take as they are, and conflicts where both changed the same value. Each change carries a key to decide on, where it lands, and the base's, the variant's and the starting value. Requires authentication.",
			successDescription: "The variant links and the base's pending changes.",
		})
		.input(resumeDto.getVariantStatus.input)
		.output(resumeDto.getVariantStatus.output)
		.handler(({ context, input }) => variantService.status({ id: input.id, userId: context.user.id })),

	pullBaseUpdates: protectedProcedure
		.route({
			method: "POST",
			path: "/resumes/{id}/variant/pull",
			tags: ["Resumes"],
			operationId: "pullResumeBaseUpdates",
			summary: "Take the base's changes into a variant",
			description:
				"Applies the base resume's changes to the variant: every update unless decided “mine”, and every conflict decided “base”. Every conflict listed by getResumeVariantStatus needs a decision, or the request fails with VARIANT_CONFLICTS_UNDECIDED. The variant's own edits are kept, the result is saved as a version, and the base's current data becomes the variant's reference, so a skipped update isn't offered again until the base changes it once more. Locked variants can't be updated. Requires authentication.",
			successDescription: "The updated variant with its full data.",
		})
		.input(resumeDto.pullBaseUpdates.input)
		.use(resumeMutationRateLimit)
		.output(resumeDto.pullBaseUpdates.output)
		.errors({
			RESUME_LOCKED: { status: 403, message: "Unlock the resume first." },
			RESUME_NOT_A_VARIANT: { status: 400, message: "This resume isn't a variant of another one." },
			BASE_RESUME_IN_TRASH: { status: 400, message: "Restore the base resume first." },
			VARIANT_CONFLICTS_UNDECIDED: {
				status: 409,
				message: "Pick a side for every conflict first.",
				data: z.object({ keys: z.array(z.string()) }),
			},
		})
		.handler(({ context, input }) =>
			variantService.pull({ id: input.id, userId: context.user.id, decisions: input.decisions }),
		),

	detachVariant: protectedProcedure
		.route({
			method: "POST",
			path: "/resumes/{id}/variant/detach",
			tags: ["Resumes"],
			operationId: "detachResumeVariant",
			summary: "Unlink a variant from its base",
			description:
				"Makes the variant a resume of its own. Its data stays as it is; the base's later changes are no longer offered. Requires authentication.",
			successDescription: "The resume is no longer a variant.",
		})
		.input(resumeDto.detachVariant.input)
		.use(resumeMutationRateLimit)
		.output(resumeDto.detachVariant.output)
		.errors({ RESUME_NOT_A_VARIANT: { status: 400, message: "This resume isn't a variant of another one." } })
		.handler(({ context, input }) => variantService.detach({ id: input.id, userId: context.user.id })),

	listVariantUpdates: protectedProcedure
		.route({
			method: "GET",
			path: "/resumes/variant-updates",
			tags: ["Resumes"],
			operationId: "listResumeVariantUpdates",
			summary: "Count pending base updates per variant",
			description:
				"For each live variant whose base changed since it last pulled, how many changes it can take and how many need a decision. Variants that are up to date are left out. Requires authentication.",
			successDescription: "The variants with pending base changes and their counts.",
		})
		.input(z.object({}).optional())
		.output(resumeDto.listVariantUpdates.output)
		.handler(({ context }) => variantService.listUpdates({ userId: context.user.id })),
};
