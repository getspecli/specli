package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

const testHost = "127.0.0.1:4747"

func newTestServer(t *testing.T, mutate func(*config)) (*Server, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config{host: "127.0.0.1", port: 4747}
	if mutate != nil {
		mutate(cfg)
	}
	static := fstest.MapFS{"index.html": {Data: []byte("<html>ok</html>")}}
	return newServer(cfg, root, static, 4747), root
}

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

type resp struct {
	code int
	body string
	hdr  http.Header
}

func do(s *Server, method, target, body string, hdr map[string]string) resp {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Host = testHost
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	b, _ := io.ReadAll(rec.Result().Body)
	return resp{rec.Code, string(b), rec.Result().Header}
}

var jsonCT = map[string]string{"Content-Type": "application/json"}

func TestResolveConfinesPathsToRoot(t *testing.T) {
	s, root := newTestServer(t, nil)
	outside := t.TempDir()
	write(t, outside, "secret.md", "secret")
	if err := os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(root, "link.md")); err != nil {
		t.Skip("symlinks not available:", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linkdir")); err != nil {
		t.Skip("symlinks not available:", err)
	}
	write(t, root, "ok/inside.md", "x")

	bad := []string{
		"", "../secret.md", "a/../b.md", "/etc/passwd", "..", ".hidden/x.md", "a/.git/x.md",
		"node_modules/x.md", `a\b.md`, "a//b.md", "link.md", "linkdir/secret.md", "linkdir/new.md",
	}
	for _, p := range bad {
		if _, err := s.resolve(p); err == nil {
			t.Errorf("resolve(%q) should fail", p)
		}
	}
	for _, p := range []string{"ok/inside.md", "ok/new.md", "brand/new/dir/x.md"} {
		if _, err := s.resolve(p); err != nil {
			t.Errorf("resolve(%q) should succeed: %v", p, err)
		}
	}
}

func TestScanKindsAndVisibility(t *testing.T) {
	s, root := newTestServer(t, nil)
	write(t, root, "a.md", "# a")
	write(t, root, "d/b.puml", "@startuml\n@enduml")
	write(t, root, "c.mmd", "flowchart TD\nA-->B")
	write(t, root, "roles.csv", "role,desc\nadmin,all")
	write(t, root, "api.yaml", "openapi: 3.0.3\ninfo: {}\n")
	write(t, root, "swag.json", `{"swagger": "2.0"}`)
	write(t, root, "other.yaml", "services:\n  web: {}\n")
	write(t, root, "package.json", `{"name":"x"}`)
	write(t, root, ".hidden/h.md", "h")
	write(t, root, "node_modules/n.md", "n")
	write(t, root, "notes.txt", "t")

	got := map[string]string{}
	files, err := s.sc.scan()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		got[f.Path] = f.Kind
	}
	want := map[string]string{
		"a.md": "markdown", "d/b.puml": "plantuml", "c.mmd": "mermaid", "roles.csv": "csv",
		"api.yaml": "openapi", "swag.json": "openapi",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scan mismatch\n got  %v\n want %v", got, want)
	}

	s.sc.includeData = true
	files, _ = s.sc.scan()
	kinds := map[string]string{}
	for _, f := range files {
		kinds[f.Path] = f.Kind
	}
	if kinds["other.yaml"] != "data" || kinds["package.json"] != "data" {
		t.Errorf("--include-data should list other yaml/json as data, got %v", kinds)
	}
}

func TestFileRoundTripPreservesCRLFAndDetectsConflicts(t *testing.T) {
	s, root := newTestServer(t, nil)
	write(t, root, "crlf.md", "one\r\ntwo\r\n")

	r := do(s, "GET", "/api/file?path=crlf.md", "", nil)
	if r.code != 200 {
		t.Fatalf("GET: %d %s", r.code, r.body)
	}
	var fr fileResponse
	if err := json.Unmarshal([]byte(r.body), &fr); err != nil {
		t.Fatal(err)
	}
	if fr.EOL != "crlf" || fr.Content != "one\ntwo\n" {
		t.Fatalf("unexpected read: %+v", fr)
	}

	put := func(content, base, eol string) resp {
		b, _ := json.Marshal(putRequest{Content: content, BaseMtime: base, EOL: eol})
		return do(s, "PUT", "/api/file?path=crlf.md", string(b), jsonCT)
	}
	r = put("one\ntwo\nthree\n", fr.Mtime, "crlf")
	if r.code != 200 {
		t.Fatalf("PUT: %d %s", r.code, r.body)
	}
	disk, _ := os.ReadFile(filepath.Join(root, "crlf.md"))
	if string(disk) != "one\r\ntwo\r\nthree\r\n" {
		t.Fatalf("CRLF not preserved: %q", disk)
	}

	// A save based on the old mtime must be rejected...
	if r = put("x", fr.Mtime, "crlf"); r.code != http.StatusConflict {
		t.Fatalf("expected 409, got %d %s", r.code, r.body)
	}
	// ...but an explicit overwrite (empty baseMtime) succeeds.
	if r = put("forced\n", "", "lf"); r.code != 200 {
		t.Fatalf("forced PUT: %d %s", r.code, r.body)
	}
	// No temp files may be left behind.
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("leftover temp file %s", e.Name())
		}
	}
}

