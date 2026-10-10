import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

// The DB layer is mocked; the merge itself is covered in @reactive-resume/resume/variants. What's under test is
// how the service reads the link, guards the pull, and what it writes back.

const dbMock = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), transaction: vi.fn() }));
const resumeServiceMock = vi.hoisted(() => ({ getById: vi.fn(), create: vi.fn() }));
const versionHistoryMock = vi.hoisted(() => ({ writeVersion: vi.fn() }));
const publishMock = vi.hoisted(() => vi.fn());

vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
vi.mock("@reactive-resume/db/schema", () => ({
	resume: {
		id: "id",
		userId: "user_id",
		name: "name",
		slug: "slug",
		tags: "tags",
		data: "data",
		isPublic: "is_public",
		isLocked: "is_locked",
		showDownloadButtons: "show_download_buttons",
		password: "password",
		trashedAt: "trashed_at",
		createdAt: "created_at",
		updatedAt: "updated_at",
		baseResumeId: "base_resume_id",
		baseSnapshot: "base_snapshot",
		baseSyncedAt: "base_synced_at",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: (...a: unknown[]) => a,
	eq: (...a: unknown[]) => a,
	inArray: (...a: unknown[]) => a,
	isNotNull: (...a: unknown[]) => a,
	isNull: (...a: unknown[]) => a,
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("./service", () => ({ resumeService: resumeServiceMock }));
vi.mock("./version-history", () => versionHistoryMock);
vi.mock("./events", () => ({ publishResumeUpdated: publishMock }));
vi.mock("../cover-letters/embedded", () => ({ adoptEmbeddedLetters: vi.fn(async () => undefined) }));

const { variantService } = await import("./variant-sync");

// `select().from().where()` resolving to `rows`, with `.for()` for a locked read.
const rows = (result: unknown[]) => ({
	from: () => ({ where: () => Object.assign(Promise.resolve(result), { for: async () => result }) }),
});

const createData = (): ResumeData => {
	const data = structuredClone(defaultResumeData);
	data.basics.name = "Alex Morgan";
	data.summary.content = "<p>Hello</p>";
	return data;
};

const baseRow = (data: ResumeData, trashedAt: Date | null = null) => ({
	id: "base",
	name: "Main resume",
	data,
	trashedAt,
	updatedAt: new Date("2026-10-01T00:00:00Z"),
});

const variantRow = (data: ResumeData, snapshot: ResumeData | null, extra: Record<string, unknown> = {}) => ({
	id: "variant",
	name: "Main resume — Lumen",
	data,
	isLocked: false,
	baseResumeId: "base",
	baseSnapshot: snapshot,
	baseSyncedAt: new Date("2026-09-01T00:00:00Z"),
	...extra,
});

beforeEach(() => {
	for (const mock of [
		...Object.values(dbMock),
		...Object.values(resumeServiceMock),
		...Object.values(versionHistoryMock),
	])
		mock.mockReset();
	publishMock.mockReset();
	publishMock.mockResolvedValue(undefined);
});

describe("create", () => {
	it("starts the variant from the base's data, in the base's language, linked with the base as the snapshot", async () => {
		const data = createData();
		data.metadata.page.locale = "de-DE";
		resumeServiceMock.getById.mockResolvedValueOnce({ id: "base", name: "Main resume", tags: ["main"], data });
		resumeServiceMock.create.mockResolvedValueOnce("variant");

		const id = await variantService.create({ userId: "u1", baseId: "base", locale: "en-US" });

		expect(id).toBe("variant");
		expect(resumeServiceMock.create).toHaveBeenCalledWith({
			userId: "u1",
			name: "Main resume (variant)",
			tags: ["main"],
			locale: "de-DE",
			data,
			base: { id: "base", data },
		});
	});

	it("takes the name, slug and tags given", async () => {
		resumeServiceMock.getById.mockResolvedValueOnce({ id: "base", name: "Main", tags: [], data: createData() });
		resumeServiceMock.create.mockResolvedValueOnce("variant");

		await variantService.create({
			userId: "u1",
			baseId: "base",
			name: "Lumen",
			slug: "lumen",
			tags: ["x"],
			locale: "en-US",
		});

		expect(resumeServiceMock.create).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Lumen", slug: "lumen", tags: ["x"] }),
		);
	});
});

describe("status", () => {
	it("reports the base's changes against the snapshot, keeping the variant's own edits out of them", async () => {
		const ancestor = createData();
		const mine = createData();
		mine.summary.content = "<p>Tailored</p>";
		const base = createData();
		base.basics.name = "Alex J. Morgan";

		dbMock.select
			.mockReturnValueOnce(rows([variantRow(mine, ancestor)]))
			.mockReturnValueOnce(rows([]))
			.mockReturnValueOnce(rows([baseRow(base)]));

		const status = await variantService.status({ id: "variant", userId: "u1" });

		expect(status.base).toEqual({
			id: "base",
			name: "Main resume",
			trashedAt: null,
			updatedAt: new Date("2026-10-01T00:00:00Z"),
		});
		expect(status.syncedAt).toEqual(new Date("2026-09-01T00:00:00Z"));
		expect(status.updates.map((change) => change.key)).toEqual(["basics/name"]);
		expect(status.conflicts).toEqual([]);
	});

	it("offers nothing while the base is in Trash, and lists a resume's own variants", async () => {
		const base = createData();
		base.basics.name = "Changed";
		dbMock.select
			.mockReturnValueOnce(rows([variantRow(createData(), createData())]))
			.mockReturnValueOnce(rows([{ id: "v2", name: "Another", updatedAt: new Date(0) }]))
			.mockReturnValueOnce(rows([baseRow(base, new Date())]));

		const status = await variantService.status({ id: "variant", userId: "u1" });

		expect(status.base?.trashedAt).toBeInstanceOf(Date);
		expect(status.updates).toEqual([]);
		expect(status.variants).toEqual([{ id: "v2", name: "Another", updatedAt: new Date(0) }]);
	});

	it("offers the changes made before the base went to Trash again once it's restored", async () => {
		const base = createData();
		base.basics.name = "Changed";
		dbMock.select
			.mockReturnValueOnce(rows([variantRow(createData(), createData())]))
			.mockReturnValueOnce(rows([]))
			.mockReturnValueOnce(rows([baseRow(base, new Date())]))
			.mockReturnValueOnce(rows([variantRow(createData(), createData())]))
			.mockReturnValueOnce(rows([]))
			.mockReturnValueOnce(rows([baseRow(base, null)]));

		const trashed = await variantService.status({ id: "variant", userId: "u1" });
		expect(trashed.updates).toEqual([]);
		const restored = await variantService.status({ id: "variant", userId: "u1" });
		expect(restored.base?.trashedAt).toBeNull();
		expect(restored.updates.map((change) => change.key)).toEqual(["basics/name"]);
	});

	it("is a plain resume when there is no base: the link was cleared when the base was deleted for good", async () => {
		dbMock.select
			.mockReturnValueOnce(rows([variantRow(createData(), null, { baseResumeId: null })]))
			.mockReturnValueOnce(rows([]));

		await expect(variantService.status({ id: "variant", userId: "u1" })).resolves.toEqual({
			base: null,
			variants: [],
			syncedAt: null,
			updates: [],
			conflicts: [],
		});
	});

	it("throws NOT_FOUND for someone else's resume", async () => {
		dbMock.select.mockReturnValueOnce(rows([]));
		await expect(variantService.status({ id: "variant", userId: "u1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("pull", () => {
	type Tx = { select: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

	const transaction = (variant: unknown[], base: unknown[]) => {
		const set = vi.fn((_changes: Record<string, unknown>) => ({
			where: () => ({
				returning: async () => [
					{
						id: "variant",
						name: "Main resume — Lumen",
						slug: "lumen",
						tags: [],
						data: set.mock.calls.at(-1)?.[0]?.data,
						isPublic: false,
						isLocked: false,
						showDownloadButtons: true,
						createdAt: new Date(0),
						updatedAt: new Date(1),
						hasPassword: false,
					},
				],
			}),
		}));
		const tx: Tx = {
			select: vi.fn().mockReturnValueOnce(rows(variant)).mockReturnValueOnce(rows(base)),
			update: vi.fn(() => ({ set })),
		};
		dbMock.transaction.mockImplementation(async (callback: (tx: Tx) => Promise<unknown>) => callback(tx));
		return { tx, set };
	};

	it("takes the updates, keeps the variant's edits, decides conflicts as told, and moves the snapshot on", async () => {
		const ancestor = createData();
		const mine = createData();
		mine.summary.content = "<p>Tailored</p>";
		mine.basics.headline = "Mine";
		const base = createData();
		base.basics.name = "Alex J. Morgan";
		base.basics.headline = "Base";
		base.summary.content = "<p>Base summary</p>";
		const { set } = transaction([variantRow(mine, ancestor)], [baseRow(base)]);

		const updated = await variantService.pull({
			id: "variant",
			userId: "u1",
			decisions: [
				{ key: "basics/headline", take: "mine" },
				{ key: "summary/content", take: "base" },
			],
		});

		const written = set.mock.calls[0]?.[0] as { data: ResumeData; baseSnapshot: ResumeData; baseSyncedAt: Date };
		expect(written.data.basics).toMatchObject({ name: "Alex J. Morgan", headline: "Mine" });
		expect(written.data.summary.content).toBe("<p>Base summary</p>");
		expect(written.baseSnapshot).toBe(base);
		expect(written.baseSyncedAt).toBeInstanceOf(Date);
		expect(versionHistoryMock.writeVersion).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ resumeId: "variant", userId: "u1", kind: "base-update" }),
		);
		expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({ resumeId: "variant", mutation: "update" }));
		expect(updated.data.basics.name).toBe("Alex J. Morgan");
	});

	it("refuses to pull while a conflict is undecided, naming it", async () => {
		const mine = createData();
		mine.summary.content = "<p>Tailored</p>";
		const base = createData();
		base.summary.content = "<p>Base summary</p>";
		const { set } = transaction([variantRow(mine, createData())], [baseRow(base)]);

		await expect(variantService.pull({ id: "variant", userId: "u1", decisions: [] })).rejects.toMatchObject({
			code: "VARIANT_CONFLICTS_UNDECIDED",
			status: 409,
			data: { keys: ["summary/content"] },
		});
		expect(set).not.toHaveBeenCalled();
		expect(versionHistoryMock.writeVersion).not.toHaveBeenCalled();
	});

	it("doesn't save a version when there was nothing to take", async () => {
		const { set } = transaction([variantRow(createData(), createData())], [baseRow(createData())]);

		await variantService.pull({ id: "variant", userId: "u1", decisions: [] });

		expect(set).toHaveBeenCalledTimes(1);
		expect(versionHistoryMock.writeVersion).not.toHaveBeenCalled();
	});

	it.each([
		{
			variant: variantRow(createData(), createData(), { isLocked: true }),
			base: [baseRow(createData())],
			code: "RESUME_LOCKED",
		},
		{ variant: variantRow(createData(), createData(), { baseResumeId: null }), base: [], code: "RESUME_NOT_A_VARIANT" },
		{ variant: variantRow(createData(), createData()), base: [], code: "RESUME_NOT_A_VARIANT" },
		{
			variant: variantRow(createData(), createData()),
			base: [baseRow(createData(), new Date())],
			code: "BASE_RESUME_IN_TRASH",
		},
	])("refuses with $code", async ({ variant, base, code }) => {
		const { set } = transaction([variant], base);
		await expect(variantService.pull({ id: "variant", userId: "u1", decisions: [] })).rejects.toMatchObject({ code });
		expect(set).not.toHaveBeenCalled();
	});
});

describe("detach", () => {
	it("clears the link and the snapshot, and fails for a resume that isn't a variant", async () => {
		const set = vi.fn(() => ({ where: () => ({ returning: async () => [{ id: "variant" }] }) }));
		dbMock.update.mockReturnValue({ set });

		await variantService.detach({ id: "variant", userId: "u1" });
		expect(set).toHaveBeenCalledWith({ baseResumeId: null, baseSnapshot: null, baseSyncedAt: null });

		dbMock.update.mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [] }) }) });
		await expect(variantService.detach({ id: "plain", userId: "u1" })).rejects.toMatchObject({
			code: "RESUME_NOT_A_VARIANT",
		});
	});
});

