import { beforeEach, expect, it, vi } from "vitest";
import { call } from "@orpc/server";
import { unzipSync, strFromU8 } from "fflate";
import { copyCoverLetterStyle } from "@reactive-resume/resume/cover-letter";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const getResume = vi.hoisted(() => vi.fn());
const getLetter = vi.hoisted(() => vi.fn());
const exportLetter = vi.hoisted(() => vi.fn());
const readServerImage = vi.hoisted(() => vi.fn());
vi.mock("../resume/service", () => ({ resumeService: { getById: getResume } }));
vi.mock("../cover-letters/service", () => ({ coverLetterService: { getById: getLetter, export: exportLetter } }));
vi.mock("@reactive-resume/pdf/server", () => ({ readServerImage }));
vi.mock("@reactive-resume/auth/config", () => ({
	auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "owner" } }) } },
	verifyOAuthToken: vi.fn(),
}));
vi.mock("@reactive-resume/db/client", () => ({
	db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "owner", banned: false }] }) }) }) },
}));
const { documentExports } = await import("./exports");
const context = { locale: "en-US" as const, reqHeaders: new Headers() };

/** The first bytes of a PNG: signature, then the IHDR chunk with a 2×1 size. */
const png = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 1,
]);

const odtContent = async (body: Blob) => {
	const parts = unzipSync(new Uint8Array(await body.arrayBuffer()));
	expect(strFromU8(parts.mimetype ?? new Uint8Array())).toBe("application/vnd.oasis.opendocument.text");
	const content = parts["content.xml"];
	if (!content) throw new Error("Missing OpenDocument content");
	return { parts, content: strFromU8(content) };
};

