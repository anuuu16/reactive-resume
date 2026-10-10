// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEditorStore } from "../editor/store";
import { VariantIndicator } from "./variant-indicator";

type Resume = { id: string; baseResumeId: string | null };

const mocks = vi.hoisted(() => ({
	status: vi.fn(),
	resume: { id: "variant", baseResumeId: "base" } as { id: string; baseResumeId: string | null },
}));
vi.mock("@/features/resume/builder/draft", () => ({
	useCurrentBuilderResumeSelector: (select: (resume: Resume) => unknown) => select(mocks.resume),
	usePatchResume: () => (change: (draft: Resume) => void) => change(mocks.resume),
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		resume: {
			getVariantStatus: {
				queryOptions: ({ input }: { input: { id: string } }) => ({
					queryKey: ["variant-status", input.id],
					queryFn: mocks.status,
				}),
			},
			getById: { queryKey: ({ input }: { input: { id: string } }) => ["resume", input.id] },
		},
	},
}));

const status = (base: { trashedAt: Date | null } | null, pending = { updates: 0, conflicts: 0 }) => ({
	base: base && { id: "base", name: "Main resume", trashedAt: base.trashedAt, updatedAt: new Date() },
	variants: [],
	syncedAt: new Date(),
	updates: Array.from({ length: pending.updates }, (_, index) => ({ key: `u${index}` })),
	conflicts: Array.from({ length: pending.conflicts }, (_, index) => ({ key: `c${index}` })),
});

function renderIndicator() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["resume", "variant"], { id: "variant", baseResumeId: "base" });
	render(
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>
				<VariantIndicator />
			</I18nProvider>
		</QueryClientProvider>,
	);
	return client;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resume = { id: "variant", baseResumeId: "base" };
	useEditorStore.getState().reset();
	i18n.load("en", {});
	i18n.activate("en");
});

describe("VariantIndicator", () => {
	it("names the base while it's live and up to date", async () => {
		mocks.status.mockResolvedValue(status({ trashedAt: null }));
		renderIndicator();

		expect(await screen.findByRole("button", { name: "Variant of Main resume" })).toBeVisible();
	});

	it("counts the base's changes and opens the review", async () => {
		mocks.status.mockResolvedValue(status({ trashedAt: null }, { updates: 2, conflicts: 1 }));
		renderIndicator();

		const button = await screen.findByRole("button", { name: "3 updates from base · 1 conflict" });
		fireEvent.click(button);
		expect(useEditorStore.getState().baseUpdatesOpen).toBe(true);
	});

	it("says the base is in Trash, and offers no updates meanwhile", async () => {
		mocks.status.mockResolvedValue(status({ trashedAt: new Date() }));
		renderIndicator();

		const button = await screen.findByRole("button", { name: "Variant of Main resume (in Trash)" });
		expect(button).toHaveAttribute("title", "Main resume is in Trash. Restore it to see its changes.");
	});

	it("disappears, and unlinks the open editor, once the base was deleted for good", async () => {
		mocks.status.mockResolvedValue(status(null));
		const client = renderIndicator();

		await waitFor(() => expect(mocks.resume.baseResumeId).toBeNull());
		expect(client.getQueryData(["resume", "variant"])).toEqual({ id: "variant", baseResumeId: null });
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows nothing for a resume that isn't a variant, without asking the server", () => {
		mocks.resume = { id: "plain", baseResumeId: null };
		renderIndicator();

		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(mocks.status).not.toHaveBeenCalled();
	});
});
