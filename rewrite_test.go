package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readFile(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMoveRewritesLinks(t *testing.T) {
	s, root := newTestServer(t, nil)
	write(t, root, "a.md", "see [b](b.md#top) and [c](./docs/c.md) `[code](b.md)` [web](https://x.example/b.md)\n```\n[fence](b.md)\n```\n")
	write(t, root, "b.md", "back to [a](a.md) and ![img](img/p.png) [sp](my%20file.md)\n")
	write(t, root, "docs/c.md", "up: [b](../b.md)\n")
	write(t, root, "my file.md", "x")

	// moving b.md updates the links to it and the relative links inside it
	r := do(s, "POST", "/api/move", `{"from":"b.md","to":"specs/b.md"}`, jsonCT)
	if r.code != 200 || !strings.Contains(r.body, `"updated":3`) {
		t.Fatalf("move: %d %s", r.code, r.body)
	}
	if got := readFile(t, root, "a.md"); !strings.Contains(got, "[b](specs/b.md#top)") ||
		!strings.Contains(got, "`[code](b.md)`") || !strings.Contains(got, "[fence](b.md)") ||
		!strings.Contains(got, "https://x.example/b.md") || !strings.Contains(got, "[c](./docs/c.md)") {
		t.Errorf("a.md: %q", got)
	}
	if got := readFile(t, root, "docs/c.md"); got != "up: [b](../specs/b.md)\n" {
		t.Errorf("docs/c.md: %q", got)
	}
	if got := readFile(t, root, "specs/b.md"); got != "back to [a](../a.md) and ![img](../img/p.png) [sp](../my%20file.md)\n" {
		t.Errorf("specs/b.md: %q", got)
	}

	// a rename in place only touches the links to the file
	if r := do(s, "POST", "/api/move", `{"from":"specs/b.md","to":"specs/renamed.md"}`, jsonCT); r.code != 200 {
		t.Fatalf("rename: %d %s", r.code, r.body)
	}
	if got := readFile(t, root, "docs/c.md"); got != "up: [b](../specs/renamed.md)\n" {
		t.Errorf("docs/c.md after rename: %q", got)
	}
}

func TestCopyKeepsRelativeLinksWorking(t *testing.T) {
	s, root := newTestServer(t, nil)
	write(t, root, "a.md", "[b](b.md)\n")
	write(t, root, "b.md", "b")
	if r := do(s, "POST", "/api/copy", `{"from":"a.md","to":"deep/a copy.md"}`, jsonCT); r.code != 200 {
		t.Fatalf("copy: %d %s", r.code, r.body)
	}
	if got := readFile(t, root, "deep/a copy.md"); got != "[b](../b.md)\n" {
		t.Errorf("copy: %q", got)
	}
	if got := readFile(t, root, "a.md"); got != "[b](b.md)\n" {
		t.Errorf("original changed: %q", got)
	}
}

func TestLintConfig(t *testing.T) {
	root := t.TempDir()
	write(t, root, ".specli.yml", `# project rules
lint:
  disable: [empty-section]
  placeholders: [TODO, "<fill in>"]
  ignore:
    - "archive/**"
  require-sections:
    "specs/**": [Goal, "Acceptance Criteria"]
`)
	write(t, root, "specs/a.md", "# A\n\n## Goal\nTBD <fill in>\n\n## Empty\n")
	write(t, root, "specs/ok.md", "## goal\nx\n## Acceptance criteria\ny\n")
	write(t, root, "archive/old.md", "TODO\n")

	sc := newScanner(root, false)
	files, err := sc.scan()
	if err != nil || sc.cfgErr != nil {
		t.Fatal(err, sc.cfgErr)
	}
	got := map[string]int{}
	for _, f := range files {
		got[f.Path] = f.Lint
	}
	// a.md: "<fill in>" placeholder + missing "Acceptance Criteria"; TBD is no placeholder here
	if got["specs/a.md"] != 2 || got["specs/ok.md"] != 0 || got["archive/old.md"] != 0 {
		t.Errorf("lint counts: %v", got)
	}

	// editing the config takes effect without a restart
	write(t, root, ".specli.yml", "lint:\n  disable: [placeholder, missing-section, empty-section]\n")
	files, _ = sc.scan()
	for _, f := range files {
		if f.Lint != 0 {
			t.Errorf("%s: still %d issues after config change", f.Path, f.Lint)
		}
	}
}

func TestLintConfigErrors(t *testing.T) {
	for _, src := range []string{
		"lnt:\n  a: b\n",
		"lint:\n  disable: [nope]\n",
		"lint:\n  unknown: 1\n",
		"lint:\n\tdisable: [x]\n",
		"just text\n",
	} {
		if _, err := parseLintConfig(src); err == nil {
			t.Errorf("%q: want an error", src)
		}
	}
	if lc, err := parseLintConfig(""); err != nil || lc.placeholders == nil {
		t.Errorf("empty config: %v", err)
	}
}

func TestGlob(t *testing.T) {
	for glob, want := range map[string]map[string]bool{
		"specs/**":    {"specs/a.md": true, "specs/x/y.md": true, "other/a.md": false},
		"**/*.md":     {"a.md": true, "x/y/a.md": true, "a.txt": false},
		"docs/*.md":   {"docs/a.md": true, "docs/x/a.md": false},
		"docs/**/a.m": {"docs/a.m": true, "docs/x/y/a.m": true},
	} {
		re, err := globRe(glob)
		if err != nil {
			t.Fatal(err)
		}
		for path, ok := range want {
			if re.MatchString(path) != ok {
				t.Errorf("%s ~ %s: want %v", glob, path, ok)
			}
		}
	}
}

func TestLintCommand(t *testing.T) {
	root := t.TempDir()
	write(t, root, "ok.md", "# Ok\ntext\n")
	var out, errb bytes.Buffer
	if code := runLint([]string{root}, &out, &errb); code != 0 || out.Len() != 0 {
		t.Fatalf("clean: code %d, out %q err %q", code, out.String(), errb.String())
	}
	write(t, root, "bad.md", "# Bad\nTODO [x](missing.md)\n")
	out.Reset()
	errb.Reset()
	if code := runLint([]string{root}, &out, &errb); code != 1 ||
		!strings.Contains(out.String(), "bad.md:2: placeholder: Placeholder text: TODO") ||
		!strings.Contains(out.String(), "bad.md:2: broken-link:") {
		t.Fatalf("findings: code %d, out %q", code, out.String())
	}
	out.Reset()
	if code := runLint([]string{"--format", "github", root}, &out, &errb); code != 1 ||
		!strings.Contains(out.String(), "::warning file=bad.md,line=2,title=placeholder::") {
		t.Errorf("github format: %q", out.String())
	}
	out.Reset()
	if code := runLint([]string{root, "--format=json"}, &out, &errb); code != 1 || !strings.Contains(out.String(), `"rule": "broken-link"`) {
		t.Errorf("json format: %q", out.String())
	}
	write(t, root, ".specli.yml", "lint:\n  disable: [nope]\n")
	if code := runLint([]string{root}, &out, &errb); code != 2 {
		t.Errorf("bad config: want 2, got %d", code)
	}
	if code := runLint([]string{"--format", "xml", root}, &out, &errb); code != 2 {
		t.Errorf("bad format: want 2, got %d", code)
	}
}
