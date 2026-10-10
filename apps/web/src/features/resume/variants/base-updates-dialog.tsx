import type { BaseChange } from "./queries";
import type { Resume } from "@/features/resume/builder/draft";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { cn } from "@reactive-resume/utils/style";
import { describeChangeKind, describeChangeLocation, describeConflict, previewValue } from "./labels";
import { variantStatusQueryOptions, variantUpdatesQueryOptions } from "./queries";
import { savePendingChanges, useCurrentResume, useResumeStore } from "@/features/resume/builder/draft";
import { useEditorStore } from "@/features/resume/editor/store";
import { getResumeErrorMessage } from "@/libs/error-message";
import { formatRelativeTime } from "@/libs/locale";
import { orpc } from "@/libs/orpc/client";

type Side = "base" | "mine";

/**
 * Updates from base: what the base resume changed since this variant last took its changes. Updates are
 * ticked to take (all, by default); conflicts, where both sides changed the same thing, need a side each.
 * Taking them saves a version first, so it can be undone from History.
 */
export function BaseUpdatesDialog() {
	const open = useEditorStore((state) => state.baseUpdatesOpen);
	const setOpen = useEditorStore((state) => state.setBaseUpdatesOpen);
	const resume = useCurrentResume();

	return (
		<Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
			<DialogContent className="sm:max-w-[680px]" closeLabel={t`Close`}>
				{open && <BaseUpdatesReview resume={resume} onDone={() => setOpen(false)} />}
			</DialogContent>
		</Dialog>
	);
}

