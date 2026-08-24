import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceMetadata,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import type {
	CreateAutoReviewReconcilerDependencies,
	TaskGitPromptTemplates,
} from "../../../src/server/auto-review-reconciler";
import { createAutoReviewReconciler } from "../../../src/server/auto-review-reconciler";
import type { WorkspaceMetadataMonitor } from "../../../src/server/workspace-metadata-monitor";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface StoredWorkspaceState {
	board: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	revision: number;
}

function createCard(overrides: Partial<RuntimeBoardCard> & { id: string }): RuntimeBoardCard {
	return {
		title: `Task ${overrides.id}`,
		prompt: `Do work for ${overrides.id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function createBoard(cardsByColumn: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const columnIds: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
	return {
		columns: columnIds.map((columnId) => ({
			id: columnId,
			title: columnId,
			cards: cardsByColumn[columnId] ?? [],
		})),
		dependencies: [],
	};
}

function findCardInBoard(
	board: RuntimeBoardData,
	taskId: string,
): { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, columnId: column.id };
		}
	}
	return null;
}

/**
 * In-memory stand-in for the workspace state files. `getWorkspaceState` and
 * `mutateWorkspaceState` mirror the read-modify-write semantics of
 * src/state/workspace-state.ts, including the revision bump on save and the
 * ability to refuse a save (`save: false`).
 */
function createWorkspaceStateStore(initial: StoredWorkspaceState) {
	const stored = initial;

	const toResponse = (): RuntimeWorkspaceStateResponse =>
		({
			repoPath: "/repo",
			statePath: "/repo/.cline",
			git: { root: "/repo", currentBranch: "main", defaultBranch: "main" },
			board: structuredClone(stored.board),
			sessions: structuredClone(stored.sessions),
			revision: stored.revision,
		}) as unknown as RuntimeWorkspaceStateResponse;

	return {
		stored,
		getWorkspaceState: async (): Promise<RuntimeWorkspaceStateResponse> => toResponse(),
		mutateWorkspaceState: async <T>(
			_cwd: string,
			mutate: (state: RuntimeWorkspaceStateResponse) => {
				board: RuntimeBoardData;
				sessions?: Record<string, RuntimeTaskSessionSummary>;
				value: T;
				save?: boolean;
			},
		): Promise<{ value: T; state: RuntimeWorkspaceStateResponse; saved: boolean }> => {
			const current = toResponse();
			const result = mutate(current);
			if (result.save === false) {
				return { value: result.value, state: current, saved: false };
			}
			stored.board = result.board;
			if (result.sessions) {
				stored.sessions = result.sessions;
			}
			stored.revision += 1;
			return { value: result.value, state: toResponse(), saved: true };
		},
	};
}

function createTaskWorkspaceMetadata(
	taskId: string,
	overrides: Partial<{ headCommit: string | null; changedFiles: number | null; exists: boolean }> = {},
) {
	return {
		taskId,
		path: `/repo/.worktrees/${taskId}`,
		exists: overrides.exists ?? true,
		baseRef: "main",
		branch: null,
		isDetached: true,
		headCommit: overrides.headCommit ?? null,
		changedFiles: overrides.changedFiles ?? null,
		additions: null,
		deletions: null,
		stateVersion: 1,
	};
}

function createWorkspaceMetadata(
	taskWorkspaces: ReturnType<typeof createTaskWorkspaceMetadata>[],
): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		taskWorkspaces: taskWorkspaces as RuntimeWorkspaceMetadata["taskWorkspaces"],
	};
}

function createFakeMonitor() {
	let metadata: RuntimeWorkspaceMetadata = createWorkspaceMetadata([]);
	const monitor: WorkspaceMetadataMonitor = {
		connectWorkspace: vi.fn(async () => metadata),
		updateWorkspaceState: vi.fn(async () => metadata),
		disconnectWorkspace: vi.fn(),
		disposeWorkspace: vi.fn(),
		close: vi.fn(),
	};
	return {
		monitor,
		setMetadata(next: RuntimeWorkspaceMetadata) {
			metadata = next;
		},
	};
}

function createFakeTerminalManager() {
	const writeInput = vi.fn(
		(_taskId: string, _data: Buffer) => ({ taskId: _taskId }) as unknown as RuntimeTaskSessionSummary,
	);
	return {
		writeInput,
		manager: { writeInput } as unknown as TerminalSessionManager,
	};
}

interface HarnessOptions {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	metadata?: RuntimeWorkspaceMetadata;
	promptTemplates?: TaskGitPromptTemplates;
	now?: () => number;
}

function createHarness(options: HarnessOptions) {
	const store = createWorkspaceStateStore({
		board: options.board,
		sessions: options.sessions ?? {},
		revision: 1,
	});
	const fakeMonitor = createFakeMonitor();
	if (options.metadata) {
		fakeMonitor.setMetadata(options.metadata);
	}
	const terminal = createFakeTerminalManager();
	const onBoardMutated = vi.fn();
	let staleSnapshot: RuntimeWorkspaceStateResponse | null = null;

	const dependencies: CreateAutoReviewReconcilerDependencies = {
		listWorkspaces: () => [
			{
				workspaceId: "ws-1",
				workspacePath: "/repo",
				terminalManager: terminal.manager,
			},
		],
		getWorkspaceState: async () => staleSnapshot ?? (await store.getWorkspaceState()),
		mutateWorkspaceState: store.mutateWorkspaceState,
		getPromptTemplates: async () =>
			options.promptTemplates ?? {
				commitPromptTemplate: "Commit the working changes onto {{base_ref}}.",
				openPrPromptTemplate: "Open a pull request against {{base_ref}}.",
				commitPromptTemplateDefault: null,
				openPrPromptTemplateDefault: null,
			},
		onBoardMutated,
		createMetadataMonitor: () => fakeMonitor.monitor,
		...(options.now ? { now: options.now } : {}),
		warn: vi.fn(),
	};

	const reconciler = createAutoReviewReconciler(dependencies);

	return {
		reconciler,
		store,
		terminal,
		onBoardMutated,
		fakeMonitor,
		setStaleSnapshot(snapshot: RuntimeWorkspaceStateResponse | null) {
			staleSnapshot = snapshot;
		},
		async evaluate() {
			await reconciler.evaluateWorkspace("ws-1");
		},
	};
}

describe("auto-review reconciler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("advances a review card with no browser client connected", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({
			board: createBoard({ review: [card] }),
			metadata: createWorkspaceMetadata([
				createTaskWorkspaceMetadata("task-1", { headCommit: "commit-1", changedFiles: 3 }),
			]),
		});

		await harness.evaluate();

		const armed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(armed?.columnId).toBe("review");
		expect(armed?.card.pendingGitAction).toEqual({
			action: "commit",
			requestedAt: expect.any(Number),
			headCommitAtRequest: "commit-1",
			attempt: 0,
		});
		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);
		const [promptTaskId, promptData] = harness.terminal.writeInput.mock.calls[0];
		expect(promptTaskId).toBe("task-1");
		expect(promptData?.toString("utf8")).toBe("Commit the working changes onto main.");

		// The submit keystroke follows the prompt after the paste settles.
		await vi.advanceTimersByTimeAsync(250);
		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(2);
		expect(harness.terminal.writeInput.mock.calls[1]?.[1]?.toString("utf8")).toBe("\r");

		// HEAD moves once the agent finishes the commit: the card completes.
		harness.fakeMonitor.setMetadata(
			createWorkspaceMetadata([createTaskWorkspaceMetadata("task-1", { headCommit: "commit-2", changedFiles: 0 })]),
		);
		await harness.evaluate();

		const completed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(completed?.columnId).toBe("trash");
		expect(completed?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.onBoardMutated).toHaveBeenCalled();
	});

	it("completes an armed card from persisted state after a runtime restart", async () => {
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: Date.now(),
				headCommitAtRequest: "commit-1",
				attempt: 0,
			},
		});
		const harness = createHarness({
			board: createBoard({ review: [armedCard] }),
			metadata: createWorkspaceMetadata([
				createTaskWorkspaceMetadata("task-1", { headCommit: "commit-2", changedFiles: 0 }),
			]),
		});

		// A fresh reconciler instance sees only the persisted arming state and
		// completes the action once HEAD has moved past the recorded commit.
		await harness.evaluate();

		const completed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(completed?.columnId).toBe("trash");
		expect(completed?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
	});

	it("does not sweep interrupted tasks or worktrees on boot", async () => {
		const interruptedCards = [
			createCard({ id: "task-1" }),
			createCard({ id: "task-2" }),
			createCard({ id: "task-3" }),
		];
		const sessions: Record<string, RuntimeTaskSessionSummary> = {};
		for (const card of interruptedCards) {
			sessions[card.id] = { taskId: card.id, state: "interrupted" } as unknown as RuntimeTaskSessionSummary;
		}
		const harness = createHarness({
			board: createBoard({ in_progress: interruptedCards }),
			sessions,
			metadata: createWorkspaceMetadata(
				interruptedCards.map((card) =>
					createTaskWorkspaceMetadata(card.id, { headCommit: "commit-1", changedFiles: 2 }),
				),
			),
		});

		await harness.evaluate();

		const boardAfter = harness.store.stored.board;
		for (const card of interruptedCards) {
			const found = findCardInBoard(boardAfter, card.id);
			expect(found?.columnId).toBe("in_progress");
		}
		expect(harness.store.stored.sessions).toEqual(sessions);
		// Three interrupted tasks in, three worktrees out: nothing was stopped,
		// restarted, trashed, or cleaned up.
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
		expect(harness.store.stored.revision).toBe(1);
		expect(harness.fakeMonitor.monitor.disposeWorkspace).not.toHaveBeenCalled();
	});

	it("starts exactly one git action when two evaluations race", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({
			board: createBoard({ review: [card] }),
			metadata: createWorkspaceMetadata([
				createTaskWorkspaceMetadata("task-1", { headCommit: "commit-1", changedFiles: 3 }),
			]),
		});

		// Both evaluations observed the unarmed board before either persisted the
		// arming state. The compare-and-set mutation must let only one through.
		const staleSnapshot = await harness.store.getWorkspaceState();
		harness.setStaleSnapshot(staleSnapshot);

		await Promise.all([harness.reconciler.evaluateWorkspace("ws-1"), harness.reconciler.evaluateWorkspace("ws-1")]);

		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);
		const armed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(armed?.card.pendingGitAction).not.toBeNull();
		expect(armed?.card.pendingGitAction?.attempt).toBe(0);
	});

	it("clears a pending git action once it goes stale", async () => {
		let currentTime = 1_000_000;
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: 0,
				headCommitAtRequest: "commit-1",
				attempt: 2,
			},
		});
		const harness = createHarness({
			board: createBoard({ review: [armedCard] }),
			metadata: createWorkspaceMetadata([
				createTaskWorkspaceMetadata("task-1", { headCommit: "commit-1", changedFiles: 0 }),
			]),
			now: () => currentTime,
		});

		// Just inside the staleness window the card stays armed.
		currentTime = 14 * 60_000;
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).not.toBeNull();

		// Past the window the stale arming state is cleared so the card can re-arm.
		currentTime = 16 * 60_000;
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
	});
});
