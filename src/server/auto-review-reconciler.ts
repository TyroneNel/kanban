// Reconciles auto-review state inside the runtime instead of a browser tab.
//
// The browser implementation lived in a React effect and lost pending git
// actions on unmount, reload, or project switch. This module observes durable
// state (the board card's `pendingGitAction` field plus workspace metadata)
// and corrects the difference each cycle, so auto-review keeps running with
// no client connected and recovers armed cards after a restart.
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceMetadata,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { moveTaskToColumn } from "../core/task-board-mutations";
import type {
	RuntimeWorkspaceAtomicMutationResponse,
	RuntimeWorkspaceAtomicMutationResult,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	type CreateWorkspaceMetadataMonitorDependencies,
	createWorkspaceMetadataMonitor,
	type WorkspaceMetadataMonitor,
} from "./workspace-metadata-monitor";

/**
 * Mirrors `PENDING_GIT_ACTION_STALE_AFTER_MS` in web-ui/src/types/board.ts.
 * The arming state is shared between the runtime and the browser, so both
 * sides must agree on when an armed card is considered stranded.
 */
const AUTO_REVIEW_PENDING_STALE_AFTER_MS = 15 * 60_000;

/**
 * Delay between pasting the git action prompt into the task terminal and
 * submitting it, matching the choreography the browser used.
 */
const AUTO_REVIEW_INPUT_SUBMIT_DELAY_MS = 200;

const AUTO_REVIEW_BASE_REF_TOKEN = "{{base_ref}}";

export interface TaskGitPromptTemplates {
	commitPromptTemplate?: string | null;
	openPrPromptTemplate?: string | null;
	commitPromptTemplateDefault?: string | null;
	openPrPromptTemplateDefault?: string | null;
}

export interface AutoReviewWorkspace {
	workspaceId: string;
	workspacePath: string | null;
	terminalManager: TerminalSessionManager | null;
}

export type MutateWorkspaceState = <T>(
	workspacePath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
) => Promise<RuntimeWorkspaceAtomicMutationResponse<T>>;

export interface CreateAutoReviewReconcilerDependencies {
	listWorkspaces: () => AutoReviewWorkspace[];
	getWorkspaceState: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	mutateWorkspaceState: MutateWorkspaceState;
	getPromptTemplates: (workspaceId: string, workspacePath: string) => Promise<TaskGitPromptTemplates | null>;
	/**
	 * Notified after the reconciler mutates a board so connected browsers can
	 * resync. Optional: reconciliation is correct without it, browsers just
	 * observe the change later.
	 */
	onBoardMutated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	createMetadataMonitor?: (deps: CreateWorkspaceMetadataMonitorDependencies) => WorkspaceMetadataMonitor;
	now?: () => number;
	warn?: (message: string) => void;
}

export interface AutoReviewReconciler {
	/** Starts reconciling every workspace currently managed by the runtime. */
	start: () => Promise<void>;
	/** Ensures a newly tracked workspace is picked up without waiting for discovery. */
	trackWorkspace: (workspaceId: string) => void;
	/** Stops tracking a workspace that was removed from the runtime. */
	untrackWorkspace: (workspaceId: string) => void;
	/** Runs one reconciliation cycle for a workspace. */
	evaluateWorkspace: (workspaceId: string) => Promise<void>;
	close: () => void;
}

interface RuntimeTaskPendingGitAction {
	action: RuntimeTaskAutoReviewMode;
	requestedAt: number;
	headCommitAtRequest: string | null;
	attempt: number;
}

interface ReconcilerWorkspaceRuntime {
	evaluationPromise: Promise<void> | null;
	pendingEvaluation: boolean;
	monitorConnected: boolean;
	lastMetadata: RuntimeWorkspaceMetadata | null;
	gitActionInFlightTaskIds: Set<string>;
	submitTimers: Set<NodeJS.Timeout>;
}

function createWorkspaceRuntime(): ReconcilerWorkspaceRuntime {
	return {
		evaluationPromise: null,
		pendingEvaluation: false,
		monitorConnected: false,
		lastMetadata: null,
		gitActionInFlightTaskIds: new Set<string>(),
		submitTimers: new Set<NodeJS.Timeout>(),
	};
}

function resolveAutoReviewMode(card: RuntimeBoardCard): RuntimeTaskAutoReviewMode {
	return card.autoReviewMode === "pr" ? "pr" : "commit";
}

function isPendingGitActionStale(pending: RuntimeTaskPendingGitAction, now: number): boolean {
	return now - pending.requestedAt > AUTO_REVIEW_PENDING_STALE_AFTER_MS;
}

