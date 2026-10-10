import type { ReactNode } from "react";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DialogDescription, DialogHeader, DialogTitle } from "@reactive-resume/ui/components/dialog";
import { templates } from "@/dialogs/resume/template/data";
import { useCurrentResume } from "@/features/resume/builder/draft";
import { useEditorStore } from "@/features/resume/editor/store";
import { variantStatusQueryOptions } from "@/features/resume/variants/queries";
import { authClient } from "@/libs/auth/client";
import { formatRelativeTime, localeMap, resolveLocale } from "@/libs/locale";

type RowProps = { label: ReactNode; children: ReactNode };

function Row({ label, children }: RowProps) {
	return (
		<div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-4 border-t border-line py-2.5 first:border-t-0">
			<dt className="text-ink-3">{label}</dt>
			<dd className="min-w-0 break-words text-ink">{children}</dd>
		</div>
	);
}

/**
 * The document menu's Details: what this resume is, at a glance. When it was made and last edited, how it looks,
 * how long it runs, and whether anyone can see it.
 */
export function DocumentDetails() {
	const { i18n } = useLingui();
	const resume = useCurrentResume();
	const pageCount = useEditorStore((state) => state.rendered.pageCount);
	const { data: session } = authClient.useSession();
	const { data: links } = useQuery(variantStatusQueryOptions(resume.id));
	const { template, page } = resume.data.metadata;
	const address = `${window.location.host}/${session?.user.username ?? ""}/${resume.slug}`;
	const linkClassName = "text-accent-text underline-offset-2 hover:underline";

	return (
		<>
			<DialogHeader>
				<DialogTitle className="break-words">{resume.name}</DialogTitle>
				<DialogDescription>
					<Trans>Resume details</Trans>
				</DialogDescription>
			</DialogHeader>

			<dl className="text-sm leading-5">
				<Row label={<Trans>Created</Trans>}>
					<time dateTime={new Date(resume.createdAt).toISOString()}>
						{i18n.date(resume.createdAt, { dateStyle: "long" })}
					</time>
				</Row>
				<Row label={<Trans>Last edited</Trans>}>
					<time
						dateTime={new Date(resume.updatedAt).toISOString()}
						title={i18n.date(resume.updatedAt, { dateStyle: "long", timeStyle: "short" })}
					>
						{formatRelativeTime(resume.updatedAt, i18n.locale)}
					</time>
				</Row>
				<Row label={<Trans>Template</Trans>}>{templates[template].name}</Row>
				<Row label={<Trans>Language</Trans>}>{i18n._(localeMap[resolveLocale(page.locale)])}</Row>
				<Row label={<Trans>Length</Trans>}>
					{pageCount > 0 ? <Plural value={pageCount} one="# page" other="# pages" /> : "—"}
				</Row>
				{links?.base && (
					<Row label={<Trans>Variant of</Trans>}>
						<Link to="/builder/$resumeId" params={{ resumeId: links.base.id }} className={linkClassName}>
							{links.base.name}
						</Link>
						{links.base.trashedAt && (
							<span className="text-ink-3">
								{" "}
								<Trans>(in Trash)</Trans>
							</span>
						)}
					</Row>
				)}
				{links && links.variants.length > 0 && (
					<Row label={<Trans>Variants</Trans>}>
						<ul className="grid gap-0.5">
							{links.variants.map((variant) => (
								<li key={variant.id} className="truncate">
									<Link to="/builder/$resumeId" params={{ resumeId: variant.id }} className={linkClassName}>
										{variant.name}
									</Link>
								</li>
							))}
						</ul>
					</Row>
				)}
				<Row label={<Trans>Sharing</Trans>}>
					{resume.isPublic ? (
						<>
							{resume.hasPassword ? <Trans>Public, with a password</Trans> : <Trans>Public</Trans>}
							<a
								href={`${window.location.protocol}//${address}`}
								target="_blank"
								rel="noopener noreferrer"
								className="mt-0.5 block truncate font-mono text-[13px] text-accent-text underline-offset-2 hover:underline"
							>
								{address}
							</a>
						</>
					) : (
						<Trans>Private. Only you can see it.</Trans>
					)}
				</Row>
			</dl>
		</>
	);
}
