import { describe, expect, it } from "vitest";

import { runtimeClineReasoningEffortSchema } from "../../src/core/api-contract";

// The schema's declaration order is user-facing: task.ts builds the
// --cline-reasoning-effort help text and parse errors from .options, and
// web-ui's CLINE_REASONING_EFFORT_OPTIONS mirrors the same ascending order.
// web-ui's exhaustive Record catches an added value but not a reordered
// schema, so pin the canonical sequence here.
describe("runtimeClineReasoningEffortSchema", () => {
	it("declares reasoning efforts in canonical ascending order", () => {
		expect([...runtimeClineReasoningEffortSchema.options]).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
});
