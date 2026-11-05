---
description: "Persistent Markdown memory for Hemi tools and the memory settings service."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-memory

English | [中文](README.zh.md)

## Summary

Mount the package in the agent preset for the memory tools. Mount `@deepseek-ai/dsh-hemi-memory/settings` at the Host root to serve the [Memory tab](../memory-ui/README.md). Both use the same files under `$DSH_HOME/hemi-memory/`.

## Automatic memory

Main agents load long-term memory, the scratchpad, and today's log for every proposed step. Successful compaction saves its handoff and the scratchpad into the daily log. Runtime closure waits for an auxiliary summary from the most recently used model. Each resumed runtime summarizes only new user conversation from that runtime. Blank runtimes, subagents, and plugin reconfiguration skip exit summaries.

| Field | Default | Effect |
|---|---|---|
| contextMaxBytes | 16384 | Maximum UTF-8 bytes of injected memory |
| summaryMaxInputBytes | 49152 | Maximum UTF-8 bytes of summary instruction and conversation text |
| summaryMaxOutputTokens | 1024 | Auxiliary model output limit |
| summaryTimeoutMs | 3500 | Summary preparation and dispatch deadline in milliseconds |

The request and outcome are recorded as `hemi-memory/summary-request` and `hemi-memory/summary-result`. The outcome includes provider-reported usage when available. A timeout, incomplete output, or storage failure produces a warning. Saved summaries appear in the daily log. The Hemi usage panel includes reported summary usage by model.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

Remote request and response fields are defined in [`src/remote.ts`](src/remote.ts).

## Model Experience

### Memory tool calls

#### What the model sees

The preset registers `memory_write`, `memory_read`, `memory_search`, and `memory_forget`. The read and search tools return stored text when called.

#### Token effect

Tool definitions occupy request tokens. Returned text adds tokens in the calling session.

#### KV Cache effect

The tool definitions stay stable for the preset. Tool results extend the session history. Editing a file does not rewrite earlier results.

### Automatic context and exit summary

#### What the model sees

The `hemi:memory` runtime context contains bounded saved Markdown. A separate exit request asks the latest model to retain decisions, lessons, unfinished work, and follow-ups. The exact auxiliary request is logged before dispatch.

#### Token effect

Memory context contributes input tokens. Exit summarization is a separate bounded request with its own output allowance.

#### KV Cache effect

Changed memory replaces its runtime context in the next request. Auxiliary summaries use an independent input, and their output changes subsequent daily-log context.

## Known Limitations and Deferred Work

- Memory files are local to the Harness home. Settings saves compare the loaded revision under the same write lock used by the tools. External editors do not participate in that lock.

Normal process shutdown has its own deadline. Forced termination can interrupt summarization. Conversation navigation alone does not end a resident runtime. Hemi summary events carry the ignorable marker so readers without the plugin can retain and skip them.

### Dev Note

None.
