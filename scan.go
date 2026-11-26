package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// FileInfo describes one spec artifact below the served root.
type FileInfo struct {
	Path  string `json:"path"`  // slash separated, relative to root
	Kind  string `json:"kind"`  // markdown | plantuml | mermaid | csv | openapi | asyncapi | data
	Size  int64  `json:"size"`  // bytes
	Mtime string `json:"mtime"` // UnixNano as string (exceeds JS safe integer range)

	Status string `json:"status,omitempty"` // Markdown front matter "status", lower case
	Lint   int    `json:"lint,omitempty"`   // number of lint issues (Markdown only)
}

var (
	// also matches minified JSON such as {"openapi":"3.0.0",...}
	openapiRe  = regexp.MustCompile(`(?m)(?:^|[{,])\s*"?(?:openapi|swagger)"?\s*:`)
	asyncapiRe = regexp.MustCompile(`(?m)(?:^|[{,])\s*"?asyncapi"?\s*:`)
	errTooMany = errors.New("too many files")
)

const (
	maxFiles    = 20000
	maxFileSize = 5 << 20
)

// kindByExt returns the raw kind for a file name ("data" for yaml/json that
// still needs content sniffing) or "" if the file type is not supported.
func kindByExt(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".md", ".markdown":
		return "markdown"
	case ".puml", ".plantuml", ".pu", ".iuml", ".wsd":
		return "plantuml"
	case ".mmd", ".mermaid":
		return "mermaid"
	case ".csv", ".tsv":
		return "csv"
	case ".yaml", ".yml", ".json":
		return "data"
	}
	return ""
}

func skipDir(name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules"
}

type detectKey struct {
	path  string
	mtime int64
	size  int64
}

type scanner struct {
	root        string
	includeData bool
	mu          sync.Mutex
	cache       map[detectKey]string
	lintCache   map[detectKey]lintResult
	lc          *lintConfig // from .specli.yml
	cfgStamp    string      // identifies the loaded config file version
	cfgErr      error
}

func newScanner(root string, includeData bool) *scanner {
	return &scanner{root: root, includeData: includeData, cache: map[detectKey]string{}, lintCache: map[detectKey]lintResult{}, lc: defaultLintConfig()}
}

// refreshConfig reloads .specli.yml when it was added, changed or removed.
// A broken config keeps the defaults; the error is available as sc.cfgErr.
func (sc *scanner) refreshConfig() {
	stamp := ""
	if p := findConfig(sc.root); p != "" {
		if st, err := os.Stat(p); err == nil {
			stamp = p + "|" + mtimeString(st.ModTime()) + "|" + strconv.FormatInt(st.Size(), 10)
		}
	}
	sc.mu.Lock()
	same := stamp == sc.cfgStamp
	sc.mu.Unlock()
	if same {
		return
	}
	lc, err := loadLintConfig(sc.root)
	sc.mu.Lock()
	sc.lc, sc.cfgErr, sc.cfgStamp = lc, err, stamp
	sc.lintCache = map[detectKey]lintResult{}
	sc.mu.Unlock()
}

func mtimeString(t time.Time) string { return strconv.FormatInt(t.UnixNano(), 10) }

// detect decides whether a yaml/json file is an OpenAPI/Swagger or AsyncAPI document.
func (sc *scanner) detect(full string, info fs.FileInfo) string {
	key := detectKey{full, info.ModTime().UnixNano(), info.Size()}
	sc.mu.Lock()
	if k, ok := sc.cache[key]; ok {
		sc.mu.Unlock()
		return k
	}
	sc.mu.Unlock()

	kind := "data"
	if f, err := os.Open(full); err == nil {
		buf, _ := io.ReadAll(io.LimitReader(f, 8192))
		f.Close()
		if asyncapiRe.Match(buf) {
			kind = "asyncapi"
		} else if openapiRe.Match(buf) {
			kind = "openapi"
		}
	}
	sc.mu.Lock()
	if len(sc.cache) > 5000 {
		sc.cache = map[detectKey]string{}
	}
	sc.cache[key] = kind
	sc.mu.Unlock()
	return kind
}

