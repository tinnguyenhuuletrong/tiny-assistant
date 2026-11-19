/** Attachment helpers shared by the daemon and the clients. Pure functions: safe in browsers. */
import type { MediaSupport } from "./protocol.ts";

/** Whether a MIME type matches one of `patterns` (`image/png`, `image/*`, `*`). */
export function mimeMatches(mimeType: string, patterns: readonly string[]): boolean {
	const type = mimeType.toLowerCase().split(";")[0]!.trim();
	return patterns.some((pattern) => {
		const wanted = pattern.toLowerCase();
		if (wanted === "*" || wanted === "*/*") return true;
		if (wanted.endsWith("/*")) return type.startsWith(wanted.slice(0, -1));
		return type === wanted;
	});
}

/** Whether an engine passes a file of this type to the model natively (otherwise it gets the file's path). */
export function isInline(mimeType: string, media: MediaSupport | undefined): boolean {
	return media ? mimeMatches(mimeType, media.inline) : false;
}

/** Types the daemon serves inline (shown in the page); every other upload is served as a download. */
export const VIEWABLE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

export function isViewable(mimeType: string): boolean {
	return VIEWABLE_TYPES.includes(mimeType.toLowerCase().split(";")[0]!.trim());
}

export function isImage(mimeType: string): boolean {
	return mimeType.toLowerCase().startsWith("image/");
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What an engine takes natively, in words: "images and PDFs". */
export function describeMedia(media: MediaSupport | undefined): string {
	if (!media || media.inline.length === 0) return "no files directly";
	const names = new Set<string>();
	for (const pattern of media.inline) {
		const [type, sub] = pattern.toLowerCase().split("/");
		if (type === "image") names.add("images");
		else if (type === "video") names.add("video");
		else if (type === "audio") names.add("audio");
		else if (sub === "pdf") names.add("PDFs");
		else names.add(pattern);
	}
	const list = [...names];
	return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0]!;
}
