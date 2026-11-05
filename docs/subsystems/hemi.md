# Hemi customizations

English | [中文](hemi.zh.md)

[Hemi plugins](../../packages/hemi/README.md) provide cross-session memory, backup, model access and role routing. Electron adapters belong to [customizations](../../packages/hemi/customizations/README.md); native subagents own waiting, cancellation and result delivery.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhemibackup--hemibackupservice"></a>

### `ctx.hemiBackup` — `HemiBackupService`

Hemi backup orchestrator: settings, runs, retention, and staged restore, exposed to the client as the `hemiBackup` Remote namespace.

```ts cordis-catalog
/**
 * Read the client-safe state: settings, password presence, run flag, progress.
 * @returns current state view without secrets.
 */
@Remote async getState(): Promise<BackupStateView>

/**
 * Persist settings changes; a fresh password goes to the credential store.
 * @param input - partial settings plus an optional plaintext password.
 * @returns the state view after saving.
 */
@Remote async saveSettings(input: Partial<Omit<BackupSettings, 'lastRun'>> & { password?: string }): Promise<BackupStateView>

/**
 * Probe a target without saving it; the saved password is used when the
 * caller provides none.
 * @param target - target to probe; defaults to the saved one.
 * @returns success or a typed failure the UI can phrase.
 */
@Remote async testConnection(target?: (BackupTarget & { password?: string })): Promise<BackupOperationResult & { message?: string }>

/**
 * Run one backup now.
 * @returns the manifest summary on success or a typed failure.
 */
@Remote runNow(): Promise<BackupOperationResult & RunManifestSummary>

/**
 * List backup sets on the configured target, newest first.
 * @returns local sets directly and WebDAV sets through their manifests.
 */
@Remote async listBackups(): Promise<readonly BackupSetView[]>

/**
 * Delete one backup set; the name must be a plain backup-set name.
 * @param setName - set directory name on the target.
 * @returns success or a typed failure.
 */
@Remote async deleteSet(setName: string): Promise<BackupOperationResult>

/**
 * Stage one set and produce the restore preview; the staging stays until
 * applied or cancelled.
 * @param setName - set directory name on the target.
 * @returns the preview on success or a typed failure.
 */
@Remote async restorePrepare(setName: string): Promise<BackupOperationResult & { preview?: RestorePreview }>

/**
 * Apply the staged restore as a merge; displaced local files survive in a
 * unique safe-copy directory under the Harness home. Existing Session
 * generations remain in place; conflicting backup files are saved separately.
 * @returns the merge counts and safe-copy location on success.
 */
@Remote async restoreApply(): Promise<RestoreApplyResult>

/**
 * Discard the staged restore without touching live data.
 * @returns success or `NO_RESTORE` when nothing is staged.
 */
@Remote restoreCancel(): Promise<BackupOperationResult>
```

Source: [`packages/hemi/backup/src/service.ts`](../../packages/hemi/backup/src/service.ts)

<a id="ctxhemimemory--hemimemoryservice"></a>

### `ctx.hemiMemory` — `HemiMemoryService`

Read and edit the same Markdown files used by the memory tools.

```ts cordis-catalog
/**
 * Read one memory file. A missing file is an empty document.
 * @param target - memory store.
 * @param date - YYYY-MM-DD for a daily log.
 * @returns document content and the revision required to save it.
 */
@Remote async readStore(target: StoreTarget, date?: string): Promise<MemorySnapshot>

/**
 * Replace a memory file only if its content still matches the loaded revision.
 * @param target - memory store.
 * @param content - replacement Markdown.
 * @param revision - revision from readStore or the last successful save.
 * @param date - YYYY-MM-DD for a daily log.
 * @returns new revision, or null when the file changed before saving.
 */
@Remote async saveStore(target: StoreTarget, content: string, revision: string, date?: string): Promise<string | null>
```

