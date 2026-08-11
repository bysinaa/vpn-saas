# Phase 1 — Audit + Ponytail Cleanup

## Goal

Understand the real installer/CLI execution graph and remove dead or duplicate XUI/install infrastructure without changing business logic.

## Inspect

Focus on executable references in:

- `cli/`
- `cli/installer/`
- root and nested `*.sh`
- scripts/deploy/docker directories
- `package.json`
- Dockerfiles / compose
- systemd-related files
- env writers/validators
- XUI installer tests/build/bundle inputs

Documentation-only references do not prove runtime usage.

## Required work

For installer/XUI-related scripts and modules classify:

- active/canonical
- compatibility wrapper with real caller
- duplicate
- obsolete/legacy
- dead/unreferenced

Check imports/requires, shell calls, package scripts, Docker/CI/systemd usage before deleting.

Consolidate toward:

- one canonical XUI detector
- one canonical environment/config writer
- one runtime path for panel configuration
- minimal wrappers only where required by real callers

Remove dead `.sh` scripts and obsolete detector implementations after proof.

Do not broadly delete shell scripts unrelated to this task.

## Important known suspicion

Inspect current `auto-config` logic for accidental mapping of:

- panel port -> subscription port
- web base path -> subscription path

Do not fix via guesswork; Phase 2 owns the canonical discovery model, but record the bug and prevent obsolete code from remaining authoritative.

## Deliverables

Update `XUI-INSTALLER-STATE.md` with:

- canonical relevant files
- removed files + proof of no executable callers
- duplicate paths discovered
- risks deferred to later phases
- tests actually run

## Validation

Run targeted installer/unit/build checks affected by cleanup plus `git diff --check`.

## Stop condition

Phase 1 is complete when the installer execution graph is understandable, dead/duplicate code is removed safely, and Phase 2 has one clear implementation path.

Do not start Phase 2 in the same Codex run.
