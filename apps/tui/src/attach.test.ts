import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pastedPaths } from "./attach.ts";

const dir = mkdtempSync(join(tmpdir(), "tiny-attach-"));
const spaced = join(dir, "my shot.png");
const plain = join(dir, "notes.txt");
writeFileSync(spaced, "x");
writeFileSync(plain, "y");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("paths dragged into a terminal are recognized, escaped or quoted", () => {
	expect(pastedPaths(`${spaced.replaceAll(" ", "\\ ")} ${plain}`)).toEqual([spaced, plain]);
	expect(pastedPaths(`'${spaced}'`)).toEqual([spaced]);
	expect(pastedPaths(`file://${encodeURI(plain)}`)).toEqual([plain]);
	expect(pastedPaths("./notes.txt", dir)).toEqual([plain]);
});

test("ordinary pasted text is left alone", () => {
	expect(pastedPaths("hello world")).toBeUndefined();
	expect(pastedPaths(`${plain} and more`)).toBeUndefined();
	expect(pastedPaths(join(dir, "missing.png"))).toBeUndefined();
	expect(pastedPaths("/usr")).toBeUndefined();
});
