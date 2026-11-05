# Hemi fork rules

English | [中文](hemi-fork.zh.md)

These rules apply to Hemi feature migration, new features, components, configuration, and desktop integration. Their purpose is to keep Hemi code independently maintained and make upstream merges reviewable. Judge compliance by both the changes to upstream-owned files and the resulting behavior; moving code into another file alone does not remove an upstream dependency or a behavior change.

## Choose the implementation location

Use an existing plugin, slot, event, provider, or composition option first. Feature logic, components, styles, and feature state belong to their owning Hemi plugin under `packages/hemi/`. Keep the existing skin plugin in `packages/client/ui-hemi-skins/` and installable composition layers in `plugins/`; these existing locations do not authorize scattering new non-plugin customizations through upstream packages.

Non-plugin Hemi adapters and helpers belong in `packages/hemi/customizations/`. Expose a narrow module or named function for the caller to import. Separate Electron main-process, preload, Host, and browser imports; the directory is not permission to bypass package dependencies, compiler programs, or runtime restrictions. Do not copy an upstream service or its state merely to customize a component.

## Preserve native behavior

Implement only the behavior requested by the user. Migration, file relocation, or feature integration must not silently change DSH scheduling, waiting, cancellation, result delivery, queues, retries, permissions, or persistence. An independently requested behavior change remains separate from the mechanical move. Existing user authorization defines the scope; do not ask again merely because the change touches an upstream file.

For role-based model routing, bind the configured provider, model, and reasoning effort at the native child-creation extension point. Retain native startup receipts, independent activation lifetimes, and inbox completion notices. Adding synchronous waiting, parent-to-child cancellation, or direct-answer tool results is a separate behavior change, not a prerequisite for model routing.

## Keep upstream modifications narrow

When no existing extension can implement the requested behavior, add the smallest generic extension at its owning DSH module. Put Hemi-specific decisions, role tables, prompts, components, and state in the Hemi plugin. Shared DSH core code must not import Hemi business implementations or contain Hemi-specific branches. The Electron shell may import a narrow Hemi adapter while retaining sender authorization and startup/shutdown ownership.

Keep unconfigured or plugin-free behavior consistent with upstream unless the user explicitly requests otherwise. Preserve native validation and capability checks after resolving plugin-provided options. A new extension must not bypass authorization, cancellation before publication, or backend capability validation.

## Mark and record retained modifications

Each meaningful hand-written modification remaining in an upstream-owned file needs a nearby `Hemi fork:` comment stating its purpose and the non-obvious reason it must remain there. Link to the relevant [fork ledger](../../hemi-fork-changes.md#hemi-customization-isolation) entry when the explanation needs more space. One useful comment can cover a related block; do not annotate every line or replace an explanation with a marker alone.

Update the ledger when adding, moving, or removing an integration. Record the upstream files, owning Hemi feature or adapter, why an existing extension is insufficient, any intended behavior difference, actual verification, and what must be checked when merging upstream. When upstream provides an equivalent extension or fix, assess whether the local patch can be removed rather than carrying both implementations.

Generated catalogs, event-name inventories, and other generated files remain generator-owned. Change their owning declarations and regenerate; do not hand-edit generated output to hide a dependency or suppress a check.

## Verify the requested change

Preserve unrelated worktree changes and user data. Compare the actual upstream diff against the requested feature, including defaults and lifecycle behavior. Use the [repository validation policy](../../AGENTS.md#run-relevant-checks-locally) for the affected code, real composition, built paths, and recorded-session output; source tests alone do not establish installed-app behavior.

For documentation-only changes, check links, paired documents, and the diff without rebuilding the application. Report the remaining upstream modifications and the checks actually run, including failures or unverified paths. Code placement, explanatory comments, and the ledger must agree before describing the customization as isolated.