Source: [`packages/hemi/memory/src/remote.ts`](../../packages/hemi/memory/src/remote.ts)

<a id="ctxhemimodelaccess--hemimodelaccess"></a>

### `ctx.hemiModelAccess` — `HemiModelAccess`

Reuse the adapter's authorization flow and credential record rather than storing another grant.

```ts cordis-catalog
/**
 * Available subscription sign-ins and redacted grant presence.
 * @returns registered subscription accounts, connection state and selected models.
 */
@Remote async subscriptions(): Promise<Subscription[]>

/**
 * Read the subscription model catalog; DeepSeek uses its native account adapter catalog.
 * @param provider - Configured subscription provider ID.
 * @param signal - Caller cancellation for authentication and model-list requests.
 * @returns available IDs; GLM uses the live Coding Plan catalog and DeepSeek retains native model admission.
 */
@Remote async subscriptionCandidates(provider: string, signal: AbortSignal): Promise<string[]>

/**
 * Read the models currently selected for a connected subscription.
 * @param provider - Subscription provider ID.
 * @param signal - Caller cancellation while the adapter reads its catalog.
 * @returns selected model IDs; an empty array also covers a signed-out account.
 */
@Remote async subscriptionModels(provider: string, signal: AbortSignal): Promise<string[]>

/**
 * Add or remove one model while retaining account authorization and other selections.
 * @param provider - Configured subscription provider ID.
 * @param model - Model ID within the selected provider.
 * @param add - True adds this model; false removes it while retaining authorization.
 */
@Remote async changeSubscriptionModel(provider: string, model: string, add: boolean): Promise<void>

/**
 * Start an authorization attempt using the catalog's registered OAuth method.
 * @param providerId - Registered subscription provider ID.
 * @returns the initial authorization state; subsequent progress is read through state().
 */
@Remote async start(providerId: string): Promise<LoginState>

/**
 * Return the current attempt without its credentials.
 * @returns the current authorization state without credentials, or null.
 */
@Remote state(): LoginState | null

/**
 * Answer only the prompt currently presented for the caller's attempt.
 * @param id - Exact operation, token or connection ID selected by the caller.
 * @param promptId - ID of the currently pending authorization prompt.
 * @param value - Caller-supplied value to inspect or submit.
 */
@Remote answer(id: string, promptId: string, value: string): void

/**
 * Cancel the exact pending attempt.
 * @param id - Exact operation, token or connection ID selected by the caller.
 */
@Remote cancel(id: string): void

/**
 * Remove only a saved subscription grant. Model profiles may also serve API-key connections.
 * @param provider - Configured subscription provider ID.
 */
@Remote async disconnect(provider: string): Promise<void>

/**
 * Get quota windows from the selected subscription account.
 * @param provider - Configured subscription provider ID.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns the selected account’s quota windows.
 */
@Remote async quota(provider: string, signal: AbortSignal): Promise<QuotaWindow[]>

/**
 * List the enabled New API tokens after proving the selected account identity.
 * @param login - Selected New API site identity and account credential.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns enabled account tokens eligible for explicit import.
 */
@Remote async listNewApi(login: NewApiLogin, signal: AbortSignal): Promise<NewApiToken[]>

/**
 * Read a selected token key and import its advertised models into Harness.
 * @param login - Selected New API site identity and account credential.
 * @param tokenId - Enabled New API token selected for import.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns the number of model routes imported.
 */
@Remote async importNewApi(login: NewApiLogin, tokenId: number, signal: AbortSignal): Promise<number>

/** Verify that the model store is ready before dispatching a New API token creation. */
@Remote checkNewApiBrowserImport(): void

/**
 * Read the durable commit result for a recovered native import operation.
 * @param operationId - Recoverable desktop operation ID.
 * @returns the saved operation receipt, or null when no committed import is found.
 */
@Remote async newApiBrowserReceipt(operationId: string): Promise<NewApiImportReceipt | null>

/**
 * Accept a validated model plan and key from the native import coordinator.
 * @param input - Validated draft or import plan including its optimistic settings revision.
 * @returns the committed model routes and durable import receipt.
 */
@Remote async commitNewApiBrowserImport(input: NewApiBrowserCommit): Promise<NewApiBrowserCommitResult>

/**
 * Read the Hemi API connection directory.
 * @returns the configured connections and their current settings revision.
 */
@Remote async keyDirectory(): Promise<KeyDirectory>

/**
 * Read explicit settings for one available model.
 * @param provider - Configured provider ID.
 * @param model - Available model ID.
 * @returns editable overrides, effective values and their optimistic settings revision.
 */
@Remote async getModelOptions(provider: string, model: string): Promise<ModelOptionsView>

/**
 * Read installed model capabilities before saving a draft connection.
 * @param api - Draft connection wire protocol.
 * @param model - Exact model id selected by the owner.
 * @param provider - Existing connection id when editing a saved connection draft.
 * @returns catalog capabilities or adapter fallback values for an unknown id.
 */
@Remote getModelDefaults(api: string, model: string, provider?: string): ModelOptions

/**
 * Save editable capabilities while retaining account and protocol configuration.
 * @param provider - Configured provider ID.
 * @param model - Available model ID.
 * @param options - Explicit overrides; omitted fields inherit adapter defaults.
 * @param revision - Settings revision observed when the editor opened.
 */
@Remote async saveModelOptions(provider: string, model: string, options: ModelOptions, revision: number): Promise<void>

/**
 * Read model IDs from a draft API connection.
 * @param input - Validated draft or import plan including its optimistic settings revision.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns the discovered model IDs, deduplicated and capped at 500.
 */
@Remote async discoverKeyModels(input: KeyProfileInput, signal: AbortSignal): Promise<string[]>

/**
 * Save one API connection.
 * @param input - Validated draft or import plan including its optimistic settings revision.
 */
@Remote async saveKeyProfile(input: KeyProfileInput): Promise<void>

/**
 * Remove one API connection.
 * @param id - Exact operation, token or connection ID selected by the caller.
 * @param revision - Settings revision observed when the edit began.
 */
@Remote async removeKeyProfile(id: string, revision: number): Promise<void>
```

