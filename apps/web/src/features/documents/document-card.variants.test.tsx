// @vitest-environment happy-dom

import type { DocumentSummary } from "./filter";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentCard } from "./document-card";

const { loadUpdates } = vi.hoisted(() => ({ loadUpdates: vi.fn() }));

vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		resume: { listVariantUpdates: { queryOptions: () => ({ queryKey: ["variant-updates"], queryFn: loadUpdates }) } },
	},
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, search }: { children: ReactNode; search?: Record<string, string> }) => (
		<a href={search?.variant ? `/builder?variant=${search.variant}` : "/builder"}>{children}</a>
	),
	useNavigate: () => vi.fn(),
}));
vi.mock("./document-actions", () => ({ DocumentMenuContent: () => null, useDocumentActions: () => ({}) }));
vi.mock("./resume-thumbnail", () => ({ ResumeThumbnail: () => null }));

const document = (partial: Partial<DocumentSummary>): DocumentSummary => ({
	type: "resume",
	id: "variant",
	name: "Main resume — Lumen",
	tags: [],
	isLocked: false,
	trashedAt: null,
	createdAt: new Date(),
	updatedAt: new Date(),
	application: null,
	base: { id: "base", name: "Main resume", trashedAt: null },
	variants: 0,
	...partial,
});

function renderCard(summary: DocumentSummary) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<DocumentCard document={summary} onTags={vi.fn()} onLink={vi.fn()} />
			</QueryClientProvider>
		</I18nProvider>,
	);
}

beforeEach(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	loadUpdates.mockReset().mockResolvedValue([]);
});

it("names a variant's base, and how many variants a base has", async () => {
	const variant = renderCard(document({}));
	expect(await screen.findByText("Variant of Main resume")).toBeVisible();
	variant.unmount();

	renderCard(document({ id: "base", name: "Main resume", base: null, variants: 3 }));
	expect(screen.getByText("3 variants")).toBeVisible();
});

it("turns into a link to the review when the base changed", async () => {
	loadUpdates.mockResolvedValue([{ id: "variant", baseId: "base", updates: 2, conflicts: 1 }]);
	renderCard(document({}));

	const link = await screen.findByRole("link", { name: /3 updates from base/ });
	expect(link).toHaveAttribute("href", "/builder?variant=updates");
	expect(screen.queryByText("Variant of Main resume")).not.toBeInTheDocument();
});

it("shows no link once the base was deleted for good or the variant was unlinked", () => {
	renderCard(document({ base: null, variants: 0 }));
	expect(screen.queryByText(/Variant of/)).not.toBeInTheDocument();
	expect(screen.queryByText(/from base/)).not.toBeInTheDocument();
	expect(loadUpdates).not.toHaveBeenCalled();
});

it("says when the base is in Trash", async () => {
	renderCard(document({ base: { id: "base", name: "Main resume", trashedAt: new Date() } }));
	expect(await screen.findByText(/Variant of Main resume/)).toHaveTextContent("(in Trash)");
});
