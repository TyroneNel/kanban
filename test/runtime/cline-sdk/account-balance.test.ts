import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clineAccountMocks = vi.hoisted(() => ({
	fetchMe: vi.fn(),
	fetchBalance: vi.fn(),
	fetchOrganizationBalance: vi.fn(),
	switchAccount: vi.fn(),
	fetchRemoteConfig: vi.fn(),
	fetchOrganization: vi.fn(),
	fetchFeaturebaseToken: vi.fn(),
	constructedOptions: [] as Array<{ apiBaseUrl: string; getAuthToken: () => Promise<string | undefined | null> }>,
}));

const oauthMocks = vi.hoisted(() => ({
	saveProviderSettings: vi.fn(),
	getProviderSettings: vi.fn(),
	getLastUsedProviderSettings: vi.fn(),
	getValidClineCredentials: vi.fn(),
	loginClineOAuth: vi.fn(),
}));

const llmsModelMocks = vi.hoisted(() => ({
	getAllProviders: vi.fn(),
	getModelsForProvider: vi.fn(),
	resolveProviderConfig: vi.fn(),
	resolveProviderModelCatalogKeys: vi.fn((providerId: string) => [providerId]),
}));

const localProviderMocks = vi.hoisted(() => ({
	getLocalProviderModels: vi.fn(),
}));

vi.mock("@cline/core", () => ({
	addLocalProvider: vi.fn(),
	ensureCustomProvidersLoaded: vi.fn(),
	getLocalProviderModels: localProviderMocks.getLocalProviderModels,
	getValidClineCredentials: oauthMocks.getValidClineCredentials,
	getValidOcaCredentials: vi.fn(),
	getValidOpenAICodexCredentials: vi.fn(),
	loginClineOAuth: oauthMocks.loginClineOAuth,
	loginOcaOAuth: vi.fn(),
	loginOpenAICodex: vi.fn(),
	resolveDefaultMcpSettingsPath: vi.fn(),
	resolveClineDataDir: vi.fn(() => "/tmp/cline"),
	loadMcpSettingsFile: vi.fn(),
	resolveProviderConfig: llmsModelMocks.resolveProviderConfig,
	ClineAccountService: class {
		constructor(options: { apiBaseUrl: string; getAuthToken: () => Promise<string | undefined | null> }) {
			clineAccountMocks.constructedOptions.push(options);
		}
		fetchMe = clineAccountMocks.fetchMe;
		fetchBalance = clineAccountMocks.fetchBalance;
		fetchOrganizationBalance = clineAccountMocks.fetchOrganizationBalance;
		switchAccount = clineAccountMocks.switchAccount;
		fetchRemoteConfig = clineAccountMocks.fetchRemoteConfig;
		fetchOrganization = clineAccountMocks.fetchOrganization;
		fetchFeaturebaseToken = clineAccountMocks.fetchFeaturebaseToken;
	},
	ProviderSettingsManager: class {
		saveProviderSettings = oauthMocks.saveProviderSettings;
		getProviderSettings = oauthMocks.getProviderSettings;
		getLastUsedProviderSettings = oauthMocks.getLastUsedProviderSettings;
		getProviderConfig = vi.fn((providerId: string) => {
			const settings = oauthMocks.getProviderSettings(providerId);
			if (!settings) {
				return undefined;
			}
			return {
				providerId: settings.provider,
				apiKey: settings.apiKey,
				modelId: settings.model,
				baseUrl: settings.baseUrl,
			};
		});
		getFilePath = vi.fn(() => "/tmp/provider-settings.json");
		read = vi.fn(() => ({ providers: {} }));
		write = vi.fn();
	},
	Llms: {
		getAllProviders: llmsModelMocks.getAllProviders,
		getModelsForProvider: llmsModelMocks.getModelsForProvider,
		resolveProviderModelCatalogKeys: llmsModelMocks.resolveProviderModelCatalogKeys,
	},
	LlmsModels: {
		CLINE_DEFAULT_MODEL: "anthropic/claude-sonnet-5",
		getAllProviders: llmsModelMocks.getAllProviders,
		getModelsForProvider: llmsModelMocks.getModelsForProvider,
	},
	LlmsProviders: {
		supportsModelThinking: vi.fn(() => false),
	},
	InMemoryMcpManager: class {},
	createMcpTools: vi.fn(async () => []),
	DEFAULT_EXTERNAL_IDCS_CLIENT_ID: "",
	DEFAULT_EXTERNAL_IDCS_SCOPES: "",
	DEFAULT_EXTERNAL_IDCS_URL: "",
	DEFAULT_INTERNAL_IDCS_CLIENT_ID: "",
	DEFAULT_INTERNAL_IDCS_SCOPES: "",
	DEFAULT_INTERNAL_IDCS_URL: "",
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: vi.fn(),
}));