/** Mounted while the dialog is open, so each opening starts from the latest status and fresh choices. */
function BaseUpdatesReview({ resume, onDone }: { resume: Resume; onDone: () => void }) {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const {
		data: status,
		isPending,
		refetch,
	} = useQuery({
		...variantStatusQueryOptions(resume.id),
		staleTime: 0,
	});
	const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
	const [choices, setChoices] = useState<Readonly<Record<string, Side>>>({});
	const [busy, setBusy] = useState(false);

	const updates = status?.updates ?? [];
	const conflicts = status?.conflicts ?? [];
	const taking = updates.filter((change) => !skipped.has(change.key)).length;
	const decided = conflicts.filter((change) => choices[change.key] !== undefined).length;
	const fromBase = conflicts.filter((change) => choices[change.key] === "base").length;
	const total = taking + fromBase;
	const ready = !!status?.base && !status.base.trashedAt && decided === conflicts.length;

	const decideAll = (side: Side) =>
		setChoices(Object.fromEntries(conflicts.map((change) => [change.key, side])) as Record<string, Side>);

	const apply = async () => {
		if (!status?.base) return;
		setBusy(true);
		try {
			if (!(await savePendingChanges(resume.id))) {
				throw new Error(t`Couldn't save your changes. Try again before continuing.`);
			}
			const decisions = [
				...[...skipped].map((key) => ({ key, take: "mine" as const })),
				...conflicts.map((change) => ({ key: change.key, take: choices[change.key] ?? ("mine" as const) })),
			];
			const updated = await orpc.resume.pullBaseUpdates.call({ id: resume.id, decisions });
			const next = { ...updated, applicationId: resume.applicationId ?? null, baseResumeId: status.base.id };
			useResumeStore.getState().replaceResumeFromServer(next as Resume);
			queryClient.setQueryData(orpc.resume.getById.queryKey({ input: { id: resume.id } }), next);
			void queryClient.invalidateQueries({ queryKey: orpc.resume.getVariantStatus.key() });
			void queryClient.invalidateQueries({ queryKey: variantUpdatesQueryOptions().queryKey });
			void queryClient.invalidateQueries({ queryKey: orpc.resume.listVersions.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.documents.key() });
			const baseName = status.base.name;
			toast.add({
				description:
					total === 0
						? t`Nothing taken. ${baseName} is now the reference for this variant.`
						: plural(total, {
								one: `Took # change from ${baseName}. The state before is saved in History.`,
								other: `Took # changes from ${baseName}. The state before is saved in History.`,
							}),
			});
			onDone();
		} catch (error) {
			if (error instanceof ORPCError && error.code === "VARIANT_CONFLICTS_UNDECIDED") {
				toast.add({ type: "info", description: t`The base changed again. Have a look at the new conflicts.` });
				setChoices({});
				void refetch();
			} else {
				toast.add({ type: "error", description: getResumeErrorMessage(error) });
			}
		}
		setBusy(false);
	};

	const base = status?.base;

	return (
		<>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-2">
					<Icon name="git-merge" size={22} className="shrink-0 text-ink-2" />
					{base ? <Trans>Updates from {base.name}</Trans> : <Trans>Updates from base</Trans>}
				</DialogTitle>
				<DialogDescription>
					{status?.syncedAt ? (
						<Trans>
							What changed in the base since {formatRelativeTime(status.syncedAt, i18n.locale)}. Your own edits to this
							variant stay as they are.
						</Trans>
					) : (
						<Trans>What changed in the base resume. Your own edits to this variant stay as they are.</Trans>
					)}
				</DialogDescription>
			</DialogHeader>

			{isPending && (
				<div className="grid gap-2" aria-busy="true">
					<Skeleton className="h-14 rounded-[10px]" />
					<Skeleton className="h-14 rounded-[10px]" />
				</div>
			)}

			{status && !base && (
				<p className="text-[13px] leading-[19px] text-ink-2">
					<Trans>This resume isn't linked to a base anymore. Its base was deleted, or it was unlinked.</Trans>
				</p>
			)}

			{base?.trashedAt && (
				<p className="flex gap-2 rounded-[10px] bg-warn-soft p-3 text-[13px] leading-[19px] text-warn-text">
					<Icon name="trash" size={18} className="shrink-0" />
					<Trans>{base.name} is in Trash. Restore it to see its changes, or unlink this variant.</Trans>
				</p>
			)}

			{base && !base.trashedAt && updates.length === 0 && conflicts.length === 0 && (
				<p role="status" className="flex gap-2 text-[13px] leading-[19px] text-ink-2">
					<Icon name="check-circle" size={20} className="shrink-0 text-accent-text" />
					<span>
						<Trans>Up to date. Nothing changed in {base.name} since this variant last took its changes.</Trans>{" "}
						<Link
							to="/builder/$resumeId"
							params={{ resumeId: base.id }}
							className="text-accent-text underline-offset-2 hover:underline"
						>
							<Trans>Open the base</Trans>
						</Link>
					</span>
				</p>
			)}

			{conflicts.length > 0 && (
				<section className="grid gap-2" aria-labelledby="base-conflicts-heading">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h3 id="base-conflicts-heading" className="flex items-center gap-2 text-sm font-semibold">
							<Icon name="warning-circle" size={18} className="text-warn-text" />
							<Plural value={conflicts.length} one="# conflict" other="# conflicts" />
							<span className="font-normal text-ink-3">
								· {decided}/{conflicts.length}
							</span>
						</h3>
						<span className="flex gap-1">
							<Button variant="ghost" size="sm" className="text-ink-2" onClick={() => decideAll("mine")}>
								<Trans>Keep all mine</Trans>
							</Button>
							<Button variant="ghost" size="sm" className="text-ink-2" onClick={() => decideAll("base")}>
								<Trans>Take all from base</Trans>
							</Button>
						</span>
					</div>
					<p className="text-[13px] leading-[19px] text-ink-2">
						<Trans>Both the base and this variant changed these. Pick which version to keep for each.</Trans>
					</p>
					<ul className="grid gap-2">
						{conflicts.map((change) => (
							<ConflictRow
								key={change.key}
								change={change}
								choice={choices[change.key]}
								onChoose={(side) => setChoices((previous) => ({ ...previous, [change.key]: side }))}
							/>
						))}
					</ul>
				</section>
			)}

			{updates.length > 0 && (
				<section className="grid gap-2" aria-labelledby="base-updates-heading">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h3 id="base-updates-heading" className="flex items-center gap-2 text-sm font-semibold">
							<Icon name="arrow-down" size={18} className="text-accent-text" />
							<Plural value={updates.length} one="# update" other="# updates" />
							<span className="font-normal text-ink-3">
								· {taking}/{updates.length}
							</span>
						</h3>
						<Button
							variant="ghost"
							size="sm"
							className="text-ink-2"
							onClick={() => setSkipped(taking === 0 ? new Set() : new Set(updates.map((change) => change.key)))}
						>
							{taking === 0 ? <Trans>Select all</Trans> : <Trans>Clear all</Trans>}
						</Button>
					</div>
					<ul className="grid gap-1.5">
						{updates.map((change) => (
							<UpdateRow
								key={change.key}
								change={change}
								checked={!skipped.has(change.key)}
								onCheckedChange={(checked) =>
									setSkipped((previous) => {
										const next = new Set(previous);
										if (checked) next.delete(change.key);
										else next.add(change.key);
										return next;
									})
								}
							/>
						))}
					</ul>
					<p className="text-xs leading-[17px] text-ink-3">
						<Trans>
							An update left unticked is kept as it is here, and isn't offered again unless the base changes it once
							more.
						</Trans>
					</p>
				</section>
			)}

			{base && !base.trashedAt && (updates.length > 0 || conflicts.length > 0) && (
				<DialogFooter>
					<Button variant="secondary" disabled={busy} onClick={onDone}>
						<Trans>Not now</Trans>
					</Button>
					<Button
						disabled={!ready || busy || resume.isLocked}
						loading={busy}
						title={resume.isLocked ? t`Unlock the resume first` : undefined}
						onClick={() => void apply()}
					>
						{total === 0 ? (
							<Trans>Keep mine for all</Trans>
						) : (
							<Plural value={total} one="Take # change" other="Take # changes" />
						)}
					</Button>
				</DialogFooter>
			)}
		</>
	);
}