func TestCreateFileInNewDirectory(t *testing.T) {
	s, root := newTestServer(t, nil)
	r := do(s, "PUT", "/api/file?path=docs/deep/new.md", `{"content":"# New\n","baseMtime":"","eol":"lf"}`, jsonCT)
	if r.code != 200 {
		t.Fatalf("create: %d %s", r.code, r.body)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "docs/deep/new.md")); string(b) != "# New\n" {
		t.Fatalf("content: %q", b)
	}
}

func TestWriteGuards(t *testing.T) {
	s, root := newTestServer(t, nil)
	write(t, root, "a.md", "a")
	body := `{"content":"x","baseMtime":""}`

	if r := do(s, "PUT", "/api/file?path=a.md", body, map[string]string{"Content-Type": "text/plain"}); r.code != 415 {
		t.Errorf("non-JSON content type: want 415, got %d", r.code)
	}
	if r := do(s, "PUT", "/api/file?path=a.md", body, map[string]string{"Content-Type": "application/json", "Origin": "http://evil.example"}); r.code != 403 {
		t.Errorf("foreign Origin: want 403, got %d", r.code)
	}
	if r := do(s, "PUT", "/api/file?path=a.md", body, map[string]string{"Content-Type": "application/json", "Origin": "http://" + testHost}); r.code != 200 {
		t.Errorf("same Origin: want 200, got %d %s", r.code, r.body)
	}
	if r := do(s, "PUT", "/api/file?path=main.go", body, jsonCT); r.code != 400 {
		t.Errorf("unsupported extension: want 400, got %d", r.code)
	}
	if r := do(s, "GET", "/api/file?path=../x.md", "", nil); r.code != 400 {
		t.Errorf("traversal: want 400, got %d", r.code)
	}
}

func TestReadOnlyRejectsWrites(t *testing.T) {
	s, root := newTestServer(t, func(c *config) { c.readonly = true })
	write(t, root, "a.md", "a")
	if r := do(s, "PUT", "/api/file?path=a.md", `{"content":"x","baseMtime":""}`, jsonCT); r.code != 403 {
		t.Fatalf("want 403, got %d", r.code)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "a.md")); string(b) != "a" {
		t.Fatal("file was modified in read-only mode")
	}
}

func TestHostCheckAgainstDNSRebinding(t *testing.T) {
	s, _ := newTestServer(t, nil)
	if r := do(s, "GET", "/api/files", "", map[string]string{"Host": "evil.example:4747"}); r.code != 403 {
		t.Errorf("foreign Host: want 403, got %d", r.code)
	}
	for _, h := range []string{"127.0.0.1:4747", "localhost:4747"} {
		if r := do(s, "GET", "/api/files", "", map[string]string{"Host": h}); r.code != 200 {
			t.Errorf("Host %s: want 200, got %d", h, r.code)
		}
	}
	r := do(s, "GET", "/", "", nil)
	if r.code != 200 || !strings.Contains(r.hdr.Get("Content-Security-Policy"), "default-src 'self'") {
		t.Errorf("index/CSP: %d %q", r.code, r.hdr.Get("Content-Security-Policy"))
	}
}

func TestAssetServesOnlyImagesAndSandboxesSVG(t *testing.T) {
	s, root := newTestServer(t, nil)
	write(t, root, "img/x.svg", `<svg xmlns="http://www.w3.org/2000/svg"/>`)
	write(t, root, "note.md", "x")
	r := do(s, "GET", "/api/asset?path=img/x.svg", "", nil)
	if r.code != 200 || !strings.HasPrefix(r.hdr.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("svg asset: %d csp=%q", r.code, r.hdr.Get("Content-Security-Policy"))
	}
	if r := do(s, "GET", "/api/asset?path=note.md", "", nil); r.code != 400 {
		t.Errorf("non-image asset: want 400, got %d", r.code)
	}
}

