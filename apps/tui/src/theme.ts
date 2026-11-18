import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const sgr = (open: string, close: string) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;
const rgb = (r: number, g: number, b: number) => (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;

export const c = {
	bold: sgr("1", "22"),
	dim: sgr("2", "22"),
	italic: sgr("3", "23"),
	underline: sgr("4", "24"),
	strike: sgr("9", "29"),
	inverse: sgr("7", "27"),
	accent: rgb(217, 119, 87), // Claude-ish terracotta
	blue: rgb(97, 175, 239),
	green: rgb(120, 190, 120),
	yellow: rgb(229, 192, 123),
	red: rgb(224, 108, 117),
	cyan: rgb(86, 182, 194),
	gray: rgb(140, 140, 140),
	userBg: (text: string) => `\x1b[48;2;48;48;52m${text}\x1b[49m`,
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: c.accent,
	selectedText: c.bold,
	description: c.dim,
	scrollInfo: c.dim,
	noMatch: c.dim,
};

export const markdownTheme: MarkdownTheme = {
	heading: (text) => c.bold(c.accent(text)),
	link: c.blue,
	linkUrl: c.dim,
	code: c.yellow,
	codeBlock: (text) => text,
	codeBlockBorder: c.dim,
	quote: c.italic,
	quoteBorder: c.dim,
	hr: c.dim,
	listBullet: c.accent,
	bold: c.bold,
	italic: c.italic,
	strikethrough: c.strike,
	underline: c.underline,
};

export const editorTheme: EditorTheme = {
	borderColor: c.gray,
	selectList: selectListTheme,
};
