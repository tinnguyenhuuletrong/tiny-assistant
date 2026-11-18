/** Builds an example input from a JSON Schema so the workflow dialog starts with the right shape. */
export function sampleFromSchema(schema: unknown, depth = 0): unknown {
	if (!schema || typeof schema !== "object" || depth > 6) return null;
	const s = schema as Record<string, unknown>;
	if ("default" in s) return s.default;
	if ("const" in s) return s.const;
	if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
	if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const options = s[key];
		if (Array.isArray(options) && options.length > 0) {
			const first = options.find((option) => (option as { type?: string })?.type !== "null") ?? options[0];
			return sampleFromSchema(first, depth + 1);
		}
	}
	const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
	switch (type) {
		case "object": {
			const properties = (s.properties ?? {}) as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(properties)) out[key] = sampleFromSchema(value, depth + 1);
			return out;
		}
		case "array":
			return [];
		case "string":
			return "";
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		default:
			return s.properties ? sampleFromSchema({ ...s, type: "object" }, depth) : null;
	}
}

/** Whether a workflow's declared input looks like an object schema with properties. */
export function isObjectSchema(schema: unknown): boolean {
	if (!schema || typeof schema !== "object") return false;
	const s = schema as Record<string, unknown>;
	return (s.type === "object" || s.properties !== undefined) && typeof s.properties === "object";
}

/** Property descriptions for a hint under the editor. */
export function schemaFields(
	schema: unknown,
): { name: string; type: string; description?: string; required: boolean }[] {
	if (!isObjectSchema(schema)) return [];
	const s = schema as { properties: Record<string, Record<string, unknown>>; required?: string[] };
	return Object.entries(s.properties).map(([name, prop]) => ({
		name,
		type: Array.isArray(prop.type) ? prop.type.join(" | ") : String(prop.type ?? (prop.enum ? "enum" : "any")),
		description: typeof prop.description === "string" ? prop.description : undefined,
		required: s.required?.includes(name) ?? false,
	}));
}
