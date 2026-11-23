# specli

Browser viewer/editor for spec-driven design artifacts, started from the CLI.
One self-contained binary (frontend embedded), no runtime needed.

| Format | View | Edit |
|---|---|---|
| Markdown (`.md`) | rendered, with inline ```` ```plantuml ```` / ```` ```mermaid ```` blocks, `![](x.puml)` / `![](x.mmd)` embeds, links between spec files | CodeMirror |
| PlantUML (`.puml`, `.plantuml`, `.pu`, `.iuml`, `.wsd`) | SVG, live | CodeMirror |
| Mermaid (`.mmd`, `.mermaid`) | SVG, live, syntax errors shown | CodeMirror |
| OpenAPI / Swagger (`.yaml`, `.yml`, `.json`) | Swagger UI (try-it-out disabled), live, parse errors shown | CodeMirror |

Search: type in the sidebar box (`Ctrl/Cmd+K`) to filter file names and search all text; clicking a hit opens the file
at that line.

```
specli [directory] [--port 4747] [--no-open] [--readonly]
         [--plantuml-server URL | --plantuml-jar PATH] [--include-data]
```

## Diagram rendering

PlantUML and Mermaid are rendered **inside the browser**, nothing to install and nothing leaves your machine:

- PlantUML uses the official engine compiled to JavaScript (`@plantuml/core`, MIT since 1.2026.6) with Graphviz as
  WebAssembly. It is the upstream project's "beta" JS build, so exotic diagrams or some `!include`/stdlib sprites can
  differ from the Java version.
- Mermaid uses the `mermaid` package in `strict` security mode with plain SVG labels.

If you need full Java fidelity, point specli at a real renderer instead (still optional):

1. `--plantuml-server URL` (env `SPECLI_PLANTUML_SERVER`): HTTP endpoint that takes the diagram as POST body and
   returns SVG, e.g. Kroki `http://kroki:8000/plantuml/svg` or plantuml-server `http://localhost:8080/svg`.
2. `--plantuml-jar PATH` (env `SPECLI_PLANTUML_JAR`): runs `java -jar PATH -pipe -tsvg` (Graphviz needed for
   non-sequence diagrams).

## Behaviour worth knowing

- Binds to `127.0.0.1` only (CSP allows only same-origin scripts plus WebAssembly for Graphviz). Host and Origin headers are checked (DNS rebinding / cross-site writes). A non-loopback
  `--host` forces `--readonly`.
- Paths are confined to the served directory, also across symlinks. Hidden folders and `node_modules` are skipped.
- Saves are atomic, detect concurrent changes on disk (409 -> overwrite/reload choice) and preserve CRLF line endings.
- External edits (git pull, your IDE, an AI agent) show up within ~1.5 s (polling, so it also works on network drives).
- YAML/JSON files are listed only if they contain a top-level `openapi:`/`swagger:` key, unless `--include-data`.

## Known limits (MVP)

- OpenAPI `$ref`s to other files are not resolved (single-file specs render fully).
- No multi-user editing; search is a plain case-insensitive substring scan (no index, no regex).
- The optional server/JAR PlantUML back ends were only tested with a stub, not a real JAR or Kroki.
- Go alternative for server-side rendering, not integrated: `github.com/ekalinin/gopuml` (MIT, pre-1.0, needs Go 1.26+).

## Build and test

Requires Go 1.24+ and Node 22+ (Node only at build time; the result is a single static binary).

```
make            # frontend build + bin/specli
make test       # gofmt, go vet, go test
make e2e        # Playwright browser tests against the built binary
make release    # linux/amd64, darwin arm64+amd64, windows/amd64 into bin/
```

Development: `cd web && npm run dev` (proxies `/api` to a running `specli --no-open` on 4747).
Use `PW_CHROME_PATH=/path/to/chrome` to run the e2e tests with an installed Chrome instead of downloading Chromium.

## CI and releases (GitHub Actions)

- `.github/workflows/ci.yml` runs on every push to `main` and on pull requests: gofmt/vet/tests on Linux, Windows and
  macOS, frontend typecheck + build, the Playwright e2e suite (fails on any browser console error, e.g. CSP
  violations), and a cross-compile check for all targets.
- `.github/workflows/release.yml` runs when you push a tag. It reuses CI, builds the frontend once, cross-compiles
  five binaries (linux amd64/arm64, macOS amd64/arm64, windows amd64), writes `checksums.txt` and publishes a GitHub
  release:

```
git tag v0.3.0 && git push origin v0.3.0
```

Release binaries are **not code-signed**: Windows SmartScreen and macOS Gatekeeper will warn on first start
(macOS: `xattr -d com.apple.quarantine specli`). Sign them in the release workflow if you distribute widely.

## Licenses

specli is released under the [MIT License](LICENSE).

The binary bundles third-party packages (Swagger UI, CodeMirror,
Mermaid, `@plantuml/core` with Viz.js/Graphviz, marked, DOMPurify, js-yaml); check their licenses and consider
generating a third-party notices file before distributing.