function resolvePromptTemplate(action: RuntimeTaskAutoReviewMode, templates: TaskGitPromptTemplates | null): string {
	if (action === "commit") {
		const template = templates?.commitPromptTemplate?.trim();
		if (template) {
			return template;
		}
		const defaultTemplate = templates?.commitPromptTemplateDefault?.trim();
		if (defaultTemplate) {
			return defaultTemplate;
		}
		return "Handle this commit action using the provided git context.";
	}
	const template = templates?.openPrPromptTemplate?.trim();
	if (template) {
		return template;
	}
	const defaultTemplate = templates?.openPrPromptTemplateDefault?.trim();
	if (defaultTemplate) {
		return defaultTemplate;
	}
	return "Handle this pull request action using the provided git context.";
}

function buildGitActionPrompt(
	action: RuntimeTaskAutoReviewMode,
	baseRef: string,
	templates: TaskGitPromptTemplates | null,
): string {
	return resolvePromptTemplate(action, templates).replaceAll(AUTO_REVIEW_BASE_REF_TOKEN, baseRef);
}

interface CardLocation {
	columnId: RuntimeBoardColumnId;
	card: RuntimeBoardCard;
}

function findCardLocation(board: RuntimeBoardData, taskId: string): CardLocation | null {
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.id === taskId) {
				return { columnId: column.id, card };
			}
		}
	}
	return null;
}

function replaceBoardCard(board: RuntimeBoardData, taskId: string, nextCard: RuntimeBoardCard): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => {
			if (!column.cards.some((card) => card.id === taskId)) {
				return column;
			}
			return {
				...column,
				cards: column.cards.map((card) => (card.id === taskId ? nextCard : card)),
			};
		}),
	};
}

