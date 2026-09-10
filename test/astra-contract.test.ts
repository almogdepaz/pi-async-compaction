import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createReservedContextNamespaces,
	validateHistoryAction,
	validateNotesAction,
} from "../src/astra/contract";

describe("astra reserved history and notes contract", () => {
	test("keeps encrypted wire schemas open while rejecting injected local fields", () => {
		const namespaces = createReservedContextNamespaces();
		const notes = namespaces.find((namespace) => namespace.name === "notes");
		const write = notes?.tools.find((operation) => operation.name === "write_file");
		expect(write?.parameters.additionalProperties).toBeUndefined();
		expect((write?.parameters.properties as Record<string, unknown> | undefined)?.text).toEqual({ type: "string", encrypted: true });
		expect(() => validateNotesAction("write_file", { path: "state", text: "x", unexpected: "field" })).toThrow(
			"does not accept unexpected",
		);
		expect(() => validateHistoryAction("read_item", { window_id: "window", item_id: "item", context: {} })).toThrow(
			"does not accept context",
		);
	});

	test("matches the full pinned selected-adapter remote namespace fixture", () => {
		const fixturePath = join(import.meta.dir, "fixtures", "astra-pinned-adapter-remote-namespaces.json");
		const expected = JSON.parse(readFileSync(fixturePath, "utf8"));
		expect(createReservedContextNamespaces()).toEqual(expected);
	});

	test("matches the selected adapted history and notes descriptions", () => {
		const namespaces = createReservedContextNamespaces();
		const history = namespaces.find((namespace) => namespace.name === "history");
		const notes = namespaces.find((namespace) => namespace.name === "notes");
		expect(notes?.description).toBe("Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].");
		expect((history?.tools.find((tool) => tool.name === "read_item")?.parameters.properties as Record<string, unknown>).item_id).toMatchObject({ description: "Suffix from the item's [id: …] marker." });
		expect((history?.tools.find((tool) => tool.name === "search_contents")?.parameters.properties as Record<string, unknown>).query).toMatchObject({ description: "Case-sensitive" });
		expect((notes?.tools.find((tool) => tool.name === "search_contents")?.parameters.properties as Record<string, unknown>).query).toMatchObject({ description: "Case-sensitive" });
	});
});
