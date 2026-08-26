// Cline account provider identity.
//
// Usage-billing `cline` and subscription `cline-pass` share one Cline account
// OAuth token, one API base URL, and one set of account endpoints. They remain
// distinct provider ids in the SDK registry and in saved settings — session
// start must keep `cline-pass` so the gateway bills the subscription.
//
// ClinePass OAuth still goes through Cline's identity provider (WorkOS). Only
// that token-exchange name maps to `cline`; the session/gateway provider id
// does not.

export const CLINE_PROVIDER_ID = "cline";
export const CLINE_PASS_PROVIDER_ID = "cline-pass";
export const CLINE_PASS_PROVIDER_NAME = "ClinePass";

export function isClineAccountProviderId(providerId: string | null | undefined): boolean {
	const normalizedProviderId = providerId?.trim().toLowerCase();
	return normalizedProviderId === CLINE_PROVIDER_ID || normalizedProviderId === CLINE_PASS_PROVIDER_ID;
}

/**
 * Identity-provider name for Cline account OAuth token exchange.
 * ClinePass is not a separate IdP; WorkOS still talks to `cline`.
 */
export function resolveClineOauthIdentityProviderId(providerId: string): string {
	return isClineAccountProviderId(providerId) ? CLINE_PROVIDER_ID : providerId;
}
