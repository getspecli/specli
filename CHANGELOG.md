# Changelog

## Unreleased
- Lint issues are highlighted in the editor (amber line background with the message as tooltip).
- The sidebar can be resized by dragging its right edge (double-click resets); the width is remembered.
- Spec status: a `status:` key in Markdown front matter (`draft`, `review`, `approved` or `stale`) shows as a coloured badge in the sidebar and the toolbar. Type `status:draft` (or just `status:`) in the sidebar filter to list files by status.
- Markdown lint: placeholder text (TODO, TBD, FIXME, XXX, lorem ipsum), empty sections and broken relative links are reported (the front matter `status` is shown but never linted, as statuses differ per company). The sidebar shows the issue count per file; the toolbar `⚠` button lists the issues of the open file and jumps to the line. Type `lint:` in the filter to list files with issues. Code blocks and inline code are ignored.
- Drag and drop in the sidebar: drag a file onto a folder (or the empty area for the top level) to move it, and drop files from your desktop to add them to the specs. Existing files are never overwritten. Disabled in read-only mode.
- Right-click in the sidebar opens a context menu (New file… and New folder… on folders and empty space): Copy, Paste (into the clicked folder), Duplicate, Rename and Delete (rename and delete use a dialog). Copies get a free name such as `a copy.md` and never overwrite files. Disabled in read-only mode.

## 0.5.0
- Git status: if a system `git` is installed and the served folder is in a repository, the sidebar footer shows the branch, ahead/behind and number of changed files, and files in the tree get an M/A/D/R/U/? marker. Click the footer row to open a changes dialog: review the changed files (jump to a file, tick which ones to include) and commit them with a message (Ctrl/Cmd+Enter). Only the ticked files are committed; other staged changes are left alone. The status refreshes every 5 s. Committing is disabled in read-only mode. Disable all git integration with `--no-git` / `SPECLI_NO_GIT=1`.
- "+ New" opens a styled dialog instead of the browser prompt: pick the file type (Markdown, PlantUML, Mermaid, CSV, TSV, OpenAPI, AsyncAPI, OpenAPI JSON), choose a folder from the existing ones, and see the resulting path before creating. New Markdown/API files get the file name as their title.

## 0.4.1
- AsyncAPI support: `.yaml`/`.yml`/`.json` files with a top-level `asyncapi:` key are listed and rendered (v2 and v3: servers, channels, operations, messages, schemas). New example `examples/asyncapi.yaml`.
- Folder names in the sidebar are no longer bold.

## 0.4.0
- Sidebar redesign: the black header is gone, the logo sits on the sidebar background (light and dark logo per theme) and the "+ New" button uses the accent colour.
- Folders start collapsed; opening a file (or a deep link) expands its parent folders.

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
