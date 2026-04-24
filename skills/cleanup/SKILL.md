---
name: cleanup
description: Scan a project's JavaScript modules, CSS stylesheets, and referenced HTML to remove dead code, unused variables, unused selectors, stale comments, and empty files. Use when the user wants a real codebase cleanup that must account for cross-file references from JS, CSS, and HTML and finish with a concise cleanup report.
---

# Cleanup

Use this skill when the task is to remove code that is no longer used, tighten comments to match reality, and delete files that become empty after cleanup.

## Scope

- Read all project JavaScript, CSS, and HTML that can reference each other.
- Treat usage as cross-file, not file-local.
- Count references coming from:
  - ES module imports and exports
  - DOM queries and event wiring in JS
  - HTML `id`, `class`, `data-*`, inline module entrypoints, and asset references
  - CSS selectors referenced by HTML or set dynamically from JS
- Ignore generated or vendor code unless the user explicitly asks to clean it too.

## Workflow

1. Inventory the relevant files.
2. Build a reference map before editing:
   - JS symbols exported, imported, and called
   - DOM selectors used from JS
   - classes, ids, and data attributes used in HTML
   - CSS selectors, custom properties, and keyframes
3. Remove only code that is provably unused from repo-visible references.
4. Re-read surrounding comments after each cleanup area and fix or remove comments that no longer describe the code truthfully.
5. If a file becomes empty or functionally empty after cleanup, delete it.
6. Run the strongest available verification that does not invent new tooling.
7. Report exactly what was removed and how it was verified.

## Removal Rules

- Safe removals:
  - unused functions, constants, variables, imports, and exports
  - unreachable branches or stale compatibility code with no callers
  - CSS rules, selectors, custom properties, and keyframes with no remaining use
  - HTML hooks that only served removed code
- Be conservative with anything that could be runtime-discovered:
  - dynamic property access
  - string-built selectors
  - event names consumed indirectly
  - globals expected by the browser
- If usage is ambiguous, keep the code unless the user asked for aggressive cleanup.

## Comment Rules

- Keep comments only when they still add information that is not obvious from the code.
- Update comments when code behavior changed.
- Remove comments that describe deleted behavior, old constraints, or no-op implementation details.

## Verification

- Prefer project-native verification.
- If no automated tests exist, do targeted checks such as:
  - module parse or syntax checks
  - project search to confirm removed symbols or selectors are no longer referenced
  - build or dev startup only if the project already has such a command
- State clearly what could not be verified.

## Final Report

The final answer must include:

- files changed
- unused code removed
- comments corrected or removed
- files deleted because they became empty
- verification performed
- residual risks or ambiguous areas kept intentionally