import { createClineProviderService } from "../../../src/cline-sdk/cline-provider-service";

function setSelectedProviderSettings(
	settings: {
		provider: string;
		model?: string;
		baseUrl?: string;
		apiKey?: string;
		headers?: Record<string, string>;
		timeout?: number;
		auth?: {
			accessToken?: string;
			refreshToken?: string;
			accountId?: string;
			expiresAt?: number;
		};
		reasoning?: { effort?: string; enabled?: boolean };
	} | null,
): void {
	oauthMocks.getLastUsedProviderSettings.mockReturnValue(settings ?? undefined);
	oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
		settings && settings.provider === providerId ? settings : undefined,
	);
}

describe("getProviderModels", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setSelectedProviderSettings({
			provider: "litellm",
			model: "gpt-5.4",
			baseUrl: "http://127.0.0.1:4000/v1",
		});
		localProviderMocks.getLocalProviderModels.mockResolvedValue({
			providerId: "litellm",
			models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("loads keyless LiteLLM model aliases from the saved Base URL models endpoint", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(
				JSON.stringify({
					data: [{ id: "litellm-test-alpha" }, { id: "litellm-test-beta" }, { id: "litellm-test-gamma" }],
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await createClineProviderService().getProviderModels("litellm");

		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:4000/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: {},
				signal: expect.any(AbortSignal),
			}),
		);
		expect(result.models.map((model) => model.id)).toEqual([
			"gpt-5.4",
			"litellm-test-alpha",
			"litellm-test-beta",
			"litellm-test-gamma",
		]);
	});

	it("uses LiteLLM model_name values from the model info endpoint", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = input.toString();
			if (url.endsWith("/models")) {
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}
			return new Response(JSON.stringify({ data: [{ id: "internal-id", model_name: "litellm-test-alias" }] }), {
				status: 200,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await createClineProviderService().getProviderModels("litellm");

		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"http://127.0.0.1:4000/v1/model/info",
			expect.objectContaining({
				method: "GET",
				headers: {},
				signal: expect.any(AbortSignal),
			}),
		);
		expect(result.models.map((model) => model.id)).toEqual(["gpt-5.4", "litellm-test-alias"]);
	});

	it("passes configured LiteLLM headers and a bounded timeout signal to model list requests", async () => {
		setSelectedProviderSettings({
			provider: "litellm",
			model: "gpt-5.4",
			baseUrl: "http://127.0.0.1:4000/v1",
			apiKey: "sk-test",
			headers: { "X-Proxy-Token": "proxy-token" },
			timeout: 30_000,
		});
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(JSON.stringify({ data: [{ id: "litellm-test-alpha" }] }), { status: 200 });
		});
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		vi.stubGlobal("fetch", fetchMock);

		await createClineProviderService().getProviderModels("litellm");

		expect(timeoutSpy).toHaveBeenCalledWith(2_500);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:4000/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: {
					Authorization: "Bearer sk-test",
					"X-Proxy-Token": "proxy-token",
				},
				signal: expect.any(AbortSignal),
			}),
		);
		timeoutSpy.mockRestore();
	});
});

