# Changelog

## 0.2.0
- PlantUML renders in the browser with the official JS engine (no Java/Graphviz/server needed); server and JAR back ends are optional.
- Mermaid support: ```mermaid blocks, `![](x.mmd)` embeds and `.mmd`/`.mermaid` files.
- Full-text search across all listed files with jump to line (Ctrl/Cmd+K).
- Go unit tests, Playwright e2e tests, GitHub Actions CI and release workflows.
- Fix: minified single-line OpenAPI JSON is now detected.

## 0.1.0
- Initial version: Markdown, PlantUML and OpenAPI viewer/editor served from one Go binary.
