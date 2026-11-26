---
kind: upgrade-guide
description: "Hemi Desktop loads its bundled dsh-native-browser instead of a separately installed copy."
---

# Hemi Desktop ships `dsh-native-browser`

English | [中文](guide.zh.md)

## Change

Hemi Desktop used to load the browser plugin from the Desktop profile. It now uses the release's bundled copy when the plugin is enabled, even if a different version is installed in the profile. The upgrade leaves profile files, browser settings, and existing enable or disable choices intact.

## Migration

1. In Hemi Desktop, check that `dsh-native-browser` in **Plugins** has the desired switch state. To turn off browser control, switch off the bundle rather than uninstalling it.
2. On macOS, if an existing Chrome connection no longer works, open **Browser** in the sidebar of the installed app. Follow the prompts to sync the components, reload the Chrome extension, and check the connection. The status should show that Chrome is connected.