describe("getClineAccountBalance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clineAccountMocks.constructedOptions = [];
	});

	it("returns all-null when no provider settings are configured", async () => {
		setSelectedProviderSettings(null);
		const service = createClineProviderService();
		const result = await service.getClineAccountBalance();
		expect(result).toEqual({ balance: null, activeAccountLabel: null, activeOrganizationId: null });
	});

	it("returns all-null when provider is not cline", async () => {
		setSelectedProviderSettings({ provider: "anthropic", apiKey: "sk-test" });
		const service = createClineProviderService();
		const result = await service.getClineAccountBalance();
		expect(result).toEqual({ balance: null, activeAccountLabel: null, activeOrganizationId: null });
	});

	it("returns all-null when no access token is present", async () => {
		setSelectedProviderSettings({ provider: "cline", auth: {} });
		const service = createClineProviderService();
		const result = await service.getClineAccountBalance();
		expect(result).toEqual({ balance: null, activeAccountLabel: null, activeOrganizationId: null });
	});

	it("returns personal balance when no active org", async () => {
		setSelectedProviderSettings({
			provider: "cline",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.fetchMe.mockResolvedValue({
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			organizations: [],
		});
		clineAccountMocks.fetchBalance.mockResolvedValue({
			balance: 5_000_000,
			userId: "user-1",
		});

		const service = createClineProviderService();
		const result = await service.getClineAccountBalance();

		expect(result).toEqual({
			balance: 5_000_000,
			activeAccountLabel: "Personal",
			activeOrganizationId: null,
		});
	});

	it("returns org balance when an active org exists", async () => {
		setSelectedProviderSettings({
			provider: "cline",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.fetchMe.mockResolvedValue({
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			organizations: [
				{ organizationId: "org-1", name: "Test Org", active: true, roles: ["admin"], memberId: "m-1" },
			],
		});
		clineAccountMocks.fetchOrganizationBalance.mockResolvedValue({
			balance: 26_617_620,
			organizationId: "org-1",
		});

		const service = createClineProviderService();
		const result = await service.getClineAccountBalance();

		expect(result).toEqual({
			balance: 26_617_620,
			activeAccountLabel: "Test Org",
			activeOrganizationId: "org-1",
		});
	});

	it("returns all-null without error when fetch fails and OAuth refresh is unavailable", async () => {
		setSelectedProviderSettings({
			provider: "cline",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.fetchMe.mockRejectedValue(new Error("Network error"));

		const service = createClineProviderService();
		const result = await service.getClineAccountBalance();

		// First call fails, OAuth refresh returns no settings, so service returns all-null (no error field).
		expect(result.balance).toBeNull();
		expect(result.activeAccountLabel).toBeNull();
		expect(result.activeOrganizationId).toBeNull();
	});
});

describe("getClineAccountOrganizations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clineAccountMocks.constructedOptions = [];
	});

	it("returns empty array when no provider settings", async () => {
		setSelectedProviderSettings(null);
		const service = createClineProviderService();
		const result = await service.getClineAccountOrganizations();
		expect(result).toEqual({ organizations: [] });
	});

	it("returns empty array for non-cline provider", async () => {
		setSelectedProviderSettings({ provider: "openai", apiKey: "sk-test" });
		const service = createClineProviderService();
		const result = await service.getClineAccountOrganizations();
		expect(result).toEqual({ organizations: [] });
	});

	it("returns organizations from profile", async () => {
		setSelectedProviderSettings({
			provider: "cline",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.fetchMe.mockResolvedValue({
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			organizations: [
				{ organizationId: "org-1", name: "Org A", active: true, roles: ["owner"], memberId: "m-1" },
				{ organizationId: "org-2", name: "Org B", active: false, roles: ["member"], memberId: "m-2" },
			],
		});

		const service = createClineProviderService();
		const result = await service.getClineAccountOrganizations();

		expect(result.organizations).toHaveLength(2);
		expect(result.organizations[0]).toEqual({
			organizationId: "org-1",
			name: "Org A",
			active: true,
			roles: ["owner"],
		});
		expect(result.organizations[1]).toEqual({
			organizationId: "org-2",
			name: "Org B",
			active: false,
			roles: ["member"],
		});
	});
});

describe("switchClineAccount", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clineAccountMocks.constructedOptions = [];
	});

	it("returns ok true on successful switch", async () => {
		setSelectedProviderSettings({
			provider: "cline",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.switchAccount.mockResolvedValue(undefined);

		const service = createClineProviderService();
		const result = await service.switchClineAccount("org-1");

		expect(result).toEqual({ ok: true });
		expect(clineAccountMocks.switchAccount).toHaveBeenCalledWith("org-1");
	});

	it("returns ok true when switching to personal (null)", async () => {
		setSelectedProviderSettings({
			provider: "cline",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.switchAccount.mockResolvedValue(undefined);

		const service = createClineProviderService();
		const result = await service.switchClineAccount(null);

		expect(result).toEqual({ ok: true });
		expect(clineAccountMocks.switchAccount).toHaveBeenCalledWith(undefined);
	});

	it("returns error on failure", async () => {
		setSelectedProviderSettings({
			provider: "cline",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.switchAccount.mockRejectedValue(new Error("Switch failed"));

		const service = createClineProviderService();
		const result = await service.switchClineAccount("org-1");

		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});
});

describe("ClinePass account and launch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clineAccountMocks.constructedOptions = [];
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("reads the account balance when ClinePass is selected", async () => {
		setSelectedProviderSettings({
			provider: "cline-pass",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.fetchMe.mockResolvedValue({
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			organizations: [],
		});
		clineAccountMocks.fetchBalance.mockResolvedValue({ balance: 5_000_000, userId: "user-1" });

		const result = await createClineProviderService().getClineAccountBalance();

		expect(result).toEqual({
			balance: 5_000_000,
			activeAccountLabel: "Personal",
			activeOrganizationId: null,
		});
	});

	it("reports the ClinePass account profile", async () => {
		setSelectedProviderSettings({
			provider: "cline-pass",
			auth: { accessToken: "test-token" },
		});
		clineAccountMocks.fetchMe.mockResolvedValue({
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
		});

		const result = await createClineProviderService().getClineAccountProfile();

		expect(result.profile).toEqual({
			accountId: "user-1",
			email: "test@example.com",
			displayName: "Test User",
		});
	});

	it("uses CLINE_API_KEY when ClinePass has no saved credentials", async () => {
		setSelectedProviderSettings({ provider: "cline-pass", model: "cline-pass/kimi-k3" });
		vi.stubEnv("CLINE_API_KEY", "env-cline-key");

		const result = await createClineProviderService().resolveLaunchConfig();

		expect(result.providerId).toBe("cline-pass");
		expect(result.modelId).toBe("cline-pass/kimi-k3");
		expect(result.apiKey).toBe("env-cline-key");
	});

	it("names ClinePass in the error when no credentials are configured", async () => {
		setSelectedProviderSettings({ provider: "cline-pass", model: "cline-pass/kimi-k3" });
		vi.stubEnv("CLINE_API_KEY", "");

		await expect(createClineProviderService().resolveLaunchConfig()).rejects.toThrow(/ClinePass/);
	});

	it("refreshes ClinePass through Cline identity OAuth", async () => {
		setSelectedProviderSettings({
			provider: "cline-pass",
			model: "cline-pass/kimi-k3",
			auth: {
				accessToken: "test-token",
				refreshToken: "refresh-token",
			},
		});
		oauthMocks.getValidClineCredentials.mockResolvedValue({
			access: "next-token",
			refresh: "next-refresh",
			expires: Date.now() + 60_000,
		});

		const result = await createClineProviderService().resolveLaunchConfig();

		expect(oauthMocks.getValidClineCredentials).toHaveBeenCalledWith(
			expect.objectContaining({ access: "test-token", refresh: "refresh-token" }),
			expect.objectContaining({ provider: "cline" }),
		);
		expect(result.providerId).toBe("cline-pass");
		expect(result.apiKey).toBe("workos:next-token");
	});

	it("signs ClinePass in through Cline OAuth", async () => {
		oauthMocks.loginClineOAuth.mockResolvedValue({
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 60_000,
		});

		await createClineProviderService().runOauthLogin({ providerId: "cline-pass" });

		expect(oauthMocks.loginClineOAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline",
			}),
		);
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline-pass",
				auth: expect.objectContaining({
					accessToken: "workos:new-access",
					refreshToken: "new-refresh",
				}),
			}),
			expect.anything(),
		);
	});

	it("signs usage-billing Cline in through Cline OAuth and keeps settings keyed by cline", async () => {
		oauthMocks.loginClineOAuth.mockResolvedValue({
			access: "cline-access",
			refresh: "cline-refresh",
			expires: Date.now() + 60_000,
		});

		await createClineProviderService().runOauthLogin({ providerId: "cline" });

		expect(oauthMocks.loginClineOAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline",
			}),
		);
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline",
				auth: expect.objectContaining({
					accessToken: "workos:cline-access",
					refreshToken: "cline-refresh",
				}),
			}),
			expect.anything(),
		);
	});

	it("refreshes usage-billing Cline through Cline identity OAuth", async () => {
		setSelectedProviderSettings({
			provider: "cline",
			model: "zai/glm-5.3",
			auth: {
				accessToken: "cline-token",
				refreshToken: "cline-refresh",
			},
		});
		oauthMocks.getValidClineCredentials.mockResolvedValue({
			access: "next-cline-token",
			refresh: "next-cline-refresh",
			expires: Date.now() + 60_000,
		});

		const result = await createClineProviderService().resolveLaunchConfig();

		expect(oauthMocks.getValidClineCredentials).toHaveBeenCalledWith(
			expect.objectContaining({ access: "cline-token", refresh: "cline-refresh" }),
			expect.objectContaining({ provider: "cline" }),
		);
		expect(result.providerId).toBe("cline");
		expect(result.apiKey).toBe("workos:next-cline-token");
	});
});

