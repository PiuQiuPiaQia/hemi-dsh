---
kind: upgrade-guide
description: "Hemi removes its built-in phone pairing service, settings page, and iOS companion source."
---

# Hemi removes built-in phone connections

English | [中文](guide.zh.md)

## Change

Hemi no longer includes its built-in phone connection settings, TLS listener, pairing API, or iOS companion source. The packages `@deepseek-ai/dsh-hemi-mobile-access` and `@deepseek-ai/dsh-hemi-mobile-access-ui` are removed. Previously paired Hemi companion apps cannot connect through this service.

Existing Sessions, Workspaces, credentials, and third-party plugin configuration remain unchanged. Third-party phone clients use their own connection and authentication setup; Hemi pairings do not transfer to them.

## Migration

1. If a custom profile patch names either removed package or targets the entry IDs `hemi-mobile-access` or `hemi-mobile-access-ui`, remove those entries before starting the upgraded application.
2. Stop using the Hemi iOS companion. Hemi Desktop preinstalls the original [dsh-pocket](https://github.com/shaobeichen/dsh-pocket) plugin; follow its pairing and network configuration for phone access. Existing plugin preferences are preserved, and Hemi pairings are not imported.
3. Restart Hemi and confirm that its built-in phone connection section is absent and existing Sessions still open. Verify any third-party connection separately; approve only trusted devices because remote agent access can modify files and execute commands.