type UpdateRowProps = { change: BaseChange; checked: boolean; onCheckedChange: (checked: boolean) => void };

/** One clean update: where, what the base did, and the value before and after. */
function UpdateRow({ change, checked, onCheckedChange }: UpdateRowProps) {
	return (
		<li>
			{/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- Base UI's Checkbox is the control; wrapping it in a label is its documented pattern. */}
			<label
				className={cn(
					"flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2.5 transition-colors duration-quick",
					checked ? "border-line bg-raised" : "border-transparent bg-sunken opacity-70",
				)}
			>
				<Checkbox
					checked={checked}
					aria-label={describeChangeLocation(change)}
					onCheckedChange={(next) => onCheckedChange(next)}
					className="mt-0.5"
				/>
				<span className="grid min-w-0 flex-1 gap-1">
					<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<span className="min-w-0 truncate text-[13px] font-semibold">{describeChangeLocation(change)}</span>
						<Badge variant={change.kind === "remove" ? "danger" : "accent"}>{describeChangeKind(change)}</Badge>
					</span>
					<ChangeValues change={change} />
				</span>
			</label>
		</li>
	);
}

type ConflictRowProps = { change: BaseChange; choice: Side | undefined; onChoose: (side: Side) => void };

/** One conflict: the two versions side by side, each a button that picks it. */
function ConflictRow({ change, choice, onChoose }: ConflictRowProps) {
	return (
		<li className="grid gap-2 rounded-[10px] border border-line p-3">
			<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<span className="min-w-0 truncate text-[13px] font-semibold">{describeChangeLocation(change)}</span>
				<Badge variant="warn">{describeConflict(change)}</Badge>
			</span>
			<div role="radiogroup" aria-label={describeChangeLocation(change)} className="grid gap-2 sm:grid-cols-2">
				<SideOption
					label={t`Keep mine`}
					value={sideValue(change, "mine")}
					selected={choice === "mine"}
					onSelect={() => onChoose("mine")}
				/>
				<SideOption
					label={t`Take base's`}
					value={sideValue(change, "base")}
					selected={choice === "base"}
					onSelect={() => onChoose("base")}
				/>
			</div>
		</li>
	);
}

/** How each side reads for a conflict: the value, or what keeping that side means for an entry. */
function sideValue(change: BaseChange, side: Side): string {
	if (change.conflict === "edited-here") {
		return side === "base" ? t`Removed` : previewValue(change.mine, change);
	}
	if (change.conflict === "removed-here") {
		return side === "base" ? previewValue(change.base, change) : t`Removed`;
	}
	return previewValue(side === "base" ? change.base : change.mine, change);
}

type SideOptionProps = { label: string; value: string; selected: boolean; onSelect: () => void };

function SideOption({ label, value, selected, onSelect }: SideOptionProps) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			onClick={onSelect}
			className={cn(
				"grid min-w-0 gap-1 rounded-[10px] border p-2.5 text-start transition-[background-color,border-color] duration-quick",
				selected ? "border-accent bg-accent-soft" : "border-line hover:bg-hover",
			)}
		>
			<span className={cn("text-xs font-semibold", selected ? "text-accent-text" : "text-ink-2")}>{label}</span>
			<span className="line-clamp-4 text-[13px] leading-[19px] break-words whitespace-pre-wrap">{value}</span>
		</button>
	);
}

/** "Was … → Now …" for edits; the entry's or value's preview for additions and removals. */
function ChangeValues({ change }: { change: BaseChange }) {
	if (change.kind === "reorder") return null;
	if (change.kind === "add") {
		return (
			<span className="line-clamp-3 text-[13px] leading-[19px] text-ink-2">{previewValue(change.base, change)}</span>
		);
	}
	if (change.kind === "remove") {
		return (
			<span className="line-clamp-3 text-[13px] leading-[19px] text-ink-2 line-through">
				{previewValue(change.mine ?? change.ancestor, change)}
			</span>
		);
	}
	return (
		<span className="grid gap-0.5 text-[13px] leading-[19px]">
			{change.mine !== undefined && (
				<span className="line-clamp-2 text-ink-3 line-through">{previewValue(change.mine, change)}</span>
			)}
			<span className="line-clamp-4 text-ink">{previewValue(change.base, change)}</span>
		</span>
	);
}