func TestSearch(t *testing.T) {
	s, root := newTestServer(t, nil)
	write(t, root, "a.md", "# Title\nOrders are immutable\nnothing here\nORDERS again\n")
	write(t, root, "b.puml", "@startuml\nOrderService -> X\n@enduml\n")

	var out struct {
		Results   []SearchHit `json:"results"`
		Truncated bool        `json:"truncated"`
	}
	get := func(q string) {
		out.Results = nil
		r := do(s, "GET", "/api/search?q="+q, "", nil)
		if r.code != 200 {
			t.Fatalf("search %q: %d %s", q, r.code, r.body)
		}
		if err := json.Unmarshal([]byte(r.body), &out); err != nil {
			t.Fatal(err)
		}
	}

	get("orders")
	if len(out.Results) != 3 {
		t.Fatalf("want 3 hits, got %+v", out.Results)
	}
	if h := out.Results[0]; h.Path != "a.md" || h.Line != 2 || h.Kind != "markdown" {
		t.Errorf("first hit: %+v", h)
	}
	if h := out.Results[2]; h.Path != "b.puml" || h.Line != 2 {
		t.Errorf("third hit: %+v", h)
	}
	get("x") // below minimum length
	if len(out.Results) != 0 {
		t.Errorf("1-char query must return nothing, got %+v", out.Results)
	}
	if !strings.Contains(do(s, "GET", "/api/search?q=zzzz", "", nil).body, `"results":[]`) {
		t.Error("empty result must be [] not null")
	}
}

func TestSearchLimitsResultsPerFile(t *testing.T) {
	s, root := newTestServer(t, nil)
	write(t, root, "big.md", strings.Repeat("needle\n", 100))
	var out struct {
		Results   []SearchHit `json:"results"`
		Truncated bool        `json:"truncated"`
	}
	r := do(s, "GET", "/api/search?q=needle", "", nil)
	if err := json.Unmarshal([]byte(r.body), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Results) != searchMaxPerFile || !out.Truncated {
		t.Fatalf("want %d hits + truncated, got %d truncated=%v", searchMaxPerFile, len(out.Results), out.Truncated)
	}
}

func TestPlantUMLEndpointWithoutBackend(t *testing.T) {
	s, _ := newTestServer(t, nil)
	if r := do(s, "POST", "/api/plantuml", "@startuml\n@enduml", nil); r.code != 501 {
		t.Fatalf("want 501 when no server/jar configured, got %d", r.code)
	}
	var info struct {
		Plantuml struct {
			Available bool `json:"available"`
		} `json:"plantuml"`
	}
	_ = json.Unmarshal([]byte(do(s, "GET", "/api/info", "", nil).body), &info)
	if info.Plantuml.Available {
		t.Error("info must report no server-side PlantUML so the browser engine is used")
	}
}

func TestPlantUMLServerBackend(t *testing.T) {
	var got string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.Header().Set("Content-Type", "image/svg+xml")
		io.WriteString(w, "<svg/>")
	}))
	defer backend.Close()
	s, _ := newTestServer(t, func(c *config) { c.puServer = backend.URL })
	r := do(s, "POST", "/api/plantuml", "@startuml\nA->B\n@enduml", nil)
	if r.code != 200 || r.body != "<svg/>" || !strings.Contains(got, "A->B") {
		t.Fatalf("server backend: %d %q (backend got %q)", r.code, r.body, got)
	}
}

func TestParseArgsAllowsFlagsAfterDirectory(t *testing.T) {
	cfg, err := parseArgs([]string{"./docs", "--port", "5000", "--no-open", "--readonly"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.root != "./docs" || cfg.port != 5000 || !cfg.portSet || !cfg.noOpen || !cfg.readonly {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	if _, err := parseArgs([]string{"a", "b"}); err == nil {
		t.Error("two directories must be rejected")
	}
	cfg, _ = parseArgs(nil)
	if cfg.root != "." || cfg.port != 4747 || cfg.portSet {
		t.Errorf("defaults: %+v", cfg)
	}
}

func TestIsHomebrewPath(t *testing.T) {
	for path, want := range map[string]bool{
		"/opt/homebrew/Cellar/specli/0.3.3/bin/specli":              true,
		"/usr/local/Cellar/specli/0.3.3/bin/specli":                 true,
		"/home/linuxbrew/.linuxbrew/Cellar/specli/0.3.3/bin/specli": true,
		"/usr/local/bin/specli":                                     false,
		"/opt/homebrew/bin/specli":                                  false, // unresolved symlink, callers resolve first
	} {
		if got := isHomebrewPath(path); got != want {
			t.Errorf("isHomebrewPath(%q) = %v, want %v", path, got, want)
		}
	}
}
