import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const IDCS_CONSTANT_NAMES = [
	"DEFAULT_INTERNAL_IDCS_CLIENT_ID",
	"DEFAULT_INTERNAL_IDCS_URL",
	"DEFAULT_INTERNAL_IDCS_SCOPES",
	"DEFAULT_EXTERNAL_IDCS_CLIENT_ID",
	"DEFAULT_EXTERNAL_IDCS_URL",
	"DEFAULT_EXTERNAL_IDCS_SCOPES",
] as const;

function readAssignedString(source: string, name: string): string | undefined {
	return source.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`))?.[1];
}

describe("OCA IDCS defaults", () => {
	it("matches dist/auth/oca.d.ts in the installed @cline/core", () => {
		const ocaDts = readFileSync(
			fileURLToPath(new URL("../../../node_modules/@cline/core/dist/auth/oca.d.ts", import.meta.url)),
			"utf8",
		);
		const boundary = readFileSync(
			fileURLToPath(new URL("../../../src/cline-sdk/sdk-provider-boundary.ts", import.meta.url)),
			"utf8",
		);

		for (const name of IDCS_CONSTANT_NAMES) {
			const fromBoundary = readAssignedString(boundary, name);
			const fromSdk = readAssignedString(ocaDts, name);
			expect(fromBoundary, name).toBeDefined();
			expect(fromSdk, name).toBeDefined();
			expect(fromBoundary, name).toBe(fromSdk);
		}
	});
});
