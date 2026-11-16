# dsh-pocket source and license

English | [中文](README.zh.md)

Hemi redistributes the unmodified `dsh-pocket` npm package under its own [GPL-2.0 license](LICENSE). Hemi includes the complete upstream source archive, including client source and build scripts, in [source.tar.gz](source.tar.gz). [upstream.json](upstream.json) records the matching package version, source revision, archive digest, and npm integrity.

The CLI npm package carries this directory as `third-party/dsh-pocket`, so Desktop and SDK distributions retain it with the CLI. Desktop also mirrors it to `dsh/third-party/dsh-pocket`, alongside the installed plugin at `dsh/node_modules/dsh-pocket`. The source archive is supplied for inspection and modification; Hemi does not execute or rebuild it during application startup.

The [upstream project](https://github.com/shaobeichen/dsh-pocket) owns the implementation. Its license and copyright notices remain unchanged. Updating the bundled npm version also requires replacing the matching source archive and metadata; runtime preparation rejects a version or digest mismatch.
