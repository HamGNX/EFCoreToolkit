# Changelog

## 0.1.0

- Added native MySQL reverse-engineering workflow.
- Added EF Core 6–10 helper selection with isolated, confirmed installation.
- Added safe two-pass table/view discovery and staged generation.
- Added enforced project-root generation with Windows-compatible layout, namespaces, and naming defaults.
- Added tracked translation of one root Windows config, including context-named config and renamer files; translated Windows source remains authoritative, while hand-authored CLI config wins.
- Added EF Core 6/7 adjacent-file renaming and EF Core 8–10 `-r` renaming, with change hashes for safe regeneration.
- Added version-aware rejection of Windows settings unsupported by pinned EF Core 6/7 helpers.
- Added Pomelo/Microting provider-family and major validation.
- Added target-framework, exact helper-build, and regeneration-version binding checks.
- Added encrypted workspace connection profiles and regeneration.
- Added redacted output, cancellation, path validation, exact overwrite confirmation, and no automatic obsolete-file cleanup.
- Added unit and Extension Host integration tests.
