import type { RuntimeClineReasoningEffort } from "@/runtime/types";

// web-ui cannot import the contract's zod schemas (@runtime-contract is a
// type-only alias), so the Record key set is what keeps this in step with
// RuntimeClineReasoningEffort: a new effort in the contract fails to compile here.
export const CLINE_REASONING_EFFORT_LABELS: Record<RuntimeClineReasoningEffort, string> = {
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

export const CLINE_REASONING_EFFORT_VALUES = Object.keys(
	CLINE_REASONING_EFFORT_LABELS,
) as RuntimeClineReasoningEffort[];

export function parseClineReasoningEffort(value: unknown): RuntimeClineReasoningEffort | undefined {
	return CLINE_REASONING_EFFORT_VALUES.find((effort) => effort === value);
}
