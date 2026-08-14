import { describe, expect, it } from "vitest";

import { resolveTaskClineSettingsForCreate, resolveTaskClineSettingsForUpdate } from "../../src/commands/task";
import type { RuntimeTaskClineSettings } from "../../src/core/api-contract";
import { runtimeAgentIdSchema } from "../../src/core/api-contract";

const NON_CLINE_AGENT_IDS = runtimeAgentIdSchema.options.filter((agentId) => agentId !== "cline");

const CLINE_SETTINGS: RuntimeTaskClineSettings = {
	providerId: "anthropic",
	modelId: "claude-sonnet-4-20250514",
	reasoningEffort: "high",
};

describe("resolveTaskClineSettingsForCreate", () => {
	it("keeps Cline settings for a cline agent override", () => {
		expect(resolveTaskClineSettingsForCreate({ agentId: "cline", clineSettings: CLINE_SETTINGS })).toEqual(
			CLINE_SETTINGS,
		);
	});

	it("keeps Cline settings when no agent override is set (workspace default may be Cline)", () => {
		expect(resolveTaskClineSettingsForCreate({ agentId: undefined, clineSettings: CLINE_SETTINGS })).toEqual(
			CLINE_SETTINGS,
		);
	});

	it("strips Cline settings when the agent override is a non-Cline agent", () => {
		for (const agentId of NON_CLINE_AGENT_IDS) {
			expect(resolveTaskClineSettingsForCreate({ agentId, clineSettings: CLINE_SETTINGS })).toBeUndefined();
		}
	});

	it("passes through undefined settings untouched", () => {
		expect(resolveTaskClineSettingsForCreate({ agentId: "claude", clineSettings: undefined })).toBeUndefined();
		expect(resolveTaskClineSettingsForCreate({ agentId: "cline", clineSettings: undefined })).toBeUndefined();
	});
});

describe("resolveTaskClineSettingsForUpdate", () => {
	it("keeps merged Cline settings for a cline agent override", () => {
		expect(resolveTaskClineSettingsForUpdate({ agentId: "cline", clineSettings: CLINE_SETTINGS })).toEqual(
			CLINE_SETTINGS,
		);
	});

	it("keeps merged Cline settings when no agent override is set", () => {
		expect(resolveTaskClineSettingsForUpdate({ agentId: undefined, clineSettings: CLINE_SETTINGS })).toEqual(
			CLINE_SETTINGS,
		);
	});

	it("keeps merged Cline settings when the agent override is cleared (default)", () => {
		expect(resolveTaskClineSettingsForUpdate({ agentId: null, clineSettings: CLINE_SETTINGS })).toEqual(
			CLINE_SETTINGS,
		);
	});

	it("clears stored Cline settings when switching to a non-Cline agent", () => {
		for (const agentId of NON_CLINE_AGENT_IDS) {
			expect(resolveTaskClineSettingsForUpdate({ agentId, clineSettings: CLINE_SETTINGS })).toBeNull();
		}
	});

	it("passes through explicit clear (null) settings untouched", () => {
		expect(resolveTaskClineSettingsForUpdate({ agentId: undefined, clineSettings: null })).toBeNull();
		expect(resolveTaskClineSettingsForUpdate({ agentId: "cline", clineSettings: null })).toBeNull();
	});

	it("passes through undefined settings untouched", () => {
		expect(resolveTaskClineSettingsForUpdate({ agentId: undefined, clineSettings: undefined })).toBeUndefined();
		expect(resolveTaskClineSettingsForUpdate({ agentId: "claude", clineSettings: undefined })).toBeNull();
	});
});