beforeEach(() => {
	vi.clearAllMocks();
	const data = structuredClone(defaultResumeData);
	data.basics.name = "Ada Lovelace";
	data.summary.content = "<p>Builds analytical engines.</p>";
	getResume.mockResolvedValue({ id: "resume-1", name: "Ada", data });
	const letterStyle = copyCoverLetterStyle(data);
	getLetter.mockResolvedValue({
		id: "letter-1",
		name: "Acme letter",
		layout: "structured",
		recipient: "",
		content: "<p>I would love to build engines at Acme.</p>",
		greeting: null,
		signOff: null,
		recipientName: "Jane Doe",
		recipientCompany: "Acme",
		letterDate: "2026-03-01",
		style: letterStyle,
		sourceResumeId: null,
		sourceApplicationId: null,
		senderLinked: false,
		designLinked: false,
		isLocked: false,
		revision: 1,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	exportLetter.mockResolvedValue({ format: "reactive-resume-cover-letter", version: 1, name: "Acme letter" });
});

it("exports saved data as round-trippable JSON, readable Markdown, a Word document and an OpenDocument file", async () => {
	const json = await call(documentExports.resume, { id: "resume-1", format: "json" }, { context });
	expect(JSON.parse(await json.body.text())).toMatchObject({ basics: { name: "Ada Lovelace" } });
	expect(json.headers["content-disposition"]).toContain(".json");
	const markdown = await call(documentExports.resume, { id: "resume-1", format: "md" }, { context });
	expect(await markdown.body.text()).toContain("Builds analytical engines.");
	const docx = await call(documentExports.resume, { id: "resume-1", format: "docx" }, { context });
	const files = unzipSync(new Uint8Array(await docx.body.arrayBuffer()));
	const xml = files["word/document.xml"];
	expect(xml).toBeDefined();
	if (!xml) throw new Error("Missing Word document");
	expect(strFromU8(xml)).toContain("Ada Lovelace");
	const odt = await call(documentExports.resume, { id: "resume-1", format: "odt" }, { context });
	expect(odt.headers["content-disposition"]).toContain(".odt");
	expect(odt.body.type).toBe("application/vnd.oasis.opendocument.text");
	const { content } = await odtContent(odt.body);
	expect(content).toContain("Ada Lovelace");
	expect(content).toContain("Builds analytical engines.");
	expect(readServerImage).not.toHaveBeenCalled();
	expect(getResume).toHaveBeenCalledWith({ id: "resume-1", userId: "owner" });
});

it("embeds the resume picture in the OpenDocument file through the server's image reader", async () => {
	const data = structuredClone(defaultResumeData);
	data.basics.name = "Ada Lovelace";
	data.picture = { ...data.picture, hidden: false, url: "http://localhost:3000/api/uploads/owner/pictures/p.png" };
	getResume.mockResolvedValue({ id: "resume-1", name: "Ada", data });
	readServerImage.mockResolvedValue(png);
	const odt = await call(documentExports.resume, { id: "resume-1", format: "odt" }, { context });
	expect(readServerImage).toHaveBeenCalledWith(data.picture.url, "http://localhost:3000");
	const { parts, content } = await odtContent(odt.body);
	expect(parts["Pictures/picture.png"]).toEqual(png);
	expect(content).toContain('xlink:href="Pictures/picture.png"');
	expect(strFromU8(parts["META-INF/manifest.xml"] ?? new Uint8Array())).toContain("Pictures/picture.png");
});

it("still exports the OpenDocument file when the picture can't be read", async () => {
	const data = structuredClone(defaultResumeData);
	data.basics.name = "Ada Lovelace";
	data.picture = { ...data.picture, hidden: false, url: "http://10.0.0.1/secret.png" };
	getResume.mockResolvedValue({ id: "resume-1", name: "Ada", data });
	readServerImage.mockRejectedValue(new Error("Private or invalid image URL refused"));
	const odt = await call(documentExports.resume, { id: "resume-1", format: "odt" }, { context });
	const { parts, content } = await odtContent(odt.body);
	expect(parts["Pictures/picture.png"]).toBeUndefined();
	expect(content).toContain("Ada Lovelace");
});

it("exports a cover letter as an OpenDocument file, Word document, Markdown and JSON", async () => {
	const odt = await call(documentExports.letter, { id: "letter-1", format: "odt" }, { context });
	expect(odt.headers["content-disposition"]).toContain(".odt");
	const { content } = await odtContent(odt.body);
	// The composed letter: recipient block with the date, the greeting, the body and the sign-off over the sender.
	for (const expected of [
		"Jane Doe",
		"Acme",
		"March 1, 2026",
		"Dear Jane,",
		"I would love to build engines at Acme.",
		"Kind regards,",
		"Ada Lovelace",
	]) {
		expect(content).toContain(expected);
	}
	// A letter prints no resume header: the sender's name appears once, in the signature.
	expect(content.split("Ada Lovelace")).toHaveLength(2);

	const docx = await call(documentExports.letter, { id: "letter-1", format: "docx" }, { context });
	const word = unzipSync(new Uint8Array(await docx.body.arrayBuffer()))["word/document.xml"];
	expect(strFromU8(word ?? new Uint8Array())).toContain("Dear Jane,");

	const markdown = await call(documentExports.letter, { id: "letter-1", format: "md" }, { context });
	expect(await markdown.body.text()).toContain("Dear Jane,");

	const json = await call(documentExports.letter, { id: "letter-1", format: "json" }, { context });
	expect(JSON.parse(await json.body.text())).toMatchObject({ format: "reactive-resume-cover-letter" });
	expect(exportLetter).toHaveBeenCalledWith({ id: "letter-1", userId: "owner" });
	expect(getLetter).toHaveBeenCalledWith({ id: "letter-1", userId: "owner" });
});

it("localizes a cover letter's greeting and sign-off with the supplied words", async () => {
	const words = {
		greeting: "Liebe {name},",
		teamGreeting: "Liebes Team,",
		hiringTeam: "Team",
		signOff: "Mit freundlichen Grüßen,",
	};
	const odt = await call(documentExports.letter, { id: "letter-1", format: "odt", words }, { context });
	const { content } = await odtContent(odt.body);
	expect(content).toContain("Liebe Jane,");
	expect(content).toContain("Mit freundlichen Grüßen,");
	expect(content).not.toContain("Kind regards");
});
