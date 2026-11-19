/**
 * Attachments: files users send with a message.
 *
 * A client uploads files first (`POST /api/uploads`); they are saved under `<dataDir>/uploads/<id>/<name>` and listed
 * in `app_uploads`. A message then names them by ID. What the model gets depends on the engine (`MediaSupport`):
 *
 * - files whose type the engine takes natively are attached as content: images (resized to fit the model's limits),
 *   and for engines that take them, PDFs, video, ...;
 * - small text files are included in the message;
 * - every file is listed with its path on this machine, so the engine's tools can open the rest.
 */
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { formatBytes, isImage, isInline } from "@tiny/core/media";
import type { AttachmentInfo, MediaSupport } from "@tiny/core/protocol";
import type { AppDb, StoredUpload } from "./db.ts";

export type Attachment = AttachmentInfo & { path: string };

export type PreparedAttachment = Attachment & {
	/** The file as model content, when the engine takes its type natively. */
	inline?: { data: string; mimeType: string; resized?: string };
	/** The file's text, when it is a small text file the engine does not take natively. */
	text?: string;
};

/** Images providers take inline; others (HEIC, SVG, TIFF, ...) are converted by the image processor or passed as paths. */
const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Text files up to this size are included in the message. */
const MAX_INLINE_TEXT = 64 * 1024;
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

	/** Resolve upload IDs from a message; unknown IDs are an error. */
	resolve(ids: readonly string[]): Attachment[] {
		return ids.map((id) => {
			const upload = this.db.upload(id);
			if (!upload) throw new Error(`No upload ${id}`);
			return { id: upload.id, name: upload.name, mimeType: upload.mimeType, size: upload.size, path: upload.path };
		});
	}
}

/** Prepared images by upload and limits: a turn prepares its attachments twice (its entry, then the engine). */
const prepared = new Map<string, PreparedAttachment["inline"] | null>();

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
	prepared.set(key, result);
	if (prepared.size > 64) prepared.delete(prepared.keys().next().value!);
	return result ?? undefined;
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
		if (isInline(attachment.mimeType, media)) {
			const bytes = await file.bytes();
			if (isImage(attachment.mimeType)) {
				const inline = await prepareImage(attachment, bytes, images);
				out.push(inline ? { ...attachment, inline } : attachment);
			} else {
				out.push({
					...attachment,
					inline: { data: Buffer.from(bytes).toString("base64"), mimeType: attachment.mimeType },
				});
			}
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