// lint analyses a Markdown file; the content analysis is cached per file
// version, link targets are re-checked on every call because other files change.
func (sc *scanner) lint(full, rel string, info fs.FileInfo) (string, []Issue) {
	key := detectKey{full, info.ModTime().UnixNano(), info.Size()}
	sc.mu.Lock()
	res, ok := sc.lintCache[key]
	lc := sc.lc
	sc.mu.Unlock()
	if lc.ignored(rel) {
		return res.status, nil
	}
	if !ok {
		if info.Size() <= maxFileSize {
			if b, err := os.ReadFile(full); err == nil {
				res = lintMarkdown(string(b), lc.placeholders)
			}
		}
		sc.mu.Lock()
		if len(sc.lintCache) > 5000 {
			sc.lintCache = map[detectKey]lintResult{}
		}
		if sc.lc == lc { // not replaced by a config reload meanwhile
			sc.lintCache[key] = res
		}
		sc.mu.Unlock()
	}
	issues := append([]Issue{}, res.issues...)
	if !lc.disabled["broken-link"] {
		issues = append(issues, brokenLinks(sc.root, rel, res.links)...)
	}
	for _, rule := range lc.require {
		if !rule.glob.MatchString(filepath.ToSlash(rel)) {
			continue
		}
		for _, sec := range rule.sections {
			if !contains(res.headings, strings.ToLower(strings.TrimSpace(sec))) {
				issues = append(issues, Issue{1, "missing-section", "Missing section: " + sec})
			}
		}
	}
	kept := issues[:0]
	for _, is := range issues {
		if !lc.disabled[is.Rule] {
			kept = append(kept, is)
		}
	}
	issues = kept
	sort.SliceStable(issues, func(i, j int) bool { return issues[i].Line < issues[j].Line })
	return res.status, issues
}

func (sc *scanner) scan() ([]FileInfo, error) {
	sc.refreshConfig()
	var out []FileInfo
	err := filepath.WalkDir(sc.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if p != sc.root && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		kind := kindByExt(d.Name())
		if kind == "" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if kind == "data" {
			kind = sc.detect(p, info)
			if kind == "data" && !sc.includeData {
				return nil
			}
		}
		rel, err := filepath.Rel(sc.root, p)
		if err != nil {
			return nil
		}
		fi := FileInfo{
			Path:  filepath.ToSlash(rel),
			Kind:  kind,
			Size:  info.Size(),
			Mtime: mtimeString(info.ModTime()),
		}
		if kind == "markdown" {
			var issues []Issue
			fi.Status, issues = sc.lint(p, rel, info)
			fi.Lint = len(issues)
		}
		out = append(out, fi)
		if len(out) >= maxFiles {
			return errTooMany
		}
		return nil
	})
	if err != nil && !errors.Is(err, errTooMany) {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// ---- change notification (polling, no external dependencies) ----

type hub struct {
	mu   sync.Mutex
	subs map[chan string]struct{}
}

func newHub() *hub { return &hub{subs: map[chan string]struct{}{}} }

func (h *hub) subscribe() chan string {
	ch := make(chan string, 32)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan string) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *hub) publish(msg string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- msg:
		default: // slow consumer: drop, client re-syncs on reconnect
		}
	}
}

type changeEvent struct {
	Type  string `json:"type"`
	Path  string `json:"path"`
	Op    string `json:"op"` // added | modified | removed
	Mtime string `json:"mtime,omitempty"`
}

func snapshot(files []FileInfo) map[string]FileInfo {
	m := make(map[string]FileInfo, len(files))
	for _, f := range files {
		m[f.Path] = f
	}
	return m
}

// watch polls the tree and publishes change events. Polling keeps the binary
// dependency-free and behaves the same on network drives and in containers.
func (s *Server) watch(ctx context.Context) {
	files, _ := s.sc.scan()
	prev := snapshot(files)
	t := time.NewTicker(1500 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		files, err := s.sc.scan()
		if err != nil {
			continue
		}
		cur := snapshot(files)
		emit := func(path, op, mtime string) {
			b, _ := json.Marshal(changeEvent{Type: "change", Path: path, Op: op, Mtime: mtime})
			s.hub.publish(string(b))
		}
		for p, f := range cur {
			old, ok := prev[p]
			switch {
			case !ok:
				emit(p, "added", f.Mtime)
			case old.Mtime != f.Mtime || old.Size != f.Size:
				emit(p, "modified", f.Mtime)
			}
		}
		for p := range prev {
			if _, ok := cur[p]; !ok {
				emit(p, "removed", "")
			}
		}
		prev = cur
	}
}