Source: [`packages/hemi/model-access/src/index.ts`](../../packages/hemi/model-access/src/index.ts)

<a id="ctxhemimodelsettings--hemimodelsettings"></a>

### `ctx.hemiModelSettings` — `HemiModelSettings`

Probe a configured route with its actual adapter and saved credential.

```ts cordis-catalog
/**
 * Send a bounded request and check whether the model returns a test tool call.
 * @param provider - configured provider ID.
 * @param model - model ID.
 * @param signal - cancellation propagated from the client.
 * @returns whether the model returned the test tool call.
 */
@Remote async testModel(provider: string, model: string, signal: AbortSignal): Promise<boolean>
```

Source: [`packages/hemi/model-settings/src/index.ts`](../../packages/hemi/model-settings/src/index.ts)

<a id="ctxhemiroutingsettings--hemiroutingsettingsservice"></a>

### `ctx.hemiRoutingSettings` — `HemiRoutingSettingsService`

Settings namespace service and Remote owner for Hemi routing.

```ts cordis-catalog
/**
 * Read the configured main route as a detached copy.
 * @returns the route, or `null` while unconfigured.
 * @throws {HemiRoutingError} on malformed stored config.
 */
currentMain(): Route | null

/**
 * Read the canonical role table as a detached copy.
 * @returns routes per canonical role; absent roles are missing keys.
 * @throws {HemiRoutingError} on malformed or unknown stored role config.
 */
currentRoles(): RoleRoutes

/**
 * Effective routing mode of one root Session: the saved preference, with an
 * unsettled write already counting as its target's opposite — an auto exit
 * in flight or failed reads fixed, so no later claim re-selects the main
 * model underneath the user's recorded selection, and an enable that has
 * not settled yet routes nothing.
 * @param sessionId - exact root Session identity.
 * @returns the effective mode.
 */
modeOfSession(sessionId: SessionId): HemiRoutingMode

/**
 * Effective routing mode of the tree `agent` belongs to.
 * @param agent - exact live member of the tree.
 * @returns the root Session's effective mode.
 */
modeOf(agent: Agent): HemiRoutingMode

/**
 * Resolve the route a native role subagent hard-binds for `role`. Role
 * routing applies only when the turn was planned in auto mode and the
 * delegating step still runs in auto mode: a manual model selection between
 * steps switches later delegations to the selected route, while steps
 * already prepared and delegations already dispatched keep their routes.
 * Main and role routes come from the turn's plan; without a plan (for
 * example immediately after a host restart) the live values decide.
 * @param parent - exact live delegating agent.
 * @param role - preset role id.
 * @returns the bound route, or parent inheritance.
 */
routeForDelegation(parent: Agent, role: HemiRoleId): DelegationRoute

/**
 * Capture the routing mode of the step about to run, synchronously before
 * the step proceeds. Called from the preset plugin's `agent/pre-step`
 * listener for the root agent only; descendant and subagent trees route
 * nothing. Plans a resumed turn lazily and resolves the saved effort for
 * main and role models before admitting the step. Existing prepared calls
 * and accepted child tasks retain their captured routes.
 * @param agent - exact live root agent about to run one step.
 * @returns after the turn's effort mapping and main selection complete.
 */
async captureStep(agent: Agent): Promise<void>

/**
 * Fail-closed reason for the step about to run, or `null`. Auto mode with
 * no configured main blocks the model call instead of silently falling back
 * to a stale route, and a failed routing-mode write blocks until a manual
 * mode switch confirms the saved state.
 * @param agent - exact live member of the tree.
 * @returns why the next step must be rejected, or `null` to proceed.
 */
blockedReason(agent: Agent): string | null

/**
 * Plan one root's turn: capture the turn's mode/main/roles snapshot, and in
 * auto mode select the configured main model before the loop reads the
 * step's selection. The synchronous {@linkcode internalSelection} guard
 * marks the plugin's own selection so {@linkcode observeSelection} does not
 * mistake it for a user choice. Auto mode without a main records the plan
 * and selects nothing; the preset plugin then blocks the step.
 * @param root - exact live root agent of a non-subagent Session.
 */
prepareTurn(root: Agent): void

/**
 * Save the root conversation's automatic routing effort for later turns.
 * @param agent - live root conversation whose routes use the choice.
 * @param effort - one of the four model-independent routing levels.
 * @param signal - cancellation checked before saving.
 * @returns after the settings pipeline confirms persistence.
 */
@Remote async setReasoningEffort(agent: Agent, effort: HemiRoutingEffort, signal?: AbortSignal): Promise<void>

/**
 * Save one root Session's routing mode preference. Only the root agent may
 * switch; enabling validates the main route and every configured role route
 * against the live LLM registry. The call resolves only after the settings
 * pipeline has persisted the preference — no optimistic success — and the
 * write is serialized after every earlier in-flight write of the same
 * Session, so concurrent switches land in call order. The mode flips in
 * memory at registration: an enable in flight routes nothing until it
 * settles, and in-flight requests plus accepted delegations keep their
 * routes either way.
 * @param agent - exact live root whose tree receives the selection.
 * @param enabled - `true` selects auto routing, `false` returns to fixed.
 * @param signal - cancellation checked before the preference is written.
 * @throws when called by a descendant, validation fails, or the save fails.
 */
@Remote async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/hemi/routing/src/settings.ts`](../../packages/hemi/routing/src/settings.ts)
<!-- END GENERATED cordis-surface -->
