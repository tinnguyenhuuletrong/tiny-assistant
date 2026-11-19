/**
 * Attachments: files users send with a message.
 *
 * A client uploads files first (`POST /api/uploads`); they are saved under `<dataDir>/uploads/<id>/<name>` and listed
 * in `app_uploads`. A message then names them by ID. What the model gets depends on the engine (`MediaSupport`):
 *
 * - files whose type the engine takes natively are attached as content: images (resized to fit the model's limits),
 *   and for engines that take them, PDFs, video, ...;
 * - small text files are included in the message, and so is the text of a PDF the engine does not take natively
 *   (pi-ai messages carry only text and images, so a Tiny chat reads PDFs this way, with any model);
 * - every file is listed with its path on this machine, so the engine's tools can open the rest.
 */
import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { formatBytes, isImage, isInline } from "@tiny/core/media";
import type { AttachmentInfo, MediaSupport } from "@tiny/core/protocol";
import { getDocumentProxy } from "unpdf";
import type { AppDb, StoredUpload } from "./db.ts";

export type Attachment = AttachmentInfo & { path: string };

export type PreparedAttachment = Attachment & {
	/** The file as model content, when the engine takes its type natively. */
	inline?: { data: string; mimeType: string; resized?: string };
	/**
	 * The file's text, when the engine does not take the file natively: a small text file, or the text of a PDF.
	 */
	text?: string;
	/** Set when `text` came out of a PDF: its pages, and whether `text` was cut at the limit. */
	extracted?: { pages: number; truncated: boolean };
	/** Set when a PDF has no text to extract (a scan) or could not be read. */
	unreadable?: string;
};

/** Images providers take inline; others (HEIC, SVG, TIFF, ...) are converted by the image processor or passed as paths. */
const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Text files up to this size are included in the message. */
const MAX_INLINE_TEXT = 64 * 1024;
/** Text extracted from a PDF is included up to this many characters (about 25k tokens); the rest stays in the file. */
export const MAX_PDF_TEXT = 100_000;
/** Bigger PDFs are not parsed for their text: their path is enough. */
const MAX_PDF_BYTES = 100 * 1024 * 1024;
/**
 * PDFs go to a model as documents only within the Anthropic API's limits (a 32 MB request, base64 included, and 100
 * pages); beyond them, as their text.
 */
const MAX_INLINE_PDF_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_PDF_PAGES = 100;
const TEXT_TYPES = [
	"application/json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/javascript",
	"application/typescript",
	"application/x-sh",
	"application/sql",
	"application/x-ndjson",
];
const TEXT_EXTENSIONS =
	/\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|log|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|proto|lua|r|scala|dart|vue|svelte|tex|diff|patch)$/i;

function isText(attachment: AttachmentInfo): boolean {
	const type = attachment.mimeType.toLowerCase();
	return type.startsWith("text/") || TEXT_TYPES.includes(type) || TEXT_EXTENSIONS.test(attachment.name);
}

function safeName(name: string): string {
	const printable = [...basename(name.replace(/\\/g, "/"))]
		.filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
		.join("");
	const clean = printable.trim().slice(-120);
	return clean && clean !== "." && clean !== ".." ? clean : "file";
}

export class UploadStore {
	constructor(
		readonly dir: string,
		readonly db: AppDb,
		readonly maxBytes: number,
	) {}

	/** Save one uploaded file. Throws when it is too big. The caller writes the row (`db.insertUpload`). */
	async save(file: Blob & { name?: string }): Promise<StoredUpload> {
		if (file.size > this.maxBytes)
			throw new Error(
				`${file.name ?? "File"} is ${formatBytes(file.size)}; the limit is ${formatBytes(this.maxBytes)}`,
			);
		const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
		const name = safeName(file.name ?? "file");
		const folder = join(this.dir, id);
		mkdirSync(folder, { recursive: true });
		const path = join(folder, name);
		await Bun.write(path, file);
		const declared = file.type.split(";")[0]!.trim();
		const guessed = Bun.file(path).type.split(";")[0]!.trim();
		const mimeType =
			declared && declared !== "application/octet-stream" ? declared : guessed || "application/octet-stream";
		return { id, name, mimeType, size: file.size, path, createdAt: Date.now() };
	}

	/** Remove a saved file (an upload request that failed part way). */
	discard(upload: StoredUpload): void {
		rmSync(dirname(upload.path), { recursive: true, force: true });
	}