describe("Cline SDK catalog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		llmsModelMocks.resolveProviderModelCatalogKeys.mockImplementation((providerId: string) => [providerId]);
		llmsModelMocks.resolveProviderConfig.mockResolvedValue(undefined);
		localProviderMocks.getLocalProviderModels.mockResolvedValue({ models: [] });
	});

	it("includes SDK ClinePass in the catalog without remapping it to cline", async () => {
		setSelectedProviderSettings({ provider: "cline-pass", model: "cline-pass/kimi-k3" });
		llmsModelMocks.getAllProviders.mockResolvedValue([
			{
				id: "cline",
				name: "Cline Usage-Billing",
				defaultModelId: "anthropic/claude-sonnet-5",
				baseUrl: "https://api.cline.bot/api/v1",
				capabilities: ["oauth"],
				env: ["CLINE_API_KEY"],
			},
			{
				id: "cline-pass",
				name: "ClinePass",
				defaultModelId: "stealth/ox-alpha",
				baseUrl: "https://api.cline.bot/api/v1",
				capabilities: ["oauth"],
				env: ["CLINE_API_KEY"],
			},
		]);

		const result = await createClineProviderService().getProviderCatalog();
		const clinePass = result.providers.find((provider) => provider.id === "cline-pass");

		expect(clinePass).toEqual(
			expect.objectContaining({
				id: "cline-pass",
				name: "ClinePass",
				oauthSupported: true,
				enabled: true,
				defaultModelId: "stealth/ox-alpha",
			}),
		);
		expect(result.providers.some((provider) => provider.id === "cline")).toBe(true);
	});

	it("lists ClinePass models from the SDK catalog", async () => {
		setSelectedProviderSettings({ provider: "cline-pass" });
		llmsModelMocks.resolveProviderConfig.mockResolvedValue({
			knownModels: {
				"cline-pass/deepseek-v4-flash": {
					name: "DeepSeek V4 Flash",
					capabilities: ["reasoning"],
				},
				"cline-pass/glm-5.3": {
					name: "GLM 5.3",
					capabilities: ["reasoning"],
				},
			},
		});

		const result = await createClineProviderService().getProviderModels("cline-pass");

		expect(result.providerId).toBe("cline-pass");
		expect(result.models.map((model) => model.id)).toEqual(["cline-pass/deepseek-v4-flash", "cline-pass/glm-5.3"]);
	});
});

describe("resolveLaunchConfig reasoning effort", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		vi.stubEnv("CLINE_API_KEY", "env-cline-key");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each(["minimal", "max"] as const)("keeps SDK %s reasoning effort on launch config", async (effort) => {
		setSelectedProviderSettings({
			provider: "cline",
			model: "zai/glm-5.3",
			reasoning: { effort },
		});

		const result = await createClineProviderService().resolveLaunchConfig();

		expect(result.reasoningEffort).toBe(effort);
	});
});
