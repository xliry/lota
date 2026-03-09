# Desloppify Report: banteg/crimson

**Sloppy Score:** 14/100
**Date:** 2026-03-10
**Analyzed by:** Lota

## Overview

banteg/crimson is a high-fidelity reverse-engineered reimplementation of Crimsonland v1.9.93 (2003) in Python + raylib, with a parallel Zig runtime for performance-critical simulation. The project totals ~115K lines of source code (82K Python, 33K Zig) plus 37K lines of tests across 306 test files. It features comprehensive CI (lint, type checking, ast-grep custom rules, pytest), 100+ pages of documentation, and a custom differential testing harness for verifying behavioral parity against the original binary.

This is an exceptionally well-engineered codebase. The low sloppy score reflects genuine craftsmanship: zero TODOs/FIXMEs in source, only 3 type:ignore annotations, strong typing via msgspec structs, meticulous float32 parity discipline, and purpose-built ast-grep linting rules that enforce project-specific invariants.

## Top Findings

### 1. creatures.zig is a 6,500-line monolith with 72 functions
- **Severity:** Medium
- **File:** crimson-zig/src/runtime/creatures.zig:1
- **Issue:** At 6,513 lines and 72 functions, this single file handles creature state, AI updates, collision resolution, damage application, spawn slot management, and perk interactions. The `CreaturePool` struct and its methods cover the entire creature lifecycle in one flat namespace. While Zig's module system encourages larger files than typical OOP languages, this exceeds reasonable single-file scope and makes navigation difficult.
- **Fix:** Extract cohesive subsystems (AI movement, damage/combat resolution, perk-creature interactions) into sibling modules under `runtime/creatures/`, keeping `CreaturePool` as the orchestrator. The Python side already demonstrates this pattern with `creatures/spawn.py`, `creatures/runtime.py`, etc.

### 2. base_gameplay_mode.py is a 2,000-line god class with 138 methods
- **Severity:** Medium
- **File:** src/crimson/modes/base_gameplay_mode.py:1
- **Issue:** This file has 80+ import lines and 138 methods, acting as the central hub for all gameplay mode logic including input handling, simulation ticking, rendering, replay recording, LAN synchronization, perk menus, and game-over flow. The sheer surface area makes it hard to understand which methods belong to which concern.
- **Fix:** Extract rendering, replay recording, and LAN sync into composable helper classes or standalone functions. The file already delegates to `FixedStepClock`, `RollbackRuntime`, etc. — push more responsibilities into those delegates.

### 3. lighting_debug.py is 3,300 lines for a debug visualization
- **Severity:** Low
- **File:** src/crimson/debug_views/lighting_debug.py:1
- **Issue:** A debug view file that exceeds the size of most production game logic files. It defines 30+ constants, manages interactive light placement, shadow rendering, occlusion, temporal accumulation, and auto-diagnostics — essentially a standalone mini-application embedded in a debug view. While debug tooling can grow organically, this is harder to maintain than necessary.
- **Fix:** Factor the shadow rendering pipeline, light management, and auto-diagnostic harness into separate modules under `debug_views/lighting/`. This keeps the interactive view thin and makes the shadow renderer testable in isolation.

## Positive Highlights

This codebase demonstrates several practices rarely seen at this quality level in open-source game projects:

- **Zero TODOs/FIXMEs** — every known issue is tracked externally, not littered in source
- **Only 3 `type: ignore` annotations** across 82K lines of Python — exceptional type discipline
- **Custom ast-grep rules** (30+ rules) enforcing project-specific invariants like no raw float conversions, no getattr fallbacks, and no swallowed exceptions
- **Float32 bit-level parity** — constants are specified as exact IEEE 754 bit patterns (`0x40490FDB` for pi) to match the original binary's behavior
- **37K lines of tests** with differential replay verification against the original game binary
- **Comprehensive documentation** covering struct layouts, format specs, and algorithmic parity tracking
- **Clean architecture**: `grim/` engine layer cleanly separated from `crimson/` game logic; `msgspec` structs throughout instead of ad-hoc dicts

## Summary

banteg/crimson is one of the cleanest large-scale Python game projects in the open-source ecosystem. The main issues are concentrated file sizes in a few hot-path modules — a natural consequence of meticulous reverse engineering work where behavioral fidelity to the original binary takes priority over textbook decomposition. The Zig runtime mirrors this discipline with careful float32 narrowing and zero panics in game logic. At 14/100 sloppy, this codebase sets a high bar for what AI-assisted reverse engineering projects can achieve.

## Tweet Thread Draft
See campaigns/tweets/banteg-crimson.txt