	/** Resolve upload IDs from a message; unknown IDs are an error. */
	resolve(ids: readonly string[]): Attachment[] {
		return ids.map((id) => {
			const upload = this.db.upload(id);
			if (!upload) throw new Error(`No upload ${id}`);
			return { id: upload.id, name: upload.name, mimeType: upload.mimeType, size: upload.size, path: upload.path };
		});
	}
}

/**
 * Recently prepared images and PDF text, by upload: a turn prepares its attachments twice (its entry, then the engine),
 * and the next message often carries the same files. Kept small: base64 images are up to ~4.5 MB each.
 */
const CACHE_SIZE = 8;
const prepared = new Map<string, PreparedAttachment["inline"] | null>();
const extractedPdfs = new Map<string, Pick<PreparedAttachment, "text" | "extracted" | "unreadable">>();

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
	cache.delete(key);
	cache.set(key, value);
	if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
	return value;
}

async function prepareImage(
	attachment: Attachment,
	bytes: Uint8Array,
	images: ImageProcessor | undefined,
): Promise<PreparedAttachment["inline"] | undefined> {
	const key = attachment.id;
	if (prepared.has(key)) return prepared.get(key) ?? undefined;
	let result: PreparedAttachment["inline"] | null = null;
	if (images) {
		const image = await images.prepare(bytes, attachment.mimeType, DEFAULT_IMAGE_LIMITS).catch(() => undefined);
		if (image) {
			const resized = image.resized
				? `resized from ${image.resized.from.width}×${image.resized.from.height} to ${image.resized.to.width}×${image.resized.to.height}`
				: undefined;
			result = { data: image.data, mimeType: image.mimeType, ...(resized ? { resized } : {}) };
		}
	} else if (INLINE_IMAGE_TYPES.includes(attachment.mimeType) && bytes.length * 1.34 <= DEFAULT_IMAGE_LIMITS.maxBytes) {
		result = { data: Buffer.from(bytes).toString("base64"), mimeType: attachment.mimeType };
	}
	return remember(prepared, key, result) ?? undefined;
}

/** pdf.js may take ownership of the buffer: give it a copy. Verbosity 0 keeps its warnings out of the daemon's log. */
function openPdf(bytes: Uint8Array) {
	return getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
}

/** Pages of a PDF, or undefined when it cannot be parsed. */
async function pdfPages(bytes: Uint8Array): Promise<number | undefined> {
	try {
		const document = await openPdf(bytes);
		const pages = document.numPages;
		await document.loadingTask.destroy().catch(() => undefined);
		return pages;
	} catch {
		return undefined;
	}
}

/**
 * The text of a PDF, page by page, cut at `max` characters. Pages are read only until `max` is reached, yielding to the
 * event loop between pages, so a long PDF neither blocks the daemon nor costs more than the text kept. A PDF without
 * text (a scan, only images) or one that cannot be parsed says so in `unreadable`.
 */
export async function pdfText(
	bytes: Uint8Array,
	max = MAX_PDF_TEXT,
): Promise<Pick<PreparedAttachment, "text" | "extracted" | "unreadable">> {
	let document: Awaited<ReturnType<typeof openPdf>> | undefined;
	try {
		document = await openPdf(bytes);
		const total = document.numPages;
		const pages: string[] = [];
		let length = 0;
		for (let number = 1; number <= total && length <= max; number++) {
			const page = await document.getPage(number);
			const content = await page.getTextContent();
			const text = content.items
				.map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : ""))
				.join("")
				.replace(/[ \t]+\n/g, "\n")
				.trim();
			page.cleanup();
			pages.push(text);
			length += text.length + 20;
			await new Promise((resolve) => setImmediate(resolve));
		}
		if (pages.length === total && pages.every((page) => page.length === 0)) {
			return { unreadable: `no text layer in ${total} page${total === 1 ? "" : "s"} (a scan?)` };
		}
		const joined =
			total === 1 ? pages[0]! : pages.map((page, index) => `--- page ${index + 1} ---\n${page}`).join("\n\n");
		const truncated = joined.length > max || pages.length < total;
		return { text: joined.slice(0, max), extracted: { pages: total, truncated } };
	} catch (error) {
		return { unreadable: `could not be read (${error instanceof Error ? error.message : String(error)})` };
	} finally {
		await document?.loadingTask.destroy().catch(() => undefined);
	}
}

