# Changelog

## 0.3.9
- PlantUML errors are readable: a short message with the line number (e.g. a duplicated `@startuml` without `@enduml`, or a syntax error), with the diagram source shown below and the offending line highlighted.
- Opening a file starts at the top, or at the position where you left that file, instead of inheriting the previous file's scroll offset.

## 0.3.8
- PlantUML: `!include <archimate/Archimate>` works (the ArchiMate stdlib bundle is embedded and loaded on demand, no network access).
- Examples: new ArchiMate diagram (`examples/archimate.puml`).

## 0.3.7
- Click a PlantUML or Mermaid diagram in the preview to open it in a zoomable overlay (scroll/pinch to zoom, drag to pan, double-click or `0` to reset, `Esc` to close).

## 0.3.6
- Split view: the editor and preview scroll together.
- New `--check-update` flag reports whether a newer release exists.
- Easier update detection: the server prints a notice at startup, re-checks hourly (retries failures after 5 minutes), and the UI re-checks on tab focus and every 30 minutes.

## 0.3.5
- Release workflow: fix the Homebrew tap update writing empty checksums into the formula.

## 0.3.4
- Install with Homebrew: `brew install getspecli/tap/specli`. The release workflow updates the tap automatically.
- `--self-update` refuses to touch a Homebrew-managed binary and points to `brew upgrade specli`; the UI update notice does the same.

## 0.3.3
- The repository moved to the `getspecli` GitHub organization; the update check and self-update now use `getspecli/specli`.

## 0.3.2
- Markdown front matter is rendered as a key/value table.

## 0.3.1
- CSV/TSV files are listed and rendered as tables.

## 0.3.0
- `specli --self-update` installs the latest release (checksum-verified).
- The UI footer shows the version and a notice when a newer release is available (`--no-update-check` to disable).
- New logo (favicon, sidebar, empty state) and a redesigned, darker footer.
- Theme button in the toolbar: auto / light / dark.

## 0.2.0
- PlantUML renders in the browser with the official JS engine (no Java/Graphviz/server needed); server and JAR back ends are optional.
- Mermaid support: ```mermaid blocks, `![](x.mmd)` embeds and `.mmd`/`.mermaid` files.
- Full-text search across all listed files with jump to line (Ctrl/Cmd+K).
- Go unit tests, Playwright e2e tests, GitHub Actions CI and release workflows.
- Fix: minified single-line OpenAPI JSON is now detected.

## 0.1.0
- Initial version: Markdown, PlantUML and OpenAPI viewer/editor served from one Go binary.
