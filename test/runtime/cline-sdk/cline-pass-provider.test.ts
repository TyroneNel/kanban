import { describe, expect, it } from "vitest";
import {
	CLINE_PASS_PROVIDER_ID,
	CLINE_PROVIDER_ID,
	isClineAccountProviderId,
	isClinePassProviderId,
	resolveClineOauthIdentityProviderId,
} from "../../../src/cline-sdk/cline-pass-provider";
import { getProviderAuthStorageId } from "../../../src/cline-sdk/sdk-provider-boundary";

describe("isClinePassProviderId", () => {
	it("matches the ClinePass provider id regardless of casing and padding", () => {
		expect(isClinePassProviderId("cline-pass")).toBe(true);
		expect(isClinePassProviderId(" Cline-Pass ")).toBe(true);
	});

	it("does not match other providers or missing ids", () => {
		expect(isClinePassProviderId("cline")).toBe(false);
		expect(isClinePassProviderId("clinepass")).toBe(false);
		expect(isClinePassProviderId(null)).toBe(false);
		expect(isClinePassProviderId(undefined)).toBe(false);
	});
});

describe("isClineAccountProviderId", () => {
	it("accepts both providers that authenticate with a Cline account", () => {
		expect(isClineAccountProviderId("cline")).toBe(true);
		expect(isClineAccountProviderId("cline-pass")).toBe(true);
	});

	it("rejects providers that use their own credentials", () => {
		expect(isClineAccountProviderId("anthropic")).toBe(false);
		expect(isClineAccountProviderId("openai-codex")).toBe(false);
		expect(isClineAccountProviderId("oca")).toBe(false);
		expect(isClineAccountProviderId(null)).toBe(false);
	});
});

describe("resolveClineOauthIdentityProviderId", () => {
	it("uses the Cline identity provider for ClinePass token exchange", () => {
		expect(resolveClineOauthIdentityProviderId(CLINE_PASS_PROVIDER_ID)).toBe(CLINE_PROVIDER_ID);
	});

	it("leaves non-Cline-account provider ids untouched", () => {
		expect(resolveClineOauthIdentityProviderId("oca")).toBe("oca");
		expect(resolveClineOauthIdentityProviderId("anthropic")).toBe("anthropic");
	});
});

describe("getProviderAuthStorageId", () => {
	it("stores ClinePass credentials under the cline identity", () => {
		// Single Cline sign-in covers both usage-billing and ClinePass because the SDK
		// stores cline-pass credentials under the cline storage id.
		expect(getProviderAuthStorageId(CLINE_PASS_PROVIDER_ID)).toBe(CLINE_PROVIDER_ID);
	});
});