export function createAutoReviewReconciler(deps: CreateAutoReviewReconcilerDependencies): AutoReviewReconciler {
	const workspaceRuntimes = new Map<string, ReconcilerWorkspaceRuntime>();
	let disposed = false;

	const monitor = (deps.createMetadataMonitor ?? createWorkspaceMetadataMonitor)({
		onMetadataUpdated: (workspaceId, metadata) => {
			const runtime = workspaceRuntimes.get(workspaceId);
			if (runtime) {
				runtime.lastMetadata = metadata;
			}
			void evaluateWorkspace(workspaceId);
		},
	});

	const getOrCreateRuntime = (workspaceId: string): ReconcilerWorkspaceRuntime => {
		const existing = workspaceRuntimes.get(workspaceId);
		if (existing) {
			return existing;
		}
		const created = createWorkspaceRuntime();
		workspaceRuntimes.set(workspaceId, created);
		return created;
	};

	const armPendingGitAction = async (
		workspacePath: string,
		taskId: string,
		action: RuntimeTaskAutoReviewMode,
		headCommitAtRequest: string | null,
		timestamp: number,
	): Promise<boolean> => {
		try {
			const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				if (!location || location.columnId !== "review" || location.card.autoReviewEnabled !== true) {
					return { board: currentState.board, value: "unavailable" as const, save: false };
				}
				const existing = location.card.pendingGitAction ?? null;
				if (existing && !isPendingGitActionStale(existing, timestamp)) {
					// Another actor already armed this card; the persisted field is the lock.
					return { board: currentState.board, value: "locked" as const, save: false };
				}
				const pendingGitAction: RuntimeTaskPendingGitAction = {
					action,
					requestedAt: timestamp,
					headCommitAtRequest,
					attempt: existing ? existing.attempt + 1 : 0,
				};
				return {
					board: replaceBoardCard(currentState.board, taskId, {
						...location.card,
						pendingGitAction,
						updatedAt: timestamp,
					}),
					value: "armed" as const,
				};
			});
			return response.value === "armed";
		} catch {
			return false;
		}
	};

	const clearPendingGitAction = async (workspacePath: string, taskId: string): Promise<boolean> => {
		try {
			const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				if (!location || (location.card.pendingGitAction ?? null) === null) {
					return { board: currentState.board, value: false, save: false };
				}
				return {
					board: replaceBoardCard(currentState.board, taskId, {
						...location.card,
						pendingGitAction: null,
						updatedAt: deps.now?.() ?? Date.now(),
					}),
					value: true,
				};
			});
			return response.value;
		} catch {
			return false;
		}
	};

	const completePendingGitAction = async (
		workspacePath: string,
		taskId: string,
		timestamp: number,
	): Promise<boolean> => {
		try {
			const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				if (!location || location.columnId !== "review") {
					return { board: currentState.board, value: false, save: false };
				}
				if (location.card.autoReviewEnabled !== true || !location.card.pendingGitAction) {
					return { board: currentState.board, value: false, save: false };
				}
				const moved = moveTaskToColumn(currentState.board, taskId, "trash", timestamp);
				if (!moved.moved || !moved.task) {
					return { board: currentState.board, value: false, save: false };
				}
				return {
					board: replaceBoardCard(moved.board, taskId, {
						...moved.task,
						pendingGitAction: null,
					}),
					value: true,
				};
			});
			return response.value;
		} catch {
			return false;
		}
	};

	const triggerGitAction = async (
		workspaceId: string,
		workspacePath: string,
		terminalManager: TerminalSessionManager,
		card: RuntimeBoardCard,
		action: RuntimeTaskAutoReviewMode,
		runtime: ReconcilerWorkspaceRuntime,
	): Promise<boolean> => {
		let templates: TaskGitPromptTemplates | null = null;
		try {
			templates = await deps.getPromptTemplates(workspaceId, workspacePath);
		} catch {
			// Fall back to the built-in prompt below.
		}
		const prompt = buildGitActionPrompt(action, card.baseRef, templates);
		let accepted: RuntimeTaskSessionSummary | null = null;
		try {
			accepted = terminalManager.writeInput(card.id, Buffer.from(prompt, "utf8"));
		} catch {
			accepted = null;
		}
		if (!accepted) {
			return false;
		}
		// Submit after the paste settles, mirroring the browser choreography.
		const submitTimer = setTimeout(() => {
			runtime.submitTimers.delete(submitTimer);
			try {
				terminalManager.writeInput(card.id, Buffer.from("\r", "utf8"));
			} catch {
				// The session died between prompt and submit; staleness clears the arming.
			}
		}, AUTO_REVIEW_INPUT_SUBMIT_DELAY_MS);
		submitTimer.unref();
		runtime.submitTimers.add(submitTimer);
		return true;
	};

	const reconcileWorkspace = async (
		workspace: AutoReviewWorkspace,
		workspacePath: string,
		state: RuntimeWorkspaceStateResponse,
		runtime: ReconcilerWorkspaceRuntime,
	): Promise<void> => {
		const timestamp = deps.now?.() ?? Date.now();
		const metadataByTaskId = new Map(
			(runtime.lastMetadata?.taskWorkspaces ?? []).map((taskWorkspace) => [taskWorkspace.taskId, taskWorkspace]),
		);
		let boardMutated = false;
		// Aborted mid-cycle when the workspace gets removed (project deletion or
		// shutdown); mutating a workspace that is being torn down could resurrect it.
		const stillTracked = (): boolean => workspaceRuntimes.has(workspace.workspaceId);

		for (const column of state.board.columns) {
			for (const card of column.cards) {
				const pendingGitAction = card.pendingGitAction ?? null;

				if (column.id !== "review") {
					// A card that left review while armed must not stay armed forever.
					if (pendingGitAction && stillTracked() && (await clearPendingGitAction(workspacePath, card.id))) {
						boardMutated = true;
					}
					continue;
				}

				if (card.autoReviewEnabled !== true) {
					if (pendingGitAction && stillTracked() && (await clearPendingGitAction(workspacePath, card.id))) {
						boardMutated = true;
					}
					continue;
				}

				const action = resolveAutoReviewMode(card);
				const taskMetadata = metadataByTaskId.get(card.id) ?? null;

				if (pendingGitAction) {
					if (isPendingGitActionStale(pendingGitAction, timestamp)) {
						if (stillTracked() && (await clearPendingGitAction(workspacePath, card.id))) {
							boardMutated = true;
						}
						continue;
					}
					// Completion is judged on evidence: HEAD moved past the commit
					// recorded at arming time. Zero changed files alone proves nothing.
					const headCommit = taskMetadata?.headCommit ?? null;
					if (headCommit !== null && headCommit !== pendingGitAction.headCommitAtRequest) {
						if (stillTracked() && (await completePendingGitAction(workspacePath, card.id, timestamp))) {
							boardMutated = true;
						}
					}
					continue;
				}

				const changedFiles = taskMetadata?.changedFiles ?? 0;
				// Review entries with zero changes (common during planning loops)
				// are intentionally ignored.
				if (changedFiles <= 0 || runtime.gitActionInFlightTaskIds.has(card.id) || !stillTracked()) {
					continue;
				}

				runtime.gitActionInFlightTaskIds.add(card.id);
				try {
					const armed = await armPendingGitAction(
						workspacePath,
						card.id,
						action,
						taskMetadata?.headCommit ?? null,
						timestamp,
					);
					if (!armed || !stillTracked()) {
						continue;
					}
					boardMutated = true;
					const triggered =
						workspace.terminalManager !== null &&
						(await triggerGitAction(
							workspace.workspaceId,
							workspacePath,
							workspace.terminalManager,
							card,
							action,
							runtime,
						));
					if (!triggered && stillTracked() && (await clearPendingGitAction(workspacePath, card.id))) {
						boardMutated = true;
					}
				} finally {
					runtime.gitActionInFlightTaskIds.delete(card.id);
				}
			}
		}

		if (boardMutated && stillTracked()) {
			try {
				await deps.onBoardMutated?.(workspace.workspaceId, workspacePath);
			} catch {
				// Broadcast is best-effort; the persisted board is already correct.
			}
		}
	};

	const evaluateWorkspaceOnce = async (workspaceId: string, runtime: ReconcilerWorkspaceRuntime): Promise<void> => {
		const workspace = deps.listWorkspaces().find((candidate) => candidate.workspaceId === workspaceId) ?? null;
		const workspacePath = workspace?.workspacePath ?? null;
		if (!workspace || !workspacePath) {
			monitor.disposeWorkspace(workspaceId);
			workspaceRuntimes.delete(workspaceId);
			return;
		}

		let state: RuntimeWorkspaceStateResponse;
		try {
			state = await deps.getWorkspaceState(workspace.workspaceId, workspacePath);
		} catch (error) {
			deps.warn?.(`Auto-review could not read workspace state for ${workspace.workspaceId}: ${String(error)}`);
			return;
		}
		// The workspace may have been untracked while its state was being read.
		if (!workspaceRuntimes.has(workspaceId)) {
			return;
		}

		let metadata: RuntimeWorkspaceMetadata | null = runtime.lastMetadata;
		if (!runtime.monitorConnected) {
			try {
				metadata = await monitor.connectWorkspace({
					workspaceId: workspace.workspaceId,
					workspacePath,
					board: state.board,
				});
				runtime.monitorConnected = true;
			} catch {
				metadata = null;
			}
		} else {
			// Refresh through the existing monitor so the evaluation always observes
			// the latest git metadata. updateWorkspaceState is cached by state token,
			// so this is a cheap read when nothing changed, and it re-syncs the
			// tracked task list with the current board.
			try {
				metadata = await monitor.updateWorkspaceState({
					workspaceId: workspace.workspaceId,
					workspacePath,
					board: state.board,
				});
			} catch {
				metadata = runtime.lastMetadata;
			}
		}
		if (metadata) {
			runtime.lastMetadata = metadata;
		}

		await reconcileWorkspace(workspace, workspacePath, state, runtime);
	};

	const evaluateWorkspace = async (workspaceId: string): Promise<void> => {
		if (disposed) {
			return;
		}
		const runtime = getOrCreateRuntime(workspaceId);
		// One evaluation chain per workspace. Late callers mark a pending cycle and
		// wait for the running chain, then run their own cycle, so every caller
		// observes a settled state.
		while (runtime.evaluationPromise) {
			runtime.pendingEvaluation = true;
			await runtime.evaluationPromise;
			if (disposed) {
				return;
			}
		}
		const chain = (async () => {
			do {
				runtime.pendingEvaluation = false;
				await evaluateWorkspaceOnce(workspaceId, runtime);
			} while (runtime.pendingEvaluation && !disposed);
		})()
			.catch((error) => {
				deps.warn?.(`Auto-review evaluation failed for ${workspaceId}: ${String(error)}`);
			})
			.finally(() => {
				runtime.evaluationPromise = null;
			});
		runtime.evaluationPromise = chain;
		await chain;
	};

	return {
		start: async () => {
			for (const workspace of deps.listWorkspaces()) {
				if (workspace.workspacePath) {
					void evaluateWorkspace(workspace.workspaceId);
				}
			}
		},
		trackWorkspace: (workspaceId: string) => {
			void evaluateWorkspace(workspaceId);
		},
		untrackWorkspace: (workspaceId: string) => {
			const runtime = workspaceRuntimes.get(workspaceId);
			if (runtime) {
				for (const timer of runtime.submitTimers) {
					clearTimeout(timer);
				}
			}
			workspaceRuntimes.delete(workspaceId);
			monitor.disposeWorkspace(workspaceId);
		},
		evaluateWorkspace,
		close: () => {
			disposed = true;
			for (const runtime of workspaceRuntimes.values()) {
				for (const timer of runtime.submitTimers) {
					clearTimeout(timer);
				}
				runtime.submitTimers.clear();
				runtime.gitActionInFlightTaskIds.clear();
			}
			workspaceRuntimes.clear();
			monitor.close();
		},
	};
}
