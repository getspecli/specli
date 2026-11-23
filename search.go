package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// SearchHit is one matching line.
type SearchHit struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
	Line int    `json:"line"` // 1-based
	Text string `json:"text"` // trimmed, truncated line
}

const (
	searchMaxTotal   = 300
	searchMaxPerFile = 25
	searchMaxText    = 200
)

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

// handleSearch does a case-insensitive substring search over all listed files.
// The corpus is a handful of spec files, so a plain scan is fast enough and
// needs no index to keep in sync.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	out := []SearchHit{}
	truncated := false
	if utf8.RuneCountInString(q) < 2 {
		writeJSON(w, 200, map[string]any{"results": out, "truncated": false})
		return
	}
	qn := strings.ToLower(q)
	files, err := s.sc.scan()
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
files:
	for _, f := range files {
		if r.Context().Err() != nil {
			return
		}
		if f.Size > maxFileSize {
			continue
		}
		b, err := os.ReadFile(filepath.Join(s.root, filepath.FromSlash(f.Path)))
		if err != nil || !utf8.Valid(b) {
			continue
		}
		text := string(b)
		if !strings.Contains(strings.ToLower(text), qn) {
			continue
		}
		perFile := 0
		for i, line := range strings.Split(text, "\n") {
			if !strings.Contains(strings.ToLower(line), qn) {
				continue
			}
			if len(out) >= searchMaxTotal {
				truncated = true
				break files
			}
			if perFile >= searchMaxPerFile {
				truncated = true
				break
			}
			perFile++
			out = append(out, SearchHit{
				Path: f.Path, Kind: f.Kind, Line: i + 1,
				Text: truncateRunes(strings.TrimSpace(line), searchMaxText),
			})
		}
	}
	writeJSON(w, 200, map[string]any{"results": out, "truncated": truncated})
}
