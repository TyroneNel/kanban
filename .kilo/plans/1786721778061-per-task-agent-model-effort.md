# Plan: Agent-agnostic per-task model & effort wiring (Close #431)

Branch: `feat/kanban-agent-per-task-agent-model` (builds on / supersedes commit `0bcd7d2`)

## Goal

Today a Kanban card can pin `agentId` for any agent, but per-task provider/model/effort overrides only work for Cline. Build the generic wiring so whatever model/effort/provider is set on a task is passed to whichever agent launches it — agent-agnostically.

## Design principle (read first)

**Wire mechanisms, not values.** Model IDs and valid effort vocabularies change too fast to encode anywhere in this repo. Do NOT hardcode model lists, alias tables, or per-agent effort-level enums in the schema, the catalog, the CLI, or the sidebar prompt. Kanban's job is the pipe: store opaque values on the card, carry them through the runtime, map them onto each agent's launch mechanism. Knowing *which* values are valid is the sidebar agent's job. Flag names and pass-through mechanisms are stable and belong in code; values never do.

## Verified architecture (confirmed against codebase)

1. **Sidebar agent mechanism.** No structured tool schema: normal agent session with appended system prompt (`renderAppendSystemPrompt()` in `src/prompts/append-system-prompt.ts`) teaching it to drive the board via the `kanban` CLI (`src/commands/task.ts`, all JSON output). ✔ confirmed
2. **Task schema.** `runtimeBoardCardSchema` in `src/core/api-contract.ts` has `agentId?: RuntimeAgentId` and `clineSettings?: { providerId?, modelId?, reasoningEffort? }` with effort constrained to a Cline enum (`low|medium|high|xhigh`). Legacy normalization exists (flat `clineProviderId/clineModelId/clineReasoningEffort` → `clineSettings`, api-contract.ts:109-169) — reuse the pattern. ✔ confirmed
3. **Two launch paths** in `startTaskSession` (`src/trpc/runtime-api.ts:168-295`):
   - `agentId === "cline"`: card `clineSettings` → `clineProviderService.resolveLaunchConfig(...)` → `clineTaskSessionService.startTaskSession(...)`. Already works — **leave consumption semantics untouched** (incl. the `clineSettings !== undefined` override marker and `reasoningEffortOverride` present-null vs absent distinction).
   - All other agents: `resolveAgentCommand(...)` → `terminalManager.startTaskSession` → `prepareAgentLaunch()` in `src/terminal/agent-session-adapters.ts`, dispatched on `ADAPTERS[input.agentId]`. `AgentAdapterLaunchInput` (agent-session-adapters.ts:28-41) carries **no** model/effort fields. This is the gap.
   - Precedence (comment at runtime-api.ts:185-197): persisted session agent on trash-restore > card `agentId` > workspace default; card settings always source of truth for settings. Keep that rule. ✔ confirmed
4. **Existing building blocks:** `hasCodexConfigOverride` (`src/terminal/codex-hook-config.ts:29`); `hasOpenCodeModelArg` / `normalizeOpenCodeModel` (agent-session-adapters.ts:898, 922); all adapters guard injection with `hasCliOption`. ✔ confirmed
5. **Agent catalog** is `src/core/agent-catalog.ts` (`RUNTIME_AGENT_CATALOG`, `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`; gemini/opencode cataloged but not launch-supported). Agent detection: `getCuratedDefinitions(runtimeConfig, detectedCommands)` in `src/terminal/agent-registry.ts:105-119` produces `installed`/`configured` per agent. ✔ confirmed
6. **Tests:** spec says follow `test/README.md` (`test/core`, `test/cli`, `test/integration`) — **actual layout is `test/runtime`, `test/integration`, `test/utilities`**; the README is outdated. Follow the actual layout; note the discrepancy (do not fix the README in this PR — out of scope). Vitest + Biome enforced.

## Decisions (resolved)

