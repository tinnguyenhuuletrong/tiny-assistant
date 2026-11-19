/** Minimal valid PDFs for tests: one page per entry, each line of a page drawn as text (an empty page has none). */
export function makePdf(pages: string[][]): Uint8Array {
	const objects: string[] = [];
	const add = (body: string) => objects.push(body) && objects.length;
	const catalog = add("");
	const pagesId = add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids: number[] = [];
	for (const lines of pages) {
		const ops = lines
			.map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 16} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`)
			.join("\n");
		const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
		kids.push(
			add(
				`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
			),
		);
	}
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
	objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}