/** Read the files and decide, per the engine's `media`, what goes to the model as content. */
export async function prepareAttachments(
	attachments: readonly Attachment[],
	media: MediaSupport,
	images: ImageProcessor | undefined,
): Promise<PreparedAttachment[]> {
	const out: PreparedAttachment[] = [];
	for (const attachment of attachments) {
		const file = Bun.file(attachment.path);
		if (!(await file.exists())) {
			out.push(attachment);
			continue;
		}
		const pdf = attachment.mimeType === "application/pdf";
		if (isInline(attachment.mimeType, media)) {
			const bytes = await file.bytes();
			if (isImage(attachment.mimeType)) {
				const inline = await prepareImage(attachment, bytes, images);
				out.push(inline ? { ...attachment, inline } : attachment);
				continue;
			}
			// A PDF goes as a document only within the API's limits; a bigger one goes as its text, like for Tiny.
			const fits =
				!pdf || (attachment.size <= MAX_INLINE_PDF_BYTES && ((await pdfPages(bytes)) ?? 0) <= MAX_INLINE_PDF_PAGES);
			if (fits) {
				out.push({
					...attachment,
					inline: { data: Buffer.from(bytes).toString("base64"), mimeType: attachment.mimeType },
				});
				continue;
			}
		}
		if (pdf) {
			const found =
				extractedPdfs.get(attachment.id) ??
				remember(
					extractedPdfs,
					attachment.id,
					attachment.size <= MAX_PDF_BYTES
						? await pdfText(await file.bytes())
						: { unreadable: "too big to extract its text here" },
				);
			out.push({ ...attachment, ...found });
			continue;
		}
		if (isText(attachment) && attachment.size <= MAX_INLINE_TEXT) {
			const text = await file.text();
			if (!text.includes("\u0000")) {
				out.push({ ...attachment, text });
				continue;
			}
		}
		out.push(attachment);
	}
	return out;
}

/** The text that tells the model about the files: each one's path, and the contents of small text files. */
export function attachmentNote(attachments: readonly PreparedAttachment[]): string {
	if (attachments.length === 0) return "";
	const lines = [
		"<attachments>",
		"Files the user attached, saved on this machine. Open them with your tools when you need more than what is included here.",
	];
	for (const attachment of attachments) {
		const how = attachment.inline
			? isImage(attachment.inline.mimeType)
				? ` (attached as an image${attachment.inline.resized ? `, ${attachment.inline.resized}` : ""})`
				: " (attached as a document)"
			: attachment.extracted
				? ` (its text, from ${attachment.extracted.pages} page${attachment.extracted.pages === 1 ? "" : "s"}${
						attachment.extracted.truncated
							? `, cut at ${attachment.text?.length ?? 0} characters: open the file for the rest`
							: ""
					}, is below)`
				: attachment.unreadable
					? ` (${attachment.unreadable}: open it with your tools)`
					: "";
		lines.push(
			`- ${attachment.name} (${attachment.mimeType}, ${formatBytes(attachment.size)}): ${attachment.path}${how}`,
		);
		if (attachment.text !== undefined) {
			lines.push(`<file name="${attachment.name}">`, attachment.text.replace(/\n$/, ""), "</file>");
		}
	}
	lines.push("</attachments>");
	return lines.join("\n");
}

/** The message text the model sees: what the user typed, then the note. */
export function promptWithAttachments(text: string, attachments: readonly PreparedAttachment[]): string {
	const note = attachmentNote(attachments);
	if (!note) return text;
	return text.trim() ? `${text}\n\n${note}` : note;
}

/**
 * The user message in pi-ai's shape: text and images (the only content pi-ai messages carry). Engines that take more
 * (PDFs, video) build their own content from the prepared attachments.
 */
export function userContent(
	text: string,
	attachments: readonly PreparedAttachment[],
): string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
	if (attachments.length === 0) return text;
	return [
		{ type: "text", text: promptWithAttachments(text, attachments) },
		...attachments.flatMap((attachment) =>
			attachment.inline && isImage(attachment.inline.mimeType)
				? [{ type: "image" as const, data: attachment.inline.data, mimeType: attachment.inline.mimeType }]
				: [],
		),
	];
}

export function attachmentInfo(attachment: Attachment): AttachmentInfo {
	return { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size };
}

export { INLINE_IMAGE_TYPES };
