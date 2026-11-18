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
			// Only required fields (and ones with a default): blank optional fields would just be noise to delete.
			const properties = (s.properties ?? {}) as Record<string, Record<string, unknown>>;
			const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
			const out: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(properties)) {
				if (required.has(key) || (value && "default" in value)) out[key] = sampleFromSchema(value, depth + 1);
			}
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

export type FormField = {
	name: string;
	kind: "text" | "number" | "boolean" | "choice" | "list";
	/** For lists: the item type. */
	itemKind?: "string" | "number";
	/** For choices: the allowed values. */
	options?: string[];
	description?: string;
	required: boolean;
	integer?: boolean;
};

function typeOf(schema: Record<string, unknown>): string | undefined {
	return Array.isArray(schema.type)
		? (schema.type.find((t) => t !== "null") as string | undefined)
		: (schema.type as string);
}

/**
 * Form fields for a flat object schema (text, numbers, yes/no, choices, and lists of text or numbers). `null` when
 * any field needs something richer, so the dialog falls back to the JSON editor.
 */
export function formFields(schema: unknown): FormField[] | null {
	if (!isObjectSchema(schema)) return null;
	const s = schema as { properties: Record<string, Record<string, unknown>>; required?: string[] };
	const fields: FormField[] = [];
	for (const [name, prop] of Object.entries(s.properties)) {
		const base = {
			name,
			description: typeof prop.description === "string" ? prop.description : undefined,
			required: s.required?.includes(name) ?? false,
		};
		const type = typeOf(prop);
		if (Array.isArray(prop.enum) && prop.enum.every((value) => typeof value === "string")) {
			fields.push({ ...base, kind: "choice", options: prop.enum as string[] });
		} else if (type === "string") fields.push({ ...base, kind: "text" });
		else if (type === "number" || type === "integer")
			fields.push({ ...base, kind: "number", integer: type === "integer" });
		else if (type === "boolean") fields.push({ ...base, kind: "boolean" });
		else if (type === "array") {
			const items = typeOf((prop.items ?? {}) as Record<string, unknown>);
			if (items === "string") fields.push({ ...base, kind: "list", itemKind: "string" });
			else if (items === "number" || items === "integer") fields.push({ ...base, kind: "list", itemKind: "number" });
			else return null;
		} else return null;
	}
	return fields;
}

/** Whether a form value counts as filled in, for required fields. */
export function isFilled(value: unknown): boolean {
	if (value === undefined || value === null || value === "") return false;
	return !Array.isArray(value) || value.length > 0;
}