describe("listUpdates", () => {
	it("counts pending changes per stale variant and leaves out those with nothing to take", async () => {
		const ancestor = createData();
		const base = createData();
		base.basics.name = "Changed";
		base.basics.headline = "Also changed";
		const conflicting = createData();
		conflicting.basics.headline = "Mine";

		dbMock.select
			.mockReturnValueOnce(
				rows([
					{ id: "v1", data: createData(), baseResumeId: "base", baseSnapshot: ancestor },
					{ id: "v2", data: conflicting, baseResumeId: "base", baseSnapshot: ancestor },
					{ id: "v3", data: createData(), baseResumeId: "base", baseSnapshot: base },
					{ id: "v4", data: createData(), baseResumeId: "gone", baseSnapshot: ancestor },
				]),
			)
			.mockReturnValueOnce(rows([{ id: "base", data: base }]));

		await expect(variantService.listUpdates({ userId: "u1" })).resolves.toEqual([
			{ id: "v1", baseId: "base", updates: 2, conflicts: 0 },
			{ id: "v2", baseId: "base", updates: 1, conflicts: 1 },
		]);
	});

	it("skips the base lookup when no variant is stale", async () => {
		dbMock.select.mockReturnValueOnce(rows([]));
		await expect(variantService.listUpdates({ userId: "u1" })).resolves.toEqual([]);
		expect(dbMock.select).toHaveBeenCalledTimes(1);
	});
});