1. **Nested `agentSettings` object, not flat fields.** The Cline launch path relies on object presence as the override marker (`hasTaskLevelClineSettingsOverride = body.clineSettings !== undefined`; `resolveLaunchConfig` distinguishes key-present-null from key-absent for `reasoningEffortOverride`). Flat fields would need a separate marker boolean and reintroduce the #469-style inheritance bugs. Nested object with generalized name preserves semantics exactly.
2. **Rename `clineSettings` → `agentSettings` end-to-end** (schema, mutations, runtime-api, CLI, web-ui, tests). The name caused this scope miss; `agentSettings` on a codex task is self-documenting. TypeScript flags every reader (~40 src + ~94 web-ui sites).
3. **Opaque free strings for all three fields.** `reasoningEffort: z.string()` — NO enum (the previous enum plan was wrong; Claude Code alone has `ultracode`, droid levels are model-dependent, gemini uses `LOW|HIGH`). Validity is defined by the target agent at launch, not by Kanban.
4. **Backward compat: migrate outright, parse-time normalization only.** Transform accepts `agentSettings` (new) + `clineSettings` + flat legacy fields; precedence `agentSettings` > `clineSettings` > flat; output exposes only `agentSettings`. **No dual-write.** Precedent: the existing transform already parse-normalizes flat legacy fields without dual-writing. Downgrade caveat (old Kanban drops unknown `agentSettings` on next save) is accepted: fields are optional so old boards always load; upgrades/downgrades are whole-package. Document in PR description.
5. **CLI JSON output stays additive-only.** `formatTaskRecord` emits `agentSettings` verbatim (new, additive) AND keeps a deprecated `clineSettings` mirror (same object) so existing CLI consumers don't break. Remove the mirror in a later cleanup.
6. **No silent drops.** Nothing is stripped from the card based on agent. `providerId` is stored even when the agent can't use it (used by cline SDK path and opencode's `provider/model` composition; inert for others). The CLI emits a **stderr warning** when a set field has no mechanism for the explicitly named agent; at launch, adapters only map what their agent supports and kiro surfaces a visible session warning. Per spec constraint: "never a silent drop."
7. **Kiro = mechanism "none".** Spec is explicit (acceptance #5: task starts with visible "kiro ignores launch-time model" warning). Note: kiro.dev docs (July 2026) list `--effort` for `kiro-cli chat` and a kiro GitHub issue shows `--model` — spec author chose "none" regardless. Follow spec; record discrepancy in Open Questions for maintainers.
8. **Remove the 0bcd7d2 strip helpers entirely** (`resolveTaskClineSettingsForCreate/Update`) — no stripping happens at all now; warnings instead.
9. **Test layout:** use `test/runtime/...` per actual repo layout (spec's `test/core`/`test/cli` paths don't exist).

## Agent mechanism map (authoritative; verify at impl time, cite docs URL per adapter comment)

| Agent | modelOverride | effortOverride | Adapter mapping | Official CLI reference |
|---|---|---|---|---|
| claude | flag | flag | `--model <modelId>`, `--effort <reasoningEffort>` | https://code.claude.com/docs/en/cli-reference |
| codex | flag | config | `-m <modelId>`; effort via `-c model_reasoning_effort=<reasoningEffort>` (reuse `hasCodexConfigOverride` pattern) | https://developers.openai.com/codex/cli/reference |
| droid | flag | flag | `--model <modelId>`, `--reasoning-effort <reasoningEffort>` — **always long form**; `-r` means `--resume` in interactive chat mode | https://docs.factory.ai/droid-cli/cli-reference |
| gemini | flag | none | `-m <modelId>` | https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md |
| opencode | flag | none | `--model normalizeOpenCodeModel(providerId, modelId)`; if only `modelId` set, pass it through unprefixed (don't drop) | https://opencode.ai/docs/cli/ |
| kiro | none | none | no mapping; visible warning in session output if settings present | https://kiro.dev/docs/reference/cli-commands/ |
| cline | sdk | sdk | untouched; existing SDK path consumes providerId/modelId/reasoningEffort | n/a (SDK) |

## Work items

### 1. Schema: generic opaque per-task settings (`src/core/api-contract.ts`)
- `runtimeAgentSettingsSchema = z.object({ providerId: z.string().optional(), modelId: z.string().optional(), reasoningEffort: z.string().optional() })` — all opaque, no enums, no format validation.
- `agentSettings?: runtimeAgentSettingsSchema` on `runtimeBoardCardSchema`; extend the existing transform: accept `agentSettings` + legacy `clineSettings` + flat legacy fields; precedence `agentSettings` > `clineSettings` > flat; output only `agentSettings`.
- `runtimeTaskSessionStartRequestSchema`: `clineSettings` → `agentSettings` (internal tRPC, ships together, no alias).
- Rename type `RuntimeTaskClineSettings` → `RuntimeTaskAgentSettings`; drop `runtimeClineReasoningEffortSchema` from the card path (Cline SDK boundary `resolveLaunchConfig` keeps its own narrow effort type — runtime-api maps/passes string through; Cline SDK validates).
- **Tests** (`test/runtime/`): legacy `clineSettings` card parses to `agentSettings`; flat legacy fields parse; `agentSettings` wins when both present; arbitrary effort string (e.g. `"ultracode"`) accepted.

### 2. CLI: generic flags (`src/commands/task.ts`)
- `task create`/`task update` gain **`--provider`, `--model`, `--effort`** → `agentSettings.{providerId,modelId,reasoningEffort}`; generalize `buildTaskClineSettingsForCreate/Update` to `buildTaskAgentSettingsForCreate/Update` preserving existing `default`/`inherit` clearing semantics (`default` clears field / keeps empty-override marker; `inherit` on effort clears entirely).
- Keep `--cline-provider/--cline-model/--cline-reasoning-effort` as deprecated aliases (help text notes deprecation). Both forms of the same field passed together → clear error.
- **Remove** `resolveTaskClineSettingsForCreate/Update` (0bcd7d2). No stripping. Replace with stderr warnings only when `--agent-id` explicitly names an agent whose mechanism for a set field is `none` (kiro: model/effort) or provider set for an agent that never reads it (not cline/opencode). Warnings never fail the command.
- Fix `--agent-id` help text omission: `kiro` missing from the list.
- `formatTaskRecord`: emit `agentSettings` verbatim + deprecated `clineSettings` mirror (additive-only contract).
- `startTask` path passes `agentSettings: task.agentSettings` to `runtime.startTaskSession`.
- **Tests**: generic flags stored; aliases map; alias conflict error; `default`/`inherit` clearing; no warnings when flags omitted; kiro/provider warnings emitted on stderr; JSON output has both fields.
- Also update the task-command tests from 0bcd7d2 (`test/runtime/task-command.test.ts`) — strip-helper tests removed, replaced with warning/pass-through tests.

### 3. Launch wiring (`src/terminal/agent-session-adapters.ts` + call chain)
- `AgentAdapterLaunchInput` += `agentSettings?: { providerId?, modelId?, reasoningEffort? }` (opaque strings).
- Thread through: `runtime-api.ts` non-Cline branch → `StartTaskSessionRequest` (`session-manager.ts`) → `prepareAgentLaunch`.
- Per adapter, inject **before** positional prompt assembly (`withPrompt(..., "append")`), guarded by `hasCliOption` (user/workspace args win):
  - claude: `--model`, `--effort`
  - codex: `-m`; effort via `-c model_reasoning_effort=<v>` (reuse `hasCodexConfigOverride`; verify key name against docs at impl)
  - droid: `--model`, `--reasoning-effort` (long form only — `-r` is `--resume` in interactive mode)
  - gemini: `-m`
  - opencode: `--model` with `normalizeOpenCodeModel(providerId, modelId)` when providerId present; bare `modelId` otherwise; task value takes precedence over the config-derived preferred model (replace the `if (!hasOpenCodeModelArg(args))` block: task value first, else existing config resolution)
  - kiro: none; if any setting present, emit a visible warning line in the session output (impl detail: find the existing pattern for writing informational lines into the terminal session — session-manager listener broadcast / terminal state mirror — before spawn output)
  - cline: untouched (SDK path)
- **Above each mapping, add a comment with the URL of the agent's official CLI reference** used to choose flag names (per table above).
- Pass values verbatim: no normalization, aliasing, case-folding, or fallback defaults.
- **Session summary metadata**: `runtimeTaskSessionSummarySchema` += `modelId: z.string().nullable().default(null)`, `reasoningEffort: z.string().nullable().default(null)`. Non-Cline path: record card-derived values into the summary after `prepareAgentLaunch`. Cline path: record resolved `clineLaunchConfig.modelId`/`reasoningEffort`. Lets UI/sidebar agent see what a card actually launched with.
- **Tests**: per-agent argv assertions via `prepareAgentLaunch` with arbitrary sentinel values (opacity proof); no-duplicate when flag already in args; opencode precedence + unprefixed-only-modelId; kiro warning emitted; droid uses long forms (assert `-r` absent).

### 4. Mechanism registry (`src/core/agent-catalog.ts` + new `kanban agents` command)
- Add to `RuntimeAgentCatalogEntry` (mechanism-only; no value lists):
  ```ts
  capabilities: {
    modelOverride: "flag" | "config" | "sdk" | "none";
    effortOverride: "flag" | "config" | "sdk" | "none";
    docsUrl: string; // official CLI reference
  }
  ```
  Values per the mechanism map table.
- New `kanban agents` command (JSON, like other commands): per agent — `id`, `label`, `installed`, `configured`, `launchSupported`, `capabilities` (incl. `docsUrl`). Reuse `getCuratedDefinitions` (agent-registry.ts) for installed/configured. Register in `src/cli.ts` (or wherever commands register — `src/commands/`).
- **Tests**: command output shape; capabilities contain no value lists (assert no field is an array of strings besides known metadata).

### 5. Sidebar agent prompt (`src/prompts/append-system-prompt.ts`)
Update CLI Reference for `task create`/`task update` with new flags; rewrite the "Per-Task Agent and Model Overrides" section (added in 0bcd7d2) to encode **behavior, not data**:
- Map user-named agent/model/effort to `--agent-id`/`--provider`/`--model`/`--effort` at create/update.
- Before setting model/effort, run `kanban agents` to check the target agent's capabilities; if mechanism is `none`, warn the user and propose the nearest capable agent.
- You are expected to know current model names/effort vocabularies from your own knowledge; when uncertain or the user names something unrecognized, verify against the agent's official docs (`docsUrl` from `kanban agents`, or web research) **before** writing to the card. Never invent a model ID.
- **The prompt MUST NOT contain hardcoded model lists, model names, or effort-level tables** (self-check: if writing a model name into this file, stop). Point to `kanban agents` + official docs instead. This removes the concrete IDs introduced in 0bcd7d2 (e.g. `claude-sonnet-4-20250514`, `kimi-k2-0905-preview`, `moonshot` mapping table).
- After create/update, read the JSON response and confirm echoed `agentSettings` match the request; report mismatches.
- After `task start`, if the session errors because the agent rejected a model/effort value, surface the agent's own error and offer a corrected `task update` — Kanban does not second-guess values.
- Rerun flow: `task update --task-id <id> --model ... --effort ...` then `task start`.
- **Tests**: prompt contains new flags; prompt contains NO hardcoded model names or effort tables (assert absence of known model strings in the per-task section).

### 6. Web UI (secondary; split into follow-up PR if it grows)
- `BoardCard`/`TaskDraft`: `clineSettings` → `agentSettings`.
- `use-task-sessions.ts`: send `agentSettings`.
- `task-agent-model-picker.tsx`: free-text model + effort inputs (never dropdowns with baked-in values) for any agent with non-`none` mechanism, with a docs link (`capabilities.docsUrl`); Cline keeps existing provider/model selector; agent-switch rework: keep `modelId`/`reasoningEffort`, clear `providerId` when leaving cline/opencode; rename `preserveEmptyOverride`/`hasTaskClineSettingsOverride` (semantics unchanged).
- `use-task-editor.ts` state renames; all `task.clineSettings` readers (compiler-driven).
- Optionally surface `summary.modelId`/`reasoningEffort` in card detail (nice-to-have).
- **Tests**: picker free-text + visibility per mechanism; switch keeps model clears provider.

## Edge cases & failure modes
1. Legacy persisted boards → transform normalizes at parse; no file migration; old boards load unchanged (acceptance #7).
2. Both `agentSettings` and `clineSettings` in JSON → `agentSettings` wins.
3. `agentSettings: {}` empty override → Cline: override marker → `reasoningEffortOverride: null` (today's exact behavior); non-Cline: harmless no-op.
4. Invalid value for the effective agent → stored, passed verbatim, agent CLI's own error surfaced at start; sidebar agent instructed to surface it + offer corrected update. No Kanban-side rejection (acceptance #6).
5. Card stores effort for an agent without the mechanism (e.g. gemini) → stored, warned at write, ignored at launch; survives a later agent switch to a capable agent.
6. kiro with settings → starts fine, visible warning in session output (acceptance #5).
7. Resume from trash: settings re-read from card (unchanged mechanism, now includes non-Cline).
8. Update model on running task → applies next start (existing documented behavior).
9. Auto-started linked tasks flow through the same CLI `startTask` plumbing.
10. `hasCliOption` dedup: existing args win over card-derived flags.
11. droid `-r` ambiguity: long forms only (spec resolution).
12. `--agent-id default` (null): settings kept; workspace default agent resolution unchanged.
13. Home (sidebar) agent session: never receives per-task settings (verified: `use-home-agent-session.ts` passes none; runtime-api home paths resolve defaults only).
14. Downgrade: old Kanban version drops unknown `agentSettings` on next board save (zod strips unknown keys) — documented caveat; boards never fail to load (decision #4).

## Validation plan
Per task: `tsc --noEmit` + targeted `vitest run <file>`; biome check on touched files. End:
1. `npm run typecheck`; `npm run lint`
2. `npm run test:fast`, then full `npm run test` once (task-command-exit integration flakiness is known/pre-existing; re-run that file)
3. `npm run web:typecheck`; `npm run web:test`
4. Manual E2E (live runtime in git workspace): per agent create→list→start verifying argv (ps/terminal output): claude `--model/--effort`; codex `-m` + `-c model_reasoning_effort=`; droid long forms; gemini `-m`; opencode `--model provider/model` and bare-modelId case; kiro warning; cline regression (provider/model/effort unchanged); update/clear/switch flows.
5. Sidebar scenario: restart sidebar session; "create a task for Codex with GPT-5.5 and one for Claude Code Sonnet"; verify the agent runs `kanban agents`, sets flags, confirms echoed `agentSettings`; pass-through check with an unrecognized model name (stored verbatim, no rejection).

## Acceptance criteria (mirrors spec)
1. claude launches with `--model <m> --effort <e>`; unit test asserts argv via `prepareAgentLaunch` with sentinel values.
2. codex produces `-m <m>` + `-c model_reasoning_effort=<e>`; droid long-form `--reasoning-effort`; opencode `--model provider/model`.
3. `task update --model default` clears; next start launches without the flag.
4. `kanban agents` returns mechanism-only capabilities + docsUrl, no value lists; unit test asserts sidebar prompt has new flags and no hardcoded model names/effort tables.
5. kiro task starts with visible "kiro ignores launch-time model" warning.
6. Nonsense value stored + passed verbatim (test asserts pass-through).
7. Legacy `clineSettings` boards load unchanged; Cline SDK path untouched.
8. Existing suite passes; tests follow actual layout (`test/runtime`); Biome clean.

## Open questions
1. **Kiro discrepancy**: spec says mechanism `none` + warning; kiro.dev docs (July 2026) show `kiro-cli chat --effort` and a GitHub issue shows `--model`. Follow spec for this PR; flag for maintainers — kiro model/effort wiring can be added later by flipping capabilities + adapter mapping if the flags prove reliable in Kanban's launch context (kanban agent-config file + positional prompt).
2. **test/README.md layout mismatch** (says `test/core`/`test/cli`; actual `test/runtime`): follow actual layout; README fix is out of scope here.
3. Codex config key name `model_reasoning_effort` — verify against codex docs at impl time (cite in adapter comment).

## PR guidance
- Title: `feat: agent-agnostic per-task model and effort wiring (#431)`
- Description: root cause (two launch paths: Cline embedded via SDK vs external CLI adapters with no settings channel); state the wire-mechanisms-not-values principle explicitly (why no model/effort enums); note kiro limitation; downgrade caveat (no dual-write); web-ui pickers listed as follow-up if split. Closes #431.
