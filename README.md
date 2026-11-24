<p align="center"><img src="docs/logo.svg" alt="specli" width="232" /></p>

# specli

Browser viewer/editor for spec-driven design artifacts, started from the command line.
Point it at a project directory and it serves every spec file it finds in one place: browse, read, search and edit.
One self-contained binary, nothing else to install.

## What it does

| Format | View | Edit |
|---|---|---|
| Markdown (`.md`) | rendered, with front matter as a table, inline ```` ```plantuml ```` / ```` ```mermaid ```` blocks, `![](x.puml)` / `![](x.mmd)` embeds, links between spec files | CodeMirror |
| PlantUML (`.puml`, `.plantuml`, `.pu`, `.iuml`, `.wsd`) | SVG, live | CodeMirror |
| Mermaid (`.mmd`, `.mermaid`) | SVG, live, syntax errors shown | CodeMirror |
| CSV / TSV (`.csv`, `.tsv`) | table (delimiter auto-detected) | CodeMirror |
| OpenAPI / Swagger (`.yaml`, `.yml`, `.json`) | Swagger UI (try-it-out disabled), live, parse errors shown | CodeMirror |

- **Search:** type in the sidebar box (`Ctrl/Cmd+K`) to filter file names and search all text; a hit opens the file at that line.
- **Live reload:** external edits (git pull, your IDE, an AI agent) show up within about 1.5 s.
- **Safe saving:** writes are atomic, concurrent changes on disk are detected, CRLF line endings are preserved.
- **Local only:** binds to `127.0.0.1`, paths are confined to the served directory, and diagrams are rendered in the
  browser so their text never leaves your machine. A non-loopback `--host` forces `--readonly`.
- YAML/JSON files are listed only if they contain a top-level `openapi:` or `swagger:` key, unless `--include-data`.
  Hidden folders and `node_modules` are skipped.

## Install

Download the archive for your platform from the [latest release](https://github.com/mhauri/specli/releases/latest)
(`specli_<version>_<os>_<arch>`: linux, macOS and windows; amd64 and arm64, except windows amd64 only), check it
against `checksums.txt`, extract it and put `specli` somewhere on your `PATH`:

```
tar -xzf specli_v0.3.2_darwin_arm64.tar.gz
sudo mv specli_v0.3.2_darwin_arm64/specli /usr/local/bin/
```

The binaries are not code-signed. On macOS, allow the first start with `xattr -d com.apple.quarantine specli`;
on Windows, SmartScreen will show a warning.

Or build from source (Go 1.24+ and Node 22+): `make` produces `bin/specli`.

### Update

`specli --self-update` downloads the latest release for your platform, verifies its checksum and replaces the binary.
The sidebar footer shows the running version and an "Update available" link when a newer release exists. That check is
one cached request (at most every 6 h) to the GitHub releases API and sends no file contents. Disable it with
`--no-update-check` or `SPECLI_NO_UPDATE_CHECK=1`.

## Usage

```
specli [directory] [options]
```

| Option | |
|---|---|
| `--port N` | Port to listen on (default 4747, next free port if busy, 0 = random) |
| `--host ADDR` | Address to bind (default 127.0.0.1) |
| `--no-open` | Do not open the browser |
| `--readonly` | Disable saving and creating files |
| `--include-data` | Also list non-OpenAPI `.yaml`/`.yml`/`.json` files (editor only) |
| `--plantuml-server URL` | Render PlantUML on a server (e.g. Kroki) instead of the built-in engine. Env: `SPECLI_PLANTUML_SERVER` |
| `--plantuml-jar PATH` | Render PlantUML with `java -jar PATH`. Env: `SPECLI_PLANTUML_JAR` |
| `--no-update-check` | Do not check GitHub for a newer release |
| `--self-update` | Install the latest release |
| `--version` | Print the version |

PlantUML uses the official JavaScript engine in the browser by default. The server and JAR options are only for full
Java fidelity.

Development, tests and releases: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

specli is released under the [MIT License](LICENSE). The binary bundles third-party packages (Swagger UI, CodeMirror,
Mermaid, `@plantuml/core` with Viz.js/Graphviz, marked, DOMPurify, js-yaml) under their own licenses.
