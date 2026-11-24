# Development

## Known limits (MVP)

- OpenAPI `$ref`s to other files are not resolved (single-file specs render fully). The AsyncAPI viewer is a built-in lightweight renderer: it resolves `#/...` references within one file only and does not render bindings, traits or security schemes.
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
git tag vX.Y.Z && git push origin vX.Y.Z
```

Release binaries are **not code-signed**: Windows SmartScreen and macOS Gatekeeper will warn on first start
(macOS: `xattr -d com.apple.quarantine specli`). Sign them in the release workflow if you distribute widely.
