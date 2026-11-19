import { type AttachmentInfo, describeMedia, formatBytes, isImage, type MediaSupport } from "@tiny/core";
import { CircleAlert, FileText, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../lib/client.ts";
import { cn } from "../../lib/format.ts";
import { toast } from "../../lib/toast.ts";
import { Spinner } from "../ui/Spinner.tsx";

/** A file picked for the next message: uploading, uploaded, or failed. */
export type PendingFile = {
	key: string;
	name: string;
	size: number;
	mimeType: string;
	/** Object URL of an image, for its thumbnail. */
	preview?: string;
	status: "uploading" | "done" | "error";
	info?: AttachmentInfo;
	error?: string;
};

/**
 * Files for the next message. Each one uploads as soon as it is added (paste, drop, or the picker), so sending is
 * instant; the message carries their upload IDs.
 */
export function usePendingFiles(media: MediaSupport | undefined) {
	const [files, setFiles] = useState<PendingFile[]>([]);
	const filesRef = useRef(files);
	filesRef.current = files;

	useEffect(
		() => () => {
			for (const file of filesRef.current) if (file.preview) URL.revokeObjectURL(file.preview);
		},
		[],
	);

	const add = useCallback(
		(list: readonly File[]) => {
			for (const file of list) {
				const name = file.name || (isImage(file.type) ? `pasted-image.${file.type.split("/")[1] ?? "png"}` : "file");
				const max = media?.maxFileBytes;
				if (max && file.size > max) {
					toast(`${name} is ${formatBytes(file.size)}; the limit is ${formatBytes(max)}`);
					continue;
				}
				const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				const pending: PendingFile = {
					key,
					name,
					size: file.size,
					mimeType: file.type || "application/octet-stream",
					...(isImage(file.type) ? { preview: URL.createObjectURL(file) } : {}),
					status: "uploading",
				};
				setFiles((current) => [...current, pending]);
				const named = file.name ? file : new File([file], name, { type: file.type });
				client.upload([named]).then(
					([info]) =>
						setFiles((current) =>
							current.map((item) => (item.key === key ? { ...item, status: "done", ...(info ? { info } : {}) } : item)),
						),
					(error: unknown) =>
						setFiles((current) =>
							current.map((item) =>
								item.key === key
									? { ...item, status: "error", error: error instanceof Error ? error.message : String(error) }
									: item,
							),
						),
				);
			}
		},
		[media?.maxFileBytes],
	);

	const remove = useCallback((key: string) => {
		setFiles((current) => {
			const gone = current.find((item) => item.key === key);
			if (gone?.preview) URL.revokeObjectURL(gone.preview);
			return current.filter((item) => item.key !== key);
		});
	}, []);

	const clear = useCallback(() => {
		setFiles((current) => {
			for (const item of current) if (item.preview) URL.revokeObjectURL(item.preview);
			return [];
		});
	}, []);

	const uploading = files.some((file) => file.status === "uploading");
	const ready = files.flatMap((file) => (file.status === "done" && file.info ? [file.info] : []));
	return { files, add, remove, clear, uploading, ready };
}

/** The picked files, above the text box. */
export function PendingFiles({ files, onRemove }: { files: readonly PendingFile[]; onRemove: (key: string) => void }) {
	if (files.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-2 px-3 pt-3">
			{files.map((file) => (
				<div
					key={file.key}
					title={file.error ?? `${file.name} · ${formatBytes(file.size)}`}
					className={cn(
						"group relative flex h-14 items-center gap-2 overflow-hidden rounded-lg border bg-surface-2 text-xs",
						file.status === "error" ? "border-danger/50" : "border-border",
						file.preview ? "w-14" : "max-w-56 pr-7 pl-2",
					)}
				>
					{file.preview ? (
						<img src={file.preview} alt={file.name} className="size-full object-cover" />
					) : (
						<>
							<FileText className="size-5 shrink-0 text-muted" />
							<div className="min-w-0">
								<div className="truncate font-medium text-fg">{file.name}</div>
								<div className="text-faint">{file.status === "error" ? "Upload failed" : formatBytes(file.size)}</div>
							</div>
						</>
					)}
					{file.status === "uploading" && (
						<div className="absolute inset-0 flex items-center justify-center bg-surface/60">
							<Spinner className="size-4" />
						</div>
					)}
					{file.status === "error" && file.preview && (
						<div className="absolute inset-0 flex items-center justify-center bg-surface/70">
							<CircleAlert className="size-4 text-danger" />
						</div>
					)}
					<button
						type="button"
						aria-label={`Remove ${file.name}`}
						onClick={() => onRemove(file.key)}
						className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-bg/80 text-muted hover:text-fg"
					>
						<X className="size-3" />
					</button>
				</div>
			))}
		</div>
	);
}

/** The paperclip: opens the file picker. Its tooltip says what the engine takes natively. */
export function AttachButton({
	media,
	onFiles,
}: {
	media: MediaSupport | undefined;
	onFiles: (files: File[]) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const title = `Attach files or paste images (${describeMedia(media)} go to the model directly; other files as paths it can open)`;
	return (
		<>
			<button
				type="button"
				onClick={() => input.current?.click()}
				aria-label="Attach files"
				title={title}
				className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg"
			>
				<Paperclip className="size-4" />
			</button>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				onChange={(event) => {
					const files = Array.from(event.target.files ?? []);
					event.target.value = "";
					if (files.length > 0) onFiles(files);
				}}
			/>
		</>
	);
}

/** Files attached to a sent message: image thumbnails that open full size, other files as download links. */
export function SentAttachments({ attachments }: { attachments: readonly AttachmentInfo[] }) {
	if (attachments.length === 0) return null;
	const images = attachments.filter(
		(attachment) => isImage(attachment.mimeType) && !/svg|heic|heif|tiff/i.test(attachment.mimeType),
	);
	const others = attachments.filter((attachment) => !images.includes(attachment));
	return (
		<div className="mb-2 flex max-w-[85%] flex-col items-end gap-2">
			{images.length > 0 && (
				<div className="flex flex-wrap justify-end gap-2">
					{images.map((image) => (
						<a key={image.id} href={client.uploadUrl(image.id)} target="_blank" rel="noreferrer" title={image.name}>
							<img
								src={client.uploadUrl(image.id)}
								alt={image.name}
								loading="lazy"
								className="max-h-48 rounded-xl border border-border object-cover"
							/>
						</a>
					))}
				</div>
			)}
			{others.length > 0 && (
				<div className="flex flex-wrap justify-end gap-2">
					{others.map((file) => (
						<a
							key={file.id}
							href={client.uploadUrl(file.id, { download: file.mimeType !== "application/pdf" })}
							target="_blank"
							rel="noreferrer"
							className="flex max-w-64 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs hover:bg-surface-2"
						>
							<FileText className="size-4 shrink-0 text-muted" />
							<span className="min-w-0">
								<span className="block truncate font-medium text-fg">{file.name}</span>
								<span className="block text-faint">{formatBytes(file.size)}</span>
							</span>
						</a>
					))}
				</div>
			)}
		</div>
	);
}
