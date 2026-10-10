// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEditorStore } from "../editor/store";
import { BaseUpdatesDialog } from "./base-updates-dialog";

const mocks = vi.hoisted(() => ({
	save: vi.fn(),
	status: vi.fn(),
	pull: vi.fn(),
	replace: vi.fn(),
	toast: vi.fn(),
}));
vi.mock("@/features/resume/builder/draft", () => ({
	savePendingChanges: mocks.save,
	useCurrentResume: () => ({ id: "variant", isLocked: false, applicationId: null, baseResumeId: "base" }),
	useResumeStore: { getState: () => ({ replaceResumeFromServer: mocks.replace }) },
}));
vi.mock("@/libs/error-message", () => ({ getResumeErrorMessage: (error: Error) => error.message }));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: mocks.toast } }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		resume: {
			getVariantStatus: {
				key: () => ["variant-status"],
				queryOptions: ({ input }: { input: { id: string } }) => ({
					queryKey: ["variant-status", input.id],
					queryFn: mocks.status,
				}),
			},
			listVariantUpdates: {
				queryOptions: () => ({ queryKey: ["variant-updates"], queryFn: async () => [] }),
			},
			listVersions: { key: () => ["versions"] },
			getById: { queryKey: () => ["resume"] },
			pullBaseUpdates: { call: mocks.pull },
		},
		documents: { key: () => ["documents"] },
	},
}));

const experience = { scope: "section", section: { id: "experience", title: "" } } as const;

const status = () => ({
	base: { id: "base", name: "Main resume", trashedAt: null, updatedAt: new Date() },
	variants: [],
	syncedAt: new Date(),
	updates: [
		{
			key: "basics/name",
			kind: "edit",
			location: { scope: "basics", field: "name" },
			base: "Alex J. Morgan",
			mine: "Alex Morgan",
			ancestor: "Alex Morgan",
		},
		{
			key: "sections/experience/items/e3",
			kind: "add",
			location: { ...experience, item: { id: "e3", label: "Fieldnote · CTO" } },
			base: { id: "e3", company: "Fieldnote", position: "CTO" },
		},
	],
	conflicts: [
		{
			key: "summary/content",
			kind: "edit",
			location: { scope: "summary", field: "content" },
			base: "<p>Base summary</p>",
			mine: "<p>Tailored summary</p>",
			ancestor: "<p>Old summary</p>",
			conflict: "both-edited",
		},
	],
});

function renderDialog() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	useEditorStore.getState().setBaseUpdatesOpen(true);
	render(
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>
				<BaseUpdatesDialog />
			</I18nProvider>
		</QueryClientProvider>,
	);
	return client;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.save.mockResolvedValue(true);
	mocks.status.mockResolvedValue(status());
	mocks.pull.mockResolvedValue({ id: "variant", data: {}, updatedAt: new Date() });
	useEditorStore.getState().reset();
	i18n.load("en", {});
	i18n.activate("en");
});

describe("BaseUpdatesDialog", () => {
	it("lists the base's updates and conflicts, and waits for every conflict to be decided", async () => {
		renderDialog();

		expect(await screen.findByRole("heading", { name: "Updates from Main resume" })).toBeVisible();
		expect(screen.getByText("Basics · Name")).toBeVisible();
		expect(screen.getByText("Alex J. Morgan")).toBeVisible();
		expect(screen.getByText("Experience · Fieldnote · CTO")).toBeVisible();
		expect(screen.getByText("Summary · Content")).toBeVisible();
		expect(screen.getByText("Changed in both")).toBeVisible();

		const apply = screen.getByRole("button", { name: "Take 2 changes" });
		expect(apply).toBeDisabled();

		fireEvent.click(screen.getByRole("radio", { name: /Take base's/ }));
		expect(screen.getByRole("button", { name: "Take 3 changes" })).toBeEnabled();
	});

	it("sends what was left unticked and each conflict's side, then installs the result", async () => {
		const client = renderDialog();
		await screen.findByRole("heading", { name: "Updates from Main resume" });

		// The row is a label around the checkbox; clicking its text unticks it (as the checkbox itself would).
		fireEvent.click(screen.getByText("Basics · Name"));
		expect(screen.getByRole("checkbox", { name: /^Basics · Name/ })).toHaveAttribute("aria-checked", "false");
		fireEvent.click(screen.getByRole("radio", { name: /Keep mine/ }));
		fireEvent.click(screen.getByRole("button", { name: "Take 1 change" }));

		await waitFor(() => expect(mocks.pull).toHaveBeenCalled());
		expect(mocks.save).toHaveBeenCalledWith("variant");
		expect(mocks.pull).toHaveBeenCalledWith({
			id: "variant",
			decisions: [
				{ key: "basics/name", take: "mine" },
				{ key: "summary/content", take: "mine" },
			],
		});
		await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({ baseResumeId: "base" })));
		expect(mocks.toast).toHaveBeenCalledWith({
			description: "Took 1 change from Main resume. The state before is saved in History.",
		});
		expect(useEditorStore.getState().baseUpdatesOpen).toBe(false);
		client.clear();
	});

	it("stops when unsaved edits can't be saved first", async () => {
		mocks.save.mockResolvedValue(false);
		renderDialog();
		await screen.findByRole("heading", { name: "Updates from Main resume" });

		fireEvent.click(screen.getByRole("button", { name: "Take all from base" }));
		fireEvent.click(screen.getByRole("button", { name: "Take 3 changes" }));

		await waitFor(() =>
			expect(mocks.toast).toHaveBeenCalledWith({
				type: "error",
				description: "Couldn't save your changes. Try again before continuing.",
			}),
		);
		expect(mocks.pull).not.toHaveBeenCalled();
	});

	it("offers nothing while the base is in Trash, and says how to continue", async () => {
		mocks.status.mockResolvedValue({
			...status(),
			base: { id: "base", name: "Main resume", trashedAt: new Date(), updatedAt: new Date() },
			updates: [],
			conflicts: [],
		});
		renderDialog();

		expect(
			await screen.findByText("Main resume is in Trash. Restore it to see its changes, or unlink this variant."),
		).toBeVisible();
		expect(screen.queryByRole("button", { name: /Take/ })).toBeNull();
		expect(screen.queryByText(/Up to date/)).toBeNull();
	});

	it("explains when the base was deleted for good or the variant was unlinked", async () => {
		mocks.status.mockResolvedValue({ ...status(), base: null, syncedAt: null, updates: [], conflicts: [] });
		renderDialog();

		expect(await screen.findByText(/This resume isn't linked to a base anymore/)).toBeVisible();
		expect(screen.getByRole("heading", { name: "Updates from base" })).toBeVisible();
		expect(screen.queryByRole("button", { name: /Take/ })).toBeNull();
	});

	it("says so when the variant is up to date", async () => {
		mocks.status.mockResolvedValue({ ...status(), updates: [], conflicts: [] });
		renderDialog();

		expect(await screen.findByText(/Up to date/)).toBeVisible();
		expect(screen.queryByRole("button", { name: /Take/ })).toBeNull();
	});
});
