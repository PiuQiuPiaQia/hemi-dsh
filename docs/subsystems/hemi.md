# Hemi customizations

English | [中文](hemi.zh.md)

[Hemi plugins](../../packages/hemi/README.md) provide cross-session memory, backup, model access, role routing, saved SSH server references and approved-phone access to the same Host. Electron adapters belong to [customizations](../../packages/hemi/customizations/README.md); native subagents own waiting, cancellation and result delivery.

<a id="ssh-authentication"></a>
## SSH authentication

`hemiSshWorkspaces.followAuthentication` yields an initial snapshot and then coalesced snapshots of pending native OpenSSH askpass challenges, never responses. Each branded challenge id belongs to one Host authentication manager and one native invocation; it is single-use, not a saved server id or durable data. `kind` is an OpenSSH presentation hint, not a password or host-trust classification. The Host sets `canRemember` for eligible saved-endpoint password prompts; the Client does not infer it from `kind` or `prompt`. Render `prompt` as text.

```ts type-equiv
/** One single-use prompt owned by one authentication manager and one native askpass invocation. */
type SshAuthenticationChallengeId = Branded<'HemiSshAuthenticationChallengeId'>
```

```ts type-equiv
/** Native askpass presentation hint, not a password or host-trust classification. */
type SshAuthenticationPromptKind = 'input' | 'confirm' | 'notification'
```

```ts type-equiv
/** One pending native prompt. Its endpoint identifies the requested connection, including configured jump hosts. */
interface SshAuthenticationChallenge {
  readonly id: SshAuthenticationChallengeId
  readonly endpoint: Pick<SshEndpointArgs, 'host' | 'port' | 'username' | 'identityFile'>
  /** Exact bounded text supplied by OpenSSH; render as text, never HTML or terminal escapes. */
  readonly prompt: string
  /** Only SSH_ASKPASS_PROMPT=confirm/none select confirm/notification; every other prompt is input. */
  readonly kind: SshAuthenticationPromptKind
  /**
   * Whether the owning UI may offer to remember this prompt's answer for the exact endpoint.
   * True only for the target endpoint's own native OpenSSH password prompt while a credential store is active
   * and a saved server still matches the endpoint; every other prompt stays manual and unremembered.
   */
  readonly canRemember: boolean
}
```

`answerAuthentication(id, answer, signal)` consumes one active challenge without saving its response: a string answers OpenSSH, and `null` cancels that authentication. `answerAuthenticationAndRemember(id, answer, remember, signal)` accepts an explicit password-saving choice only when `canRemember` is true; cancellation never saves. A chosen password is committed through the Host credential provider only after authentication succeeds. Stale ids and ids from another manager return `hemi-ssh/authentication-expired`. Invalid responses return `hemi-ssh/invalid-input` without consuming the challenge. An already-cancelled submission has no effect. Responses never enter challenge snapshots or diagnostics.

