# Desloppify Report: banteg/crimson

**Strict Score:** 77.4/100
**Objective Score:** 76.1/100
**Date:** 2026-03-10
**Analyzed by:** Lota (desloppify v0.7.0 CLI)

## Overview

banteg/crimson is a high-fidelity reverse-engineered reimplementation of Crimsonland v1.9.93 in Python + raylib, with a parallel Zig runtime (`crimson-zig/`). The project spans **727 files, 132K LOC across 71 directories**, with 382 production source files and 306 test files. It uses modern Python 3.13+ with msgspec, structlog, typer, and raylib bindings.

## Scan Results

| Dimension | Health | Strict | Notes |
|-----------|--------|--------|-------|
| Code quality | 91.7% | 91.7% | Strong — 416 issues across 3,009 checks |
| Security | 96.5% | 96.5% | 116 issues in 713 files scanned |
| Duplication | 93.6% | 93.6% | 209 boilerplate clusters, 76 function clusters |
| File health | 81.2% | 81.2% | 116 structural issues, 10 overloaded directories |
| Test health | 12.3% | 12.3% | 325 untested production modules — biggest drag |

**Total mechanical issues:** 1,650
**Subjective dimensions assessed:** 20

## Scorecard Dimensions (Subjective)

| Dimension | Score | Key Finding |
|-----------|-------|-------------|
| AI generated debt | 90% | Hand-written code, no AI boilerplate detected |
| Cross-module arch | 85% | Import linter contracts enforce boundaries; one grim→crimson exception |
| Authorization consistency | 88% | Network protocol has proper handshake/version checking |
| Package organization | 83% | Well-organized but screens/panels/ has 11+ flat panel modules |
| Naming quality | 82% | Strong domain vocabulary; duplicated _now_ms() helpers |
| High-level elegance | 82% | Clean sim/render/net separation enforced by import linter |
| Abstraction fitness | 80% | loop_view.py mixes view dispatch, shaders, and transitions |
| Convention drift | 80% | Mixed constant visibility conventions (_UPPER vs UPPER) |
| Design coherence | 80% | Consistent msgspec.Struct usage with minor pattern variations |
| Mid-level elegance | 78% | replay.py (1,615 LOC) and loop_view.py are oversized |
| Dependency health | 78% | Minimal, well-chosen deps; _now_ms() duplicated across net modules |
| Contract coherence | 77% | WorldState.step() has implicit ordering requirements |
| API coherence | 76% | CLI exposes internal callbacks; some packages over-export |
| Type safety | 75% | cast(Type, None) workarounds hide runtime None in typed fields |
| Low-level elegance | 74% | Effective structs but many-parameter functions |
| Initialization coupling | 72% | WorldState.build() takes 5 loosely-related params; lazy imports |
| Error consistency | 70% | Network uses error strings on structs vs exceptions in CLI |
| Incomplete migration | 70% | creatures/ docstring says "ongoing port"; preserve_bugs flag threaded through |
| Test strategy | 65% | 306 test files but 12.3% health — network/sim coverage gaps |

## Top Findings

### 1. Test health is the dominant weakness (12.3%)
- **Impact:** -5.85 pts on overall score
- **Issue:** 325 production modules lack test coverage. Network runtime modules (lockstep, rollback) are complex stateful systems with limited tests.
- **Fix:** Prioritize integration tests for network protocol state machines using mock transports.

### 2. cast(None) anti-pattern in network runtime
- **Severity:** High
- **Files:** `src/crimson/net/rollback_runtime.py`, `src/crimson/net/lockstep_runtime.py`
- **Issue:** `transport: RelayUdpTransport = cast(RelayUdpTransport, None)` — fields typed as non-optional but initialized to None, creating runtime type safety gaps.
- **Fix:** Use `Optional[RelayUdpTransport]` with None default or restructure initialization.

### 3. loop_view.py is a mixed-concern monolith
- **Severity:** Medium
- **File:** `src/crimson/game/loop_view.py`
- **Issue:** Contains GLSL shader source strings, global mutable shader state, gamma correction, view dispatch, and screen transitions in one module.
- **Fix:** Extract shader/gamma management into render utilities.

### 4. Incomplete migration signals
- **Severity:** Medium
- **Files:** Multiple modules
- **Issue:** `preserve_bugs: bool = False` parameter threaded through WorldState, lockstep, and rollback configs. Creature module docstring: "This package will grow as we port creature_* logic from the original binary."
- **Fix:** Document which bugs are preserved and plan to remove the flag.

### 5. Error strategy inconsistency
- **Severity:** Medium
- **Files:** Network vs CLI modules
- **Issue:** RollbackRuntime uses `error: str = ""` field pattern while CLI uses standard Python exceptions.
- **Fix:** Unify error handling approach across boundaries.

## Positive Highlights

- **Import linter contracts** enforce architectural boundaries between grim/crimson and within perk subsystem
- **Zero AI-generated debt** — code shows deep domain understanding and consistent hand-written style
- **Excellent security posture** at 96.5% — rare for a game project
- **Strong code quality** at 91.7% with msgspec structs throughout
- **Modern tooling**: ruff, ty type checker, pytest with syrupy snapshots, import-linter
- **Clean package architecture**: 71 directories with clear domain separation

## Summary

banteg/crimson scores **77.4/100 strict** — a strong result for a 132K LOC game project. The codebase demonstrates genuine craftsmanship with enforced architectural boundaries, modern Python tooling, and minimal AI debt. The main drag is test coverage at 12.3%, which alone accounts for most of the score gap. The subjective review found solid fundamentals with room for improvement in error consistency, type safety around initialization patterns, and completing the ongoing migration from the original binary. This is a well-maintained project that would benefit most from test investment and cleaning up a few structural hotspots.
