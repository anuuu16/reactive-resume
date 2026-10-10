import type { RouterOutput } from "@/libs/orpc/client";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/libs/orpc/client";

type VariantStatus = RouterOutput["resume"]["getVariantStatus"];
export type BaseChange = VariantStatus["updates"][number];
export type VariantUpdateCounts = RouterOutput["resume"]["listVariantUpdates"][number];

/** The base a resume is a variant of, its own variants, and the base's changes waiting to be taken. */
export const variantStatusQueryOptions = (id: string) => orpc.resume.getVariantStatus.queryOptions({ input: { id } });

/** For the library: how many changes each variant can take from its base. */
export const variantUpdatesQueryOptions = () => orpc.resume.listVariantUpdates.queryOptions();

/** Everything that's pending for a variant, as the "N updates from base" count. */
const countPending = (counts: Pick<VariantUpdateCounts, "updates" | "conflicts"> | undefined) =>
	counts ? counts.updates + counts.conflicts : 0;

/** The "N updates from base" count for one variant in the library; one request serves every card. */
export function useVariantUpdateCount(id: string, enabled: boolean) {
	const { data } = useQuery({ ...variantUpdatesQueryOptions(), enabled, refetchOnWindowFocus: true });
	return countPending(data?.find((entry) => entry.id === id));
}
