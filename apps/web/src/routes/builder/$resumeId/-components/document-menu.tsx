import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@reactive-resume/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@reactive-resume/ui/components/dropdown-menu";
import { Icon } from "@reactive-resume/ui/components/icon";
import { toast } from "@reactive-resume/ui/components/toast";
import { NotesSectionBuilder } from "../-sidebar/right/sections/notes";
import { DocumentDetails } from "./document-details";
import { useDialogStore } from "@/dialogs/store";
import { useCurrentBuilderResumeSelector, useCurrentResume, usePatchResume } from "@/features/resume/builder/draft";
import { DocumentMenuTrigger } from "@/features/resume/editor/chrome";
import { SaveStatus } from "@/features/resume/editor/save-status";
import { useEditorStore } from "@/features/resume/editor/store";
import { useResumeExport } from "@/features/resume/export/use-resume-export";
import { BaseUpdatesDialog } from "@/features/resume/variants/base-updates-dialog";
import { useVariantStatus, VariantIndicator } from "@/features/resume/variants/variant-indicator";
import { useConfirm } from "@/hooks/use-confirm";
import { getResumeErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type DocumentDialog = "notes" | "details" | null;

/**
 * The document name in the editor bar opens the document menu: rename, duplicate, lock, notes,
 * details, print and delete. A variant also shows its base under the name, with the base's pending changes.
 */
export function DocumentMenu() {
	const name = useCurrentBuilderResumeSelector((resume) => resume.name);
	const isLocked = useCurrentBuilderResumeSelector((resume) => resume.isLocked);
	const [dialog, setDialog] = useState<DocumentDialog>(null);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger render={<DocumentMenuTrigger name={name} isLocked={isLocked} />} />
				<DocumentMenuItems onOpenDialog={setDialog} />
			</DropdownMenu>
			<span className="flex max-w-full min-w-0 items-center gap-1.5">
				<SaveStatus />
				<VariantIndicator />
			</span>
			<BaseUpdatesDialog />

			<Dialog open={dialog === "notes"} onOpenChange={(open) => !open && setDialog(null)}>
				<DialogContent className="sm:max-w-[560px]">
					<DialogHeader>
						<DialogTitle>
							<Trans>Notes</Trans>
						</DialogTitle>
					</DialogHeader>
					<NotesSectionBuilder />
				</DialogContent>
			</Dialog>

			<Dialog open={dialog === "details"} onOpenChange={(open) => !open && setDialog(null)}>
				<DialogContent className="sm:max-w-[440px]">
					<DocumentDetails />
				</DialogContent>
			</Dialog>
		</>
	);
}

type DocumentMenuItemsProps = {
	onOpenDialog: (dialog: DocumentDialog) => void;
};

