# AGENTS: pkgm

Public repository for installing pkgx packages to local system paths.

## Core Commands

- `deno fmt --check .`
- `deno lint .`
- `deno check ./pkgm.ts`

## Always Do

- Preserve install/update/remove behavior compatibility.
- Add tests around CLI branch logic when changing `pkgm.ts`.
- Keep shim behavior and user-path logic explicit.

## Ask First

- Any change to default install locations or privilege assumptions.
- Backward-incompatible CLI behavior changes.

## Never Do

- Never silently change install target semantics.
- Never merge high-branching changes without added behavioral checks.
