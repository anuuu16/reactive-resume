import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sampleResumeData } from "@reactive-resume/schema/resume/sample";

const fixture = vi.hoisted(() => ({
	db: undefined as ReturnType<typeof drizzle> | undefined,
	pool: undefined as Pool | undefined,
}));
vi.mock("@reactive-resume/db/client", () => ({
	get db() {
		return fixture.db;
	},
}));
vi.mock("./events", () => ({ publishResumeUpdated: vi.fn(async () => undefined) }));
vi.mock("../storage/service", () => ({ getStorageService: () => ({ delete: vi.fn(async () => undefined) }) }));

function getPool(): Pool {
	if (!fixture.pool) throw new Error("Test database is not initialized");
	return fixture.pool;
}

type Services = {
	resumeService: typeof import("./service").resumeService;
	variantService: typeof import("./variant-sync").variantService;
	documentsService: typeof import("../documents/service").documentsService;
};

// Opt-in real PostgreSQL tests: the whole schema, from the migrations, in a disposable schema.
describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("resume variants against PostgreSQL", () => {
	const schemaName = `resume_variants_test_${randomUUID().replaceAll("-", "")}`;
	let admin: Pool;
	let services: Services;

	beforeAll(async () => {
		admin = new Pool({ connectionString: process.env.COVER_LETTER_TEST_DATABASE_URL });
		await admin.query(`CREATE SCHEMA ${schemaName}`);
		fixture.pool = new Pool({
			connectionString: process.env.COVER_LETTER_TEST_DATABASE_URL,
			options: `-c search_path=${schemaName}`,
		});
		fixture.db = drizzle({ client: fixture.pool });
		const migrations = new URL("../../../../../migrations/", import.meta.url);
		for (const name of (await readdir(migrations)).sort()) {
			const sql = await readFile(new URL(`${name}/migration.sql`, migrations), "utf8");
			for (const statement of sql.split("--> statement-breakpoint")) {
				const trimmed = statement.trim();
				if (trimmed) await fixture.pool.query(trimmed.replaceAll('"public".', ""));
			}
		}
		services = {
			resumeService: (await import("./service")).resumeService,
			variantService: (await import("./variant-sync")).variantService,
			documentsService: (await import("../documents/service")).documentsService,
		};
	});
	afterAll(async () => {
		await fixture.pool?.end();
		await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
		await admin?.end();
	});
	beforeEach(async () => {
		await getPool().query('TRUNCATE "user" CASCADE');
		await getPool().query(
			`INSERT INTO "user" (id,name,email,username,display_username) VALUES ('alice','Alice','alice@example.test','alice','alice')`,
		);
	});

	const user = { userId: "alice", locale: "en-US" as const };
	const createBase = () =>
		services.resumeService.create({ ...user, name: "Main resume", tags: ["main"], data: sampleResumeData });
	const read = (id: string) => services.resumeService.getById({ id, userId: "alice" });
	const edit = async (id: string, change: (data: ResumeData) => void) => {
		const current = await read(id);
		const data = structuredClone(current.data);
		change(data);
		await services.resumeService.update({ id, userId: "alice", data });
	};

	it("links a variant to its base, shows the base's changes, and takes them in around the variant's own edits", async () => {
		const baseId = await createBase();
		const variantId = await services.variantService.create({ ...user, baseId });

		const variant = await read(variantId);
		expect(variant).toMatchObject({ name: "Main resume (variant)", tags: ["main"], baseResumeId: baseId });
		expect(variant.data).toEqual((await read(baseId)).data);
		expect(await services.variantService.status({ id: variantId, userId: "alice" })).toMatchObject({
			base: { id: baseId, name: "Main resume", trashedAt: null },
			updates: [],
			conflicts: [],
		});
		expect(await services.variantService.status({ id: baseId, userId: "alice" })).toMatchObject({
			base: null,
			variants: [{ id: variantId, name: "Main resume (variant)" }],
		});

		// The variant is tailored; the base gets a fix, a new job and a reworded summary.
		const hiddenId = variant.data.sections.experience.items[0]?.id as string;
		await edit(variantId, (data) => {
			data.summary.content = "<p>Tailored for Lumen</p>";
			const hidden = data.sections.experience.items.find((item) => item.id === hiddenId);
			if (hidden) hidden.hidden = true;
		});
		await edit(baseId, (data) => {
			data.basics.name = "David J. Kowalski";
			data.summary.content = "<p>Reworded in the base</p>";
			const job = data.sections.experience.items.find((item) => item.id === hiddenId);
			if (job) job.position = "Principal Game Developer";
			data.sections.experience.items.push({
				...structuredClone(data.sections.experience.items[0] as ResumeData["sections"]["experience"]["items"][number]),
				id: "new-job",
				company: "Fieldnote",
				position: "CTO",
			});
		});

		const status = await services.variantService.status({ id: variantId, userId: "alice" });
		expect(status.updates.map((change) => [change.key, change.kind])).toEqual([
			["basics/name", "edit"],
			[`sections/experience/items/${hiddenId}/position`, "edit"],
			["sections/experience/items/new-job", "add"],
		]);
		expect(status.conflicts).toEqual([
			expect.objectContaining({ key: "summary/content", conflict: "both-edited", mine: "<p>Tailored for Lumen</p>" }),
		]);
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([
			{ id: variantId, baseId, updates: 3, conflicts: 1 },
		]);
		const documents = await services.documentsService.list({ userId: "alice", trashed: false });
		expect(documents.find((document) => document.id === variantId)).toMatchObject({
			base: { id: baseId, name: "Main resume", trashedAt: null },
			variants: 0,
		});
		expect(documents.find((document) => document.id === baseId)).toMatchObject({ base: null, variants: 1 });

		await expect(services.variantService.pull({ id: variantId, userId: "alice", decisions: [] })).rejects.toMatchObject(
			{ code: "VARIANT_CONFLICTS_UNDECIDED", data: { keys: ["summary/content"] } },
		);

		const pulled = await services.variantService.pull({
			id: variantId,
			userId: "alice",
			decisions: [
				{ key: "summary/content", take: "mine" },
				{ key: "sections/experience/items/new-job", take: "mine" },
			],
		});
		expect(pulled.data.basics.name).toBe("David J. Kowalski");
		expect(pulled.data.summary.content).toBe("<p>Tailored for Lumen</p>");
		expect(pulled.data.sections.experience.items.find((item) => item.id === hiddenId)).toMatchObject({
			hidden: true,
			position: "Principal Game Developer",
		});
		expect(pulled.data.sections.experience.items.some((item) => item.id === "new-job")).toBe(false);

		// Reconciled: nothing pending, the skipped entry isn't offered again, and the pull is a version.
		expect(await services.variantService.status({ id: variantId, userId: "alice" })).toMatchObject({
			updates: [],
			conflicts: [],
		});
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([]);
		const versions = await services.resumeService.versions.list({ resumeId: variantId, userId: "alice" });
		expect(versions.map((version) => version.kind)).toContain("base-update");

		// The base changing the skipped entry again offers it again.
		await edit(baseId, (data) => {
			const job = data.sections.experience.items.find((item) => item.id === "new-job");
			if (job) job.location = "Lisbon";
		});
		expect((await services.variantService.status({ id: variantId, userId: "alice" })).conflicts).toEqual([
			expect.objectContaining({ key: "sections/experience/items/new-job", kind: "edit", conflict: "removed-here" }),
		]);
	});

	it("waits while the base is in Trash, carries on once it's restored, and frees the variant when it's deleted", async () => {
		const baseId = await createBase();
		const variantId = await services.variantService.create({ ...user, baseId, name: "Lumen" });
		await edit(baseId, (data) => {
			data.basics.headline = "Changed";
		});
		const listVariant = async (trashed = false) =>
			(await services.documentsService.list({ userId: "alice", trashed })).find(
				(document) => document.id === variantId,
			);

		// In Trash: the link shows, nothing is offered, and the library doesn't count it as stale.
		await services.documentsService.trash({ userId: "alice", type: "resume", id: baseId });
		expect(await services.variantService.status({ id: variantId, userId: "alice" })).toMatchObject({
			base: expect.objectContaining({ id: baseId, trashedAt: expect.any(Date) }),
			updates: [],
			conflicts: [],
		});
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([]);
		expect(await listVariant()).toMatchObject({
			base: { id: baseId, name: "Main resume", trashedAt: expect.any(Date) },
		});
		await expect(services.variantService.pull({ id: variantId, userId: "alice", decisions: [] })).rejects.toMatchObject(
			{ code: "BASE_RESUME_IN_TRASH" },
		);

		// Restored: the change made before is offered as if nothing happened, and can be taken.
		await services.documentsService.restore({ userId: "alice", type: "resume", id: baseId });
		expect(await services.variantService.status({ id: variantId, userId: "alice" })).toMatchObject({
			base: expect.objectContaining({ id: baseId, trashedAt: null }),
			updates: [expect.objectContaining({ key: "basics/headline", base: "Changed" })],
		});
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([
			{ id: variantId, baseId, updates: 1, conflicts: 0 },
		]);
		expect(await listVariant()).toMatchObject({ base: { id: baseId, name: "Main resume", trashedAt: null } });
		const pulled = await services.variantService.pull({ id: variantId, userId: "alice", decisions: [] });
		expect(pulled.data.basics.headline).toBe("Changed");

		// Deleted for good: the variant is a resume of its own, with everything it had.
		await services.documentsService.trash({ userId: "alice", type: "resume", id: baseId });
		await services.documentsService.purge({ userId: "alice", type: "resume", id: baseId });
		expect(await read(variantId)).toMatchObject({ baseResumeId: null, name: "Lumen" });
		expect((await read(variantId)).data.basics.headline).toBe("Changed");
		const [row] = (await getPool().query("SELECT base_snapshot, base_synced_at FROM resume WHERE id=$1", [variantId]))
			.rows as { base_snapshot: unknown; base_synced_at: unknown }[];
		expect(row).toEqual({ base_snapshot: null, base_synced_at: null });
		expect(await services.variantService.status({ id: variantId, userId: "alice" })).toEqual({
			base: null,
			variants: [],
			syncedAt: null,
			updates: [],
			conflicts: [],
		});
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([]);
		expect(await listVariant()).toMatchObject({ base: null, variants: 0 });
		await expect(services.variantService.pull({ id: variantId, userId: "alice", decisions: [] })).rejects.toMatchObject(
			{ code: "RESUME_NOT_A_VARIANT" },
		);
	});

	it("keeps a variant's own Trash trip separate from its base's", async () => {
		const baseId = await createBase();
		const variantId = await services.variantService.create({ ...user, baseId, name: "Lumen" });
		await edit(baseId, (data) => {
			data.basics.headline = "Changed";
		});

		// A variant in Trash isn't counted as stale, but keeps its link for when it comes back.
		await services.documentsService.trash({ userId: "alice", type: "resume", id: variantId });
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([]);
		expect(await services.variantService.status({ id: baseId, userId: "alice" })).toMatchObject({ variants: [] });
		expect(
			(await services.documentsService.list({ userId: "alice", trashed: true })).find(
				(document) => document.id === variantId,
			),
		).toMatchObject({ base: { id: baseId, name: "Main resume", trashedAt: null } });

		await services.documentsService.restore({ userId: "alice", type: "resume", id: variantId });
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([
			{ id: variantId, baseId, updates: 1, conflicts: 0 },
		]);
		expect(await services.variantService.status({ id: baseId, userId: "alice" })).toMatchObject({
			variants: [expect.objectContaining({ id: variantId })],
		});
	});

	it("unlinks on request, and keeps a linked copy for a job in step with its source", async () => {
		const baseId = await createBase();
		const copyId = await services.documentsService.copyForJob({ userId: "alice", resumeId: baseId, linked: true });
		expect(await read(copyId)).toMatchObject({ name: "Main resume (copy)", baseResumeId: baseId });

		await edit(baseId, (data) => {
			data.basics.phone = "+1 (555) 000-0000";
		});
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([
			{ id: copyId, baseId, updates: 1, conflicts: 0 },
		]);

		await services.variantService.detach({ id: copyId, userId: "alice" });
		expect(await read(copyId)).toMatchObject({ baseResumeId: null });
		expect(await services.variantService.listUpdates({ userId: "alice" })).toEqual([]);
		await expect(services.variantService.detach({ id: copyId, userId: "alice" })).rejects.toMatchObject({
			code: "RESUME_NOT_A_VARIANT",
		});
		await expect(services.variantService.create({ ...user, baseId, slug: "taken", name: "A" })).resolves.toEqual(
			expect.any(String),
		);
		await expect(services.variantService.create({ ...user, baseId, slug: "taken", name: "B" })).rejects.toMatchObject({
			code: "RESUME_SLUG_ALREADY_EXISTS",
		});
	});

	it("keeps resumes private to their owner", async () => {
		await getPool().query(
			`INSERT INTO "user" (id,name,email,username,display_username) VALUES ('bob','Bob','bob@example.test','bob','bob')`,
		);
		const baseId = await createBase();
		await expect(services.variantService.create({ userId: "bob", locale: "en-US", baseId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(services.variantService.status({ id: baseId, userId: "bob" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});
