# Repository Guidelines

## Project Structure & Module Organization
This repository is a small static web app. The entry page is [`index.html`](/mnt/c/dev/city/index.html), shared styling lives in [`styles.css`](/mnt/c/dev/city/styles.css), and application logic is split under [`src/`](/mnt/c/dev/city/src). Use `src/ui/` for form and status interactions, `src/generator/` for deterministic map logic, `src/render/` for canvas drawing, and `src/lib/` for thin wrappers around third-party libraries. Keep the implemented step list aligned between [`src/generator/steps.js`](/mnt/c/dev/city/src/generator/steps.js) and [`GENERATION_STEPS.md`](/mnt/c/dev/city/GENERATION_STEPS.md). Each generation step belongs in its own numbered folder under `src/generator/`, with the folder name and the step file name both starting with the step number. If a step has multiple algorithms, keep one step entry file plus one numbered file per algorithm. Renumber folders and files whenever the canonical step order changes so the prefix always matches the step number. Shared behavior used by multiple steps belongs in helper files grouped by usage, for example graph traversal, river modeling, geometry, or map-model conversion helpers.

## Build, Test, and Development Commands
No build step is required. Run a simple local server for module-safe development:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`. There is no automated test runner yet, so validate changes by generating multiple maps, reusing the same seed to confirm deterministic output, and checking that Voronoi cells, sea fills, and step updates stay in sync.

## Coding Style & Naming Conventions
Use modern ES modules and keep code ASCII unless a file already requires otherwise. Prefer `const` and `let`, small pure functions, and descriptive camelCase names such as `generateCity` or `buildVoronoiDiagram`. Treat each generator step as a simple geometry function: step 1.1 starts from the seeded RNG, and each later step takes the exact output of the previous step. Through step 1.8, operate on point, vertex, edge, and cell geometry; from step 1.9 onward, operate only on lot, vertex, and segment geometry. Keep DOM wiring in `src/ui/`, rendering logic in `src/render/`, generator math in `src/generator/`, and third-party calls inside dedicated wrappers under `src/lib/`. Match the existing two-space indentation in HTML and CSS and consistent semicolon-free JavaScript style.

## Testing Guidelines
Manual verification is currently the project standard. Before submitting, check:

- same seed + same settings => same Voronoi map
- changed seed or parameters => visibly different cell layout
- form hover/focus updates the help panel
- selected water sides produce expected flooding from the correct borders
- generation steps match `GENERATION_STEPS.md`
- canvas layout remains usable on desktop and mobile widths

If you add automated tests later, place them beside the related module or under a top-level `tests/` directory and name files after the feature under test, for example `city-generator.test.js`.

## Commit & Pull Request Guidelines
Git history currently starts with short, imperative subjects such as `Initial commit`. Keep that pattern: concise imperative subject lines, optionally followed by a body for context. Pull requests should describe the user-visible change, note any deterministic-generation assumptions, include screenshots for UI or canvas changes, and list the manual checks performed.
