import type { DialogProps } from "../store";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import z from "zod";
import { Button } from "@reactive-resume/ui/components/button";
import {
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import { FormControl, FormDescription, FormItem, FormLabel, FormMessage } from "@reactive-resume/ui/components/form";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Input } from "@reactive-resume/ui/components/input";
import { SwitchRow } from "@reactive-resume/ui/components/switch";
import { toast } from "@reactive-resume/ui/components/toast";
import { generateRandomName } from "@reactive-resume/utils/string";
import { useDialogStore } from "../store";
import { ChipInput } from "@/components/input/chip-input";
import { usePatchResume } from "@/features/resume/builder/draft";
import { useFormBlocker } from "@/hooks/use-form-blocker";
import { getResumeErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";
import { useAppForm, withForm } from "@/libs/tanstack-form";

const formSchema = z.object({
	id: z.string(),
	name: z.string().min(1).max(64),
	tags: z.array(z.string()),
});

type FormValues = z.infer<typeof formSchema>;

const defaultValues: FormValues = {
	id: "",
	name: "",
	tags: [],
};

export function UpdateResumeDialog({ data }: DialogProps<"resume.update">) {
	const closeDialog = useDialogStore((state) => state.closeDialog);
	const patchResume = usePatchResume();
	const params = useParams({ strict: false }) as { resumeId?: string };

	const { mutate: updateResume, isPending } = useMutation(orpc.resume.update.mutationOptions());

	const form = useAppForm({
		defaultValues: {
			id: data.id,
			name: data.name,
			tags: data.tags,
		},
		validators: { onSubmit: formSchema },
		onSubmit: ({ value }) => {
			const toastId = toast.add({ type: "loading", description: t`Updating your resume...` });

			updateResume(value, {
				onSuccess: (updated) => {
					if (params.resumeId === updated.id) {
						patchResume((draft) => {
							draft.name = updated.name;
							draft.slug = updated.slug;
							draft.tags = updated.tags;
							draft.isLocked = updated.isLocked;
							draft.isPublic = updated.isPublic;
							draft.hasPassword = updated.hasPassword;
						});
					}

					toast.add({ type: "success", description: t`Your resume has been updated.`, id: toastId });
					closeDialog();
				},
				onError: (error) => {
					toast.add({ type: "error", description: getResumeErrorMessage(error), id: toastId });
				},
			});
		},
	});

	useFormBlocker(form);

	return (
		<DialogContent>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-x-2">
					<Icon name="pencil-simple" size={16} />
					<Trans>Update Resume</Trans>
				</DialogTitle>
				<DialogDescription>
					<Trans>Changed your mind? Rename your resume to something more descriptive.</Trans>
				</DialogDescription>
			</DialogHeader>

			<form
				className="space-y-4"
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void form.handleSubmit();
				}}
			>
				<ResumeForm form={form} />

				<DialogFooter>
					<Button type="submit" disabled={isPending}>
						<Trans>Save Changes</Trans>
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

/**
 * Duplicate, or New variant: the same form, with a switch that keeps the copy linked to the original. A variant
 * shows what changed in the original afterwards and takes those changes in without losing its own edits.
 */
export function DuplicateResumeDialog({ data }: DialogProps<"resume.duplicate">) {
	const navigate = useNavigate();
	const closeDialog = useDialogStore((state) => state.closeDialog);
	const [asVariant, setAsVariant] = useState(data.asVariant ?? false);

	const { mutate: duplicateResume, isPending: duplicating } = useMutation(orpc.resume.duplicate.mutationOptions());
	const { mutate: createVariant, isPending: creatingVariant } = useMutation(
		orpc.resume.createVariant.mutationOptions(),
	);
	const isPending = duplicating || creatingVariant;

	const form = useAppForm({
		defaultValues: {
			id: data.id,
			name: data.asVariant ? t`${data.name} (variant)` : `${data.name} (Copy)`,
			tags: data.tags,
		},
		validators: { onSubmit: formSchema },
		onSubmit: ({ value }) => {
			const toastId = toast.add({
				type: "loading",
				description: asVariant ? t`Creating the variant...` : t`Duplicating your resume...`,
			});
			const opened = (id: string) => {
				toast.add({
					type: "success",
					description: asVariant
						? t`The variant is ready. It stays linked to “${data.name}”.`
						: t`Your resume has been duplicated.`,
					id: toastId,
				});
				closeDialog();
				void navigate({ to: "/builder/$resumeId", params: { resumeId: id } });
			};
			const failed = (error: unknown) => {
				toast.add({ type: "error", description: getResumeErrorMessage(error), id: toastId });
			};

			if (asVariant) createVariant(value, { onSuccess: opened, onError: failed });
			else duplicateResume(value, { onSuccess: opened, onError: failed });
		},
	});

	useFormBlocker(form);

	return (
		<DialogContent>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-x-2">
					<Icon name={asVariant ? "git-branch" : "copy"} size={16} />
					{asVariant ? <Trans>New Variant</Trans> : <Trans>Duplicate Resume</Trans>}
				</DialogTitle>
				<DialogDescription>
					{asVariant ? (
						<Trans>
							A variant starts as a copy and stays linked to the original. Tailor it freely; when the original changes,
							the variant shows those changes and lets you take them in.
						</Trans>
					) : (
						<Trans>Duplicate your resume to create a new one, just like the original.</Trans>
					)}
				</DialogDescription>
			</DialogHeader>

			<form
				className="space-y-4"
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void form.handleSubmit();
				}}
			>
				<ResumeForm form={form} />

				<SwitchRow
					checked={asVariant}
					onCheckedChange={setAsVariant}
					label={t`Keep linked to “${data.name}” as a variant`}
					description={t`Fix a typo or add a job in the original, and this copy can pull it in. Its own edits are kept.`}
				/>

				<DialogFooter>
					<Button type="submit" disabled={isPending}>
						{asVariant ? <Trans>Create variant</Trans> : <Trans>Duplicate</Trans>}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

const ResumeForm = withForm({
	defaultValues,
	render: function ResumeFormRenderer({ form }) {
		const onGenerateName = () => {
			form.setFieldValue("name", generateRandomName());
		};

		return (
			<>
				<form.Field name="name">
					{(field) => (
						<FormItem hasError={field.state.meta.isTouched && field.state.meta.errors.length > 0}>
							<FormLabel>
								<Trans>Name</Trans>
							</FormLabel>
							<div className="flex items-center gap-x-2">
								<FormControl
									render={
										<Input
											minLength={1}
											maxLength={64}
											name={field.name}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(event) => field.handleChange(event.target.value)}
										/>
									}
								/>

								<Button size="icon" variant="secondary" title={t`Generate a random name`} onClick={onGenerateName}>
									<Icon name="magic-wand" size={16} />
								</Button>
							</div>
							<FormMessage errors={field.state.meta.errors} />
							<FormDescription>
								<Trans>Name the resume after the position you are applying for.</Trans>
							</FormDescription>
						</FormItem>
					)}
				</form.Field>

				<form.Field name="tags">
					{(field) => (
						<FormItem hasError={field.state.meta.isTouched && field.state.meta.errors.length > 0}>
							<FormLabel>
								<Trans>Tags</Trans>
							</FormLabel>
							<FormControl
								render={
									<ChipInput
										value={field.state.value}
										onChange={(value) => {
											field.handleChange(value);
										}}
									/>
								}
							/>
							<FormMessage errors={field.state.meta.errors} />
							<FormDescription>
								<Trans>Tags can be used to categorize your resume by keywords.</Trans>
							</FormDescription>
						</FormItem>
					)}
				</form.Field>
			</>
		);
	},
});