function DocumentMenuItems({ onOpenDialog }: DocumentMenuItemsProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const confirm = useConfirm();
	const { openDialog } = useDialogStore();
	const resume = useCurrentResume();
	const patchResume = usePatchResume();
	const { onPrint } = useResumeExport(resume);
	const { id, name, slug, tags, isLocked, baseResumeId } = resume;
	const { data: variantStatus } = useVariantStatus();
	const setBaseUpdatesOpen = useEditorStore((state) => state.setBaseUpdatesOpen);
	const pendingFromBase = variantStatus ? variantStatus.updates.length + variantStatus.conflicts.length : 0;

	const { mutate: trashResume } = useMutation(orpc.documents.trash.mutationOptions());
	const { mutate: restoreResume } = useMutation(orpc.documents.restore.mutationOptions());
	const { mutate: setLockedResume } = useMutation(orpc.resume.setLocked.mutationOptions());
	const { mutate: detachVariant } = useMutation(orpc.resume.detachVariant.mutationOptions());

	// Unlinking can't be undone (the base's later changes are no longer offered), so it asks first.
	const handleDetach = async () => {
		const baseName = variantStatus?.base?.name ?? t`its base`;
		const confirmed = await confirm(t`Unlink from ${baseName}?`, {
			description: t`This resume keeps everything as it is, but changes made to the base won't be offered anymore.`,
			confirmText: t`Unlink`,
		});
		if (!confirmed) return;
		detachVariant(
			{ id },
			{
				onSuccess: () => {
					patchResume((draft) => {
						draft.baseResumeId = null;
					});
					queryClient.setQueryData(orpc.resume.getById.queryKey({ input: { id } }), (current) =>
						current ? { ...current, baseResumeId: null } : current,
					);
					toast.add({ description: t`Unlinked from ${baseName}. This is a resume of its own now.` });
				},
				onError: (error) => {
					toast.add({ type: "error", description: getResumeErrorMessage(error) });
				},
			},
		);
	};

	// Locking is reversible, so it doesn't ask for confirmation.
	const handleToggleLock = () => {
		setLockedResume(
			{ id, isLocked: !isLocked },
			{
				onSuccess: () => {
					patchResume((draft) => {
						draft.isLocked = !isLocked;
					});
				},
				onError: (error) => {
					toast.add({ type: "error", description: getResumeErrorMessage(error) });
				},
			},
		);
	};

	// Undoable, so it doesn't ask first: the resume waits in Trash for 30 days.
	const handleTrash = () => {
		trashResume(
			{ type: "resume", id },
			{
				onSuccess: () => {
					void navigate({ to: "/dashboard" });
					toast.add({
						description: t`“${name}” moved to Trash`,
						actionProps: {
							children: t`Undo`,
							onClick: () =>
								restoreResume(
									{ type: "resume", id },
									{ onError: (error) => toast.add({ type: "error", description: getResumeErrorMessage(error) }) },
								),
						},
					});
				},
				onError: (error) => {
					toast.add({ type: "error", description: getResumeErrorMessage(error) });
				},
			},
		);
	};

	return (
		<DropdownMenuContent align="start" className="w-60">
			<DropdownMenuItem disabled={isLocked} onClick={() => openDialog("resume.update", { id, name, slug, tags })}>
				<Icon name="pencil-simple" />
				<Trans>Rename…</Trans>
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => openDialog("resume.duplicate", { id, name, tags })}>
				<Icon name="copy" />
				<Trans>Duplicate</Trans>
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => openDialog("resume.duplicate", { id, name, tags, asVariant: true })}>
				<Icon name="git-branch" />
				<Trans>New variant…</Trans>
			</DropdownMenuItem>
			<DropdownMenuItem onClick={handleToggleLock}>
				<Icon name={isLocked ? "lock-open" : "lock"} />
				{isLocked ? <Trans>Unlock editing</Trans> : <Trans>Lock editing</Trans>}
			</DropdownMenuItem>
			{baseResumeId && (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setBaseUpdatesOpen(true)}>
						<Icon name="git-merge" />
						<Trans>Updates from base…</Trans>
						{pendingFromBase > 0 && (
							<span className="ms-auto rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-text">
								{pendingFromBase}
							</span>
						)}
					</DropdownMenuItem>
					{variantStatus?.base?.trashedAt ? (
						// A resume in Trash isn't opened for editing; Trash is where it can be restored.
						<DropdownMenuItem onClick={() => void navigate({ to: "/dashboard/trash" })}>
							<Icon name="trash" />
							<Trans>Base is in Trash · Open Trash</Trans>
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem
							onClick={() => void navigate({ to: "/builder/$resumeId", params: { resumeId: baseResumeId } })}
						>
							<Icon name="arrow-square-out" />
							<Trans>Open the base resume</Trans>
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onClick={() => void handleDetach()}>
						<Icon name="link-simple-horizontal-break" />
						<Trans>Unlink from base…</Trans>
					</DropdownMenuItem>
				</>
			)}
			<DropdownMenuSeparator />
			<DropdownMenuItem onClick={() => onOpenDialog("notes")}>
				<Icon name="note" />
				<Trans>Notes</Trans>
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => onOpenDialog("details")}>
				<Icon name="info" />
				<Trans>Details</Trans>
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => void onPrint()}>
				<Icon name="printer" />
				<Trans>Print</Trans>
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem variant="destructive" disabled={isLocked} onClick={handleTrash}>
				<Icon name="trash" />
				<Trans>Move to Trash</Trans>
			</DropdownMenuItem>
		</DropdownMenuContent>
	);
}
