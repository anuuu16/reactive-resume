import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Icon } from "@reactive-resume/ui/components/icon";
import { cn } from "@reactive-resume/utils/style";
import { variantStatusQueryOptions } from "./queries";
import { useCurrentBuilderResumeSelector, usePatchResume } from "@/features/resume/builder/draft";
import { useEditorStore } from "@/features/resume/editor/store";
import { ENTER_CLASS } from "@/libs/motion";
import { orpc } from "@/libs/orpc/client";

/**
 * The base a variant is linked to, and what it changed, for the editor. Polls while the editor is open. When the
 * base has been deleted for good meanwhile, the link is gone on the server; the open editor learns it from here.
 */
export function useVariantStatus() {
	const id = useCurrentBuilderResumeSelector((resume) => resume.id);
	const baseResumeId = useCurrentBuilderResumeSelector((resume) => resume.baseResumeId ?? null);
	const patchResume = usePatchResume();
	const queryClient = useQueryClient();
	const query = useQuery({
		...variantStatusQueryOptions(id),
		enabled: baseResumeId !== null,
		refetchInterval: 60_000,
		refetchOnWindowFocus: true,
	});

	const unlinked = baseResumeId !== null && query.data?.base === null;
	useEffect(() => {
		if (!unlinked) return;
		patchResume((draft) => {
			draft.baseResumeId = null;
		});
		queryClient.setQueryData(orpc.resume.getById.queryKey({ input: { id } }), (current) =>
			current ? { ...current, baseResumeId: null } : current,
		);
	}, [unlinked, id, patchResume, queryClient]);

	return query;
}

/**
 * Under the document name of a variant: "Variant of Main resume" ("… (in Trash)" while the base waits there),
 * or "3 updates from base" as a button that opens the review dialog when the base changed.
 */
export function VariantIndicator() {
	const baseResumeId = useCurrentBuilderResumeSelector((resume) => resume.baseResumeId ?? null);
	const { data: status } = useVariantStatus();
	const setOpen = useEditorStore((state) => state.setBaseUpdatesOpen);
	// Unlinking leaves the last status in the cache; the resume's own link is what counts.
	const base = baseResumeId ? status?.base : null;
	if (!status || !base) return null;

	const pending = status.updates.length + status.conflicts.length;
	const conflicts = status.conflicts.length;
	const inTrash = base.trashedAt !== null;

	return (
		<>
			<span aria-hidden="true" className="text-xs text-ink-3">
				·
			</span>
			<button
				type="button"
				onClick={() => setOpen(true)}
				title={
					inTrash
						? t`${base.name} is in Trash. Restore it to see its changes.`
						: pending > 0
							? t`Review the changes made to ${base.name}`
							: t`Variant of ${base.name}`
				}
				className={cn(
					ENTER_CLASS,
					"flex min-w-0 items-center gap-1 rounded-sm text-xs leading-4 transition-colors duration-quick hover:underline",
					pending > 0 ? "font-semibold text-accent-text" : "text-ink-3",
				)}
			>
				<Icon name={inTrash ? "trash" : pending > 0 ? "git-merge" : "git-branch"} size={14} className="shrink-0" />
				<span className="truncate">
					{inTrash ? (
						<>
							<Trans>Variant of {base.name}</Trans> <Trans>(in Trash)</Trans>
						</>
					) : pending === 0 ? (
						<Trans>Variant of {base.name}</Trans>
					) : (
						<>
							<Plural value={pending} one="# update from base" other="# updates from base" />
							{conflicts > 0 && (
								<>
									{" · "}
									<Plural value={conflicts} one="# conflict" other="# conflicts" />
								</>
							)}
						</>
					)}
				</span>
			</button>
		</>
	);
}
