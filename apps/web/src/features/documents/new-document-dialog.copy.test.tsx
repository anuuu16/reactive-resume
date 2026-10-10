// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dialog } from "@reactive-resume/ui/components/dialog";
import { NewDocumentDialog } from "./new-document-dialog";

const mocks = vi.hoisted(() => ({ copy: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/libs/orpc/client", () => ({
	client: {},
	orpc: {
		key: () => ["orpc"],
		documents: {
			key: () => ["documents"],
			list: {
				queryKey: () => ["documents", "list"],
				queryOptions: () => ({
					queryKey: ["documents", "list"],
					queryFn: async () => [
						{ id: "main", type: "resume", name: "Main resume", tags: [], updatedAt: new Date(), isLocked: false },
					],
				}),
			},
			copyForJob: { mutationOptions: () => ({ mutationFn: mocks.copy }) },
		},
		applications: { key: () => ["applications"] },
		aiProviders: { list: { queryOptions: () => ({ queryKey: ["ai-providers"], queryFn: async () => [] }) } },
		resume: { create: { mutationOptions: () => ({ mutationFn: vi.fn() }) } },
		coverLetters: { create: { mutationOptions: () => ({ mutationFn: vi.fn() }) } },
	},
}));
vi.mock("@/features/applications/queries", () => ({
	applicationsListQueryOptions: () => ({ queryKey: ["applications"], queryFn: async () => [] }),
}));
vi.mock("@/features/settings/integrations/hooks/use-has-usable-ai-provider", () => ({
	useHasUsableAiProvider: () => ({ hasUsableProvider: false, isUnavailable: false }),
}));
vi.mock("@/features/settings/integrations/ai-provider-load-state", () => ({ AiProviderLoadState: () => null }));

beforeEach(() => {
	mocks.copy.mockReset().mockResolvedValue("copy");
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
});

function renderCopyStep() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<Dialog open>
					<NewDocumentDialog data={{ step: "copy", sourceResumeId: "main" }} />
				</Dialog>
			</QueryClientProvider>
		</I18nProvider>,
	);
}

it("makes a plain copy unless Keep linked is turned on", async () => {
	renderCopyStep();
	await screen.findByText("Main resume");

	const keepLinked = screen.getByRole("switch", { name: "Keep linked to the original as a variant" });
	expect(keepLinked).toHaveAttribute("aria-checked", "false");

	fireEvent.click(screen.getByRole("button", { name: "Create and open" }));
	await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1));
	expect(mocks.copy.mock.calls[0]?.[0]).toMatchObject({ resumeId: "main", linked: false });
});

it("makes a variant when Keep linked is turned on", async () => {
	renderCopyStep();
	await screen.findByText("Main resume");

	fireEvent.click(screen.getByRole("switch", { name: "Keep linked to the original as a variant" }));
	fireEvent.click(screen.getByRole("button", { name: "Create and open" }));

	await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1));
	expect(mocks.copy.mock.calls[0]?.[0]).toMatchObject({ resumeId: "main", linked: true });
});