Ending a challenge subscription does not cancel authentication. Cancelling the last pending operation before readiness terminates its authentication process; ready masters remain owned by the Host instance until connection loss or service unload. Cancelled login starts no requested directory or execution operation, but accepted first-host trust may remain in OpenSSH’s known-host file. The [SSH server service](../../packages/hemi/ssh-servers/README.md#use-this-package) owns endpoint reuse, authentication deadlines and trust requirements.

## SSH directory selections

`browseServer` validates an editor endpoint; `browseSavedFolders` checks a saved endpoint’s revision before connecting. Both return physical directory locations through read-only SSH commands, without remote Node or remote writes; an empty path resolves the remote home. `prepareServerFolder` prepares the bundled execution runtime, validates the physical directory and records immutable endpoint and deployment snapshots for ordinary Workspace admission. Runtime requirements belong to the [service](../../packages/hemi/ssh-servers/README.md#use-this-package).

Explicit-deployment operations also check `runtimeRevision`. Changed revisions refuse before contacting a replacement endpoint. Editing or deleting a saved connection does not rewrite existing execution-target snapshots.

```ts type-equiv
/** Saved endpoint and deployment revisions expected by one directory interaction. */
interface SshWorkspaceRevision {
  readonly serverRevision: string
  readonly runtimeRevision: string
}
```

```ts type-equiv
/** Read-only remote directory view; an empty requested path means the remote login directory. */
interface SshRemoteDirectory {
  readonly path: string
  readonly parentPath: string
  readonly directories: readonly { readonly name: string; readonly path: string }[]
}
```

```ts type-equiv
/** Directory names and physical location returned by the remote filesystem, never the Host picker. */
interface SshRemoteFolders extends SshRemoteDirectory {
  readonly revision: SshWorkspaceRevision
}
```

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

<a id="ctxhemimobileaccess--hemimobileaccess"></a>

### `ctx.hemiMobileAccess` — `HemiMobileAccess`

The mobile-access service. Remote methods manage pairing and the listener; the listener itself answers phones over TLS. Disposal closes the listener, disposes every device Peer, and clears pairing state without touching Host-side Sessions or agent work.

```ts cordis-catalog
/**
 * Current management state: listener status, bind candidates, the safe
 * invitation view, pairing rows, and approved devices.
 * @param signal - caller cancellation before the read.
 * @returns the authoritative state.
 * @throws RemoteError `hemi-mobile/unauthorized` from any Peer but the desktop browser owner Peer.
 */
@Remote async getState(signal: AbortSignal): Promise<MobileAccessState>

/**
 * Automatically bind the current LAN candidates; no client supplies a network address.
 * The group accepts traffic only after all binding and durable-port work succeeds.
 * @param signal - caller cancellation before lifecycle admission.
 * @returns committed listener state; failed starts close every acquired listener.
 * @throws RemoteError for no network, an existing listener, credential failure or a failed bind.
 */
@Remote async start(signal: AbortSignal): Promise<MobileAccessState>

/**
 * Stop the TLS listener: sockets and device Peers close and pending pairing
 * state clears. Host-side Sessions and accepted agent work keep running.
 * @param signal - caller cancellation before shutdown starts.
 * @returns the authoritative state after shutdown.
 */
@Remote async stop(signal: AbortSignal): Promise<MobileAccessState>

/**
 * Mint a new one-time invitation, replacing any live one. The complete
 * payload — including the token — is returned exactly once; management
 * state never repeats it.
 * @param signal - caller cancellation before minting.
 * @returns the invitation for the owner to transfer to the phone, plus state.
 * @throws RemoteError `hemi-mobile/not-listening` before the listener runs.
 */
@Remote async createInvitation(signal: AbortSignal): Promise<{ readonly invitation: MobileInvitation; readonly state: MobileAccessState }>

/**
 * Approve one pending pairing after comparing the six-digit code shown on
 * both screens. The device record — name, creation time, and the secret
 * hash — is durably written before the request publishes `approved`, so a
 * phone never observes an approval that did not persist.
 * @param requestId - pairing attempt identity.
 * @param code - six-digit verification code.
 * @param signal - caller cancellation before the durable write.
 * @returns the authoritative state.
 * @throws RemoteError `hemi-mobile/request-not-found`, `hemi-mobile/wrong-code`,
 * `hemi-mobile/device-limit`, or `hemi-mobile/credentials-unavailable`.
 */
@Remote async approve(requestId: MobileRequestId, code: string, signal: AbortSignal): Promise<MobileAccessState>

/**
 * Reject one pending pairing request; the phone observes `rejected` on its
 * next status poll.
 * @param requestId - pairing attempt identity.
 * @param signal - caller cancellation before the rejection.
 * @returns the authoritative state.
 * @throws RemoteError `hemi-mobile/request-not-found`.
 */
@Remote async reject(requestId: MobileRequestId, signal: AbortSignal): Promise<MobileAccessState>

/**
 * Revoke one approved device. The durable record is removed first, so new
 * requests fail authentication immediately; the device's Peer is then
 * disposed, closing its WebSocket. Already-accepted Host work is not recalled.
 * @param deviceId - approved device identity.
 * @param signal - caller cancellation before the revocation.
 * @returns the authoritative state.
 * @throws RemoteError `hemi-mobile/device-not-found` or `hemi-mobile/credentials-unavailable`.
 */
@Remote async revoke(deviceId: MobileDeviceId, signal: AbortSignal): Promise<MobileAccessState>
```

Source: [`packages/hemi/mobile-access/src/index.ts`](../../packages/hemi/mobile-access/src/index.ts)

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
 * Remove a saved subscription grant and the models selected through it.
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

Own explicit model connection probes and local Desktop introduction preferences.

```ts cordis-catalog
/**
 * Resolve native startup without consulting any provider or credential.
 * @returns workspace startup preferences, or undefined for native DSH startup.
 */
desktopStartup(): { mode: 'workspace'; localePreference: string | null } | undefined

/**
 * Read local introduction state while preserving completed legacy setup.
 * @returns completion from the local marker, saved model, or completed legacy introduction.
 */
@Remote desktopWelcome(): { readonly enabled: boolean; readonly completed: boolean }

/**
 * Acknowledge the local introduction without changing model connections or account state.
 * @returns after the completion marker is durably saved; failures retain the introduction.
 */
@Remote async completeDesktopWelcome(): Promise<void>

/**
 * Send a bounded request and check whether the model returns a test tool call.
 *
 * Concurrent probes have independent streams, deadlines and cancellation.
 * @param provider - configured provider ID.
 * @param model - model ID.
 * @param signal - cancellation propagated from the client; it aborts only this probe, which also carries its own 25-second deadline.
 * @returns whether the model returned the test tool call.
 * @throws if the caller is not the profile owner, or this probe fails or times out; no tools execute or history is written.
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
 * Save the root conversation's automatic routing effort and the default for new conversations.
 * @param agent - live root conversation whose routes use the choice.
 * @param effort - one of the four model-independent routing levels.
 * @param signal - cancellation checked before saving.
 * @returns after the settings pipeline confirms persistence.
 */
@Remote async setReasoningEffort(agent: Agent, effort: HemiRoutingEffort, signal?: AbortSignal): Promise<void>

/**
 * Save one root Session's routing mode and the default for new conversations. Only the root agent may
 * switch; enabling validates the main route and every configured role route
 * against the live LLM registry. The call resolves only after the settings
 * pipeline has persisted the preference — no optimistic success — and the
 * write is serialized after every earlier in-flight write of the same
 * Session, so concurrent switches land in call order. The mode flips in
 * memory at registration: an enable in flight routes nothing until it
 * settles, and in-flight requests plus accepted delegations keep their
 * routes either way. Re-selecting the saved mode refreshes new-conversation
 * defaults without suspending the current routing mode.
 * @param agent - exact live root whose tree receives the selection.
 * @param enabled - `true` selects auto routing, `false` returns to fixed.
 * @param signal - cancellation checked before the preference is written.
 * @throws when called by a descendant, validation fails, or the save fails.
 */
@Remote async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/hemi/routing/src/settings.ts`](../../packages/hemi/routing/src/settings.ts)

<a id="ctxhemisshservers--hemisshservers"></a>

### `ctx.hemiSshServers` — `HemiSshServers`

Durable CRUD under the Gateway's global-resource access policy.

```ts cordis-catalog
/**
 * Read the saved directory without contacting its hosts.
 * @param signal - Caller cancellation before the synchronous read.
 * @returns Saved server references in creation order.
 */
@Remote list(signal: AbortSignal): readonly SshServer[]

/**
 * Save a new server reference without modifying OpenSSH configuration.
 * @param input - Explicit server fields; no secrets or connection options.
 * @param signal - Cancellation before writing begins; an admitted durable write is not rolled back.
 * @returns The durable record and its initial revision.
 */
@Remote create(input: SshServerInput, signal: AbortSignal): Promise<SshServer>

/**
 * Replace a server only while its revision still matches the editor's copy.
 * @param id - Saved server identity.
 * @param revision - Revision loaded with that record.
 * @param input - Replacement fields.
 * @param signal - Cancellation before writing begins; an admitted durable write is not rolled back.
 * @returns The durable record with a new revision.
 * @throws RemoteError `hemi-ssh/credential-cleanup-failed` if the endpoint change is saved but its old password could not be cleared.
 */
@Remote update(id: SshServerId, revision: string, input: SshServerInput, signal: AbortSignal): Promise<SshServer>

/**
 * Remove a reference and its password when no saved connection shares that endpoint; SSH configuration and remote files stay untouched.
 * @param id - Saved server identity.
 * @param revision - Revision being removed; a changed record is refused.
 * @param signal - Cancellation before writing begins; an admitted durable write is not rolled back.
 * @returns Resolution after the removal is durable.
 * @throws RemoteError `hemi-ssh/credential-cleanup-failed` if the reference is removed but its password could not be cleared.
 */
@Remote removeServer(id: SshServerId, revision: string, signal: AbortSignal): Promise<void>

/**
 * Supply Host-only password operations to the authentication owner; no secret is part of the Remote API.
 * @returns operations bound to this directory's queue and optional credential provider.
 */
authenticationPasswords(): SshAuthenticationPasswordMemory

/**
 * Commit one password OpenSSH already accepted for an exact saved endpoint, on this service's write queue.
 * Host-side only; the value goes to the credential seam and never crosses to a Client.
 * The queued commit re-checks that a saved server still owns the endpoint, so a parallel removal cannot leave a rewritten orphan.
 * @param endpoint - exact endpoint fields the password authenticated.
 * @param nativeUser - login name the native password prompt printed.
 * @param password - the accepted value; never included in any failure.
 * @returns after the durable grant write.
 * @throws RemoteError `hemi-ssh/remember-failed` when no store is active, the write fails, or no saved server owns the endpoint.
 */
rememberPassword(endpoint: SshPasswordEndpoint, nativeUser: string, password: string): Promise<void>

/**
 * Drop a remembered password while the record still holds one specific rejected value, on this service's write queue.
 * A concurrently stored replacement value survives.
 * @param endpoint - exact endpoint fields.
 * @param password - the value a later native prompt proved wrong.
 */
forgetPassword(endpoint: SshPasswordEndpoint, password: string): Promise<void>
```

Source: [`packages/hemi/ssh-servers/src/index.ts`](../../packages/hemi/ssh-servers/src/index.ts)

<a id="ctxhemisshworkspaces--hemisshworkspaces"></a>

### `ctx.hemiSshWorkspaces` — `HemiSshWorkspaces`

Explicit deployments and verified remote directories under the Gateway's global-resource policy.

```ts cordis-catalog
/**
 * Follow native OpenSSH login prompts without including responses or stored passwords.
 * @param signal - calling UI lifetime; service unload ends this stream.
 * @returns current authentication challenges, including the initial snapshot.
 */
@Remote({ mode: 'stream' }) async *followAuthentication(signal: AbortSignal): AsyncIterable<readonly SshAuthenticationChallenge[]>

/**
 * Answer exactly one active login prompt without saving or logging its response.
 * @param id - active challenge identity received from the authentication stream.
 * @param answer - native response, or null to cancel; never a connection setting.
 * @param signal - caller cancellation before the response is accepted.
 */
@Remote // oxlint-disable-next-line typescript/require-await -- Preserve Promise rejection semantics for synchronous native prompt acceptance. async answerAuthentication(id: SshAuthenticationChallengeId, answer: string | null, signal: AbortSignal): Promise<void>

/**
 * Answer one native prompt with an explicit password-saving choice; successful authentication commits the opted-in password.
 * @param id - active challenge identity; only a challenge marked canRemember accepts a non-cancelled opt-in.
 * @param answer - native response, or null to cancel without saving.
 * @param remember - true saves the accepted password through DSH credentials; false keeps the response transient.
 * @param signal - caller cancellation before the response is accepted.
 * @returns after accepting the response, not a password-save receipt; a store failure rejects the awaiting connection operation.
 */
@Remote // oxlint-disable-next-line typescript/require-await -- Preserve Promise rejection semantics for synchronous prompt acceptance. async answerAuthenticationAndRemember( id: SshAuthenticationChallengeId, answer: string | null, remember: boolean, signal: AbortSignal, ): Promise<void>

/**
 * Read the explicit helper deployment without contacting the remote machine.
 * @param serverId - saved connection whose deployment to read.
 * @param signal - caller cancellation before reading.
 * @returns the saved deployment, or undefined until configured.
 */
@Remote getRuntime(serverId: SshServerId, signal: AbortSignal): SshSavedRuntime | undefined

/**
 * Save an explicit installed helper; this operation installs nothing and reads no key.
 * @param serverId - saved connection to configure.
 * @param revision - last observed deployment revision; omitted for initial configuration.
 * @param deployment - absolute remote artifact coordinates and verified digests.
 * @param signal - cancellation before the durable write starts.
 * @returns the durable deployment and its replacement revision.
 */
@Remote configureRuntime( serverId: SshServerId, revision: string | undefined, deployment: SshRuntimeDeployment, signal: AbortSignal, ): Promise<SshSavedRuntime>

/**
 * Prepare and verify the automatic helper runtime for one saved connection without user artifact input.
 * Re-verifying an unchanged saved deployment keeps its revision, so concurrent editors never invalidate each other.
 * @param serverId - saved connection to make ready.
 * @param serverRevision - endpoint revision loaded with that record.
 * @param signal - cancellation of probing, streaming and the verification connection.
 * @returns the durable deployment the connection is verified against.
 */
@Remote connectServer(serverId: SshServerId, serverRevision: string, signal: AbortSignal): Promise<SshSavedRuntime>

/**
 * Browse a not-yet-saved endpoint read-only over plain OpenSSH; no helper, remote runtime or remote write is involved.
 * @param input - editor connection fields; validated exactly like saving.
 * @param path - existing absolute remote directory, or empty for the remote login directory.
 * @param signal - cancellation of the one-shot OpenSSH command.
 * @returns remote directory names and physical location.
 */
@Remote browseServer(input: SshServerInput, path: string, signal: AbortSignal): Promise<SshRemoteDirectory>

/**
 * List directories of a saved connection read-only over plain OpenSSH.
 * @param serverId - saved connection to browse.
 * @param path - existing absolute remote directory, or empty for the remote login directory.
 * @param revision - endpoint and deployment revisions captured before browsing; checked before SSH starts.
 * @param signal - cancellation of the one-shot OpenSSH command.
 * @returns remote directory names and physical location.
 */
@Remote browseFolders(serverId: SshServerId, path: string, revision: SshWorkspaceRevision, signal: AbortSignal): Promise<SshRemoteFolders>

/**
 * Browse a saved connection read-only without requiring any prepared runtime; directory choice needs no remote Node.
 * @param serverId - saved connection to browse.
 * @param path - existing absolute remote directory, or empty for the remote login directory.
 * @param serverRevision - endpoint revision loaded with the record; a changed endpoint refuses before SSH starts.
 * @param signal - cancellation of the one-shot OpenSSH command.
 * @returns remote directory names and physical location.
 */
@Remote browseSavedFolders(serverId: SshServerId, path: string, serverRevision: string, signal: AbortSignal): Promise<SshRemoteDirectory>

/**
 * Open one directory of a saved connection end to end: prepare the runtime, then retain the immutable target.
 * The runtime requirement surfaces here, not during directory selection.
 * @param serverId - saved connection to open.
 * @param path - chosen absolute remote directory, or empty for the remote login directory.
 * @param serverRevision - endpoint revision loaded with the record; re-checked at both steps.
 * @param signal - cancellation of runtime preparation, verification and target persistence.
 * @returns a real directory and target, not a synthetic Workspace id.
 */
@Remote prepareServerFolder( serverId: SshServerId, path: string, serverRevision: string, signal: AbortSignal, ): Promise<SshDirectorySelection>

/**
 * Validate a physical folder and retain its immutable target reference for Workspace creation.
 * @param serverId - saved connection to open.
 * @param path - existing absolute remote directory, or empty for the remote login directory.
 * @param revision - successful browse revisions; mismatch refuses before contacting a replacement endpoint.
 * @param signal - cancellation before target persistence begins; an admitted write remains durable.
 * @returns a real directory and target, not a synthetic Workspace id.
 */
@Remote prepareFolder(serverId: SshServerId, path: string, revision: SshWorkspaceRevision, signal: AbortSignal): Promise<SshDirectorySelection>
```

Source: [`packages/hemi/ssh-servers/src/workspaces.ts`](../../packages/hemi/ssh-servers/src/workspaces.ts)
<!-- END GENERATED cordis-surface -->
