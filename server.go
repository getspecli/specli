package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

type Server struct {
	cfg          *config
	root         string // symlink-resolved absolute root
	sc           *scanner
	pu           *PlantUML
	hub          *hub
	upd          *updateChecker
	git          *gitProbe
	static       fs.FS
	allowedHosts map[string]bool // nil = no Host check (non-loopback binding)
}

func newServer(cfg *config, root string, static fs.FS, port int) *Server {
	s := &Server{
		cfg:    cfg,
		root:   root,
		sc:     newScanner(root, cfg.includeData),
		pu:     newPlantUML(cfg.puServer, cfg.puJar),
		hub:    newHub(),
		upd:    newUpdateChecker(!cfg.noUpdateChk),
		git:    newGitProbe(root, !cfg.noGit),
		static: static,
	}
	if isLoopback(cfg.host) {
		p := fmt.Sprint(port)
		s.allowedHosts = map[string]bool{
			net.JoinHostPort("127.0.0.1", p): true,
			net.JoinHostPort("localhost", p): true,
			net.JoinHostPort("::1", p):       true,
		}
	}
	return s
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/info", s.handleInfo)
	mux.HandleFunc("/api/update", s.handleUpdate)
	mux.HandleFunc("/api/git", s.handleGit)
	mux.HandleFunc("/api/git/commit", s.handleGitCommit)
	mux.HandleFunc("/api/files", s.handleFiles)
	mux.HandleFunc("/api/file", s.handleFile)
	mux.HandleFunc("/api/asset", s.handleAsset)
	mux.HandleFunc("/api/plantuml", s.handlePlantUML)
	mux.HandleFunc("/api/search", s.handleSearch)
	mux.HandleFunc("/api/events", s.handleEvents)
	mux.Handle("/", http.FileServer(http.FS(s.static)))
	return s.guard(mux)
}

// guard adds security headers and defends the local, unauthenticated API
// against DNS rebinding (Host check) and cross-site writes (Origin check).
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.allowedHosts != nil && !s.allowedHosts[r.Host] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if o := r.Header.Get("Origin"); o != "" && o != "http://"+r.Host {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "+
				"script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

var errBadPath = errors.New("invalid path")

func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

// resolve maps a client supplied slash-separated relative path to an absolute
// path that is guaranteed to stay inside the root, also after following
// symlinks. The target itself does not need to exist (for creating files).
func (s *Server) resolve(rel string) (string, error) {
	if rel == "" || strings.ContainsRune(rel, 0) || strings.Contains(rel, "\\") {
		return "", errBadPath
	}
	if strings.HasPrefix(rel, "/") || filepath.IsAbs(filepath.FromSlash(rel)) {
		return "", errBadPath
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") || seg == "node_modules" {
			return "", errBadPath
		}
	}
	full := filepath.Join(s.root, filepath.FromSlash(rel))
	check := full
	for {
		if _, err := os.Lstat(check); err == nil {
			break
		}
		parent := filepath.Dir(check)
		if parent == check {
			return "", errBadPath
		}
		check = parent
	}
	real, err := filepath.EvalSymlinks(check)
	if err != nil || !within(s.root, real) {
		return "", errBadPath
	}
	return full, nil
}

// ---- handlers ----

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"name":     filepath.Base(s.root),
		"path":     s.root,
		"readonly": s.cfg.readonly,
		"version":  version,
		"plantuml": map[string]any{"available": s.pu.Available(), "mode": s.pu.mode},
	})
}

func (s *Server) handleGit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.git.status())
}

func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpErr(w, 405, "POST only")
		return
	}
	if s.cfg.readonly {
		httpErr(w, 403, "read-only mode")
		return
	}
	var req struct {
		Message string   `json:"message"`
		Paths   []string `json:"paths"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpErr(w, 400, "bad request")
		return
	}
	summary, err := s.git.commit(req.Message, req.Paths)
	if err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "summary": summary})
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	files, err := s.sc.scan()
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	if files == nil {
		files = []FileInfo{}
	}
	writeJSON(w, 200, files)
}

type fileResponse struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mtime   string `json:"mtime"`
	EOL     string `json:"eol"` // lf | crlf - preserved on save so Windows checkouts do not get noisy diffs
}

type putRequest struct {
	Content   string `json:"content"`
	BaseMtime string `json:"baseMtime"` // mtime the client loaded; "" = create new / force
	EOL       string `json:"eol"`
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	if kindByExt(rel) == "" {
		httpErr(w, 400, "unsupported file type")
		return
	}
	full, err := s.resolve(rel)
	if err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.readFile(w, rel, full)
	case http.MethodPut:
		s.writeFile(w, r, rel, full)
	default:
		httpErr(w, 405, "method not allowed")
	}
}

func (s *Server) readFile(w http.ResponseWriter, rel, full string) {
	st, err := os.Stat(full)
	if err != nil || !st.Mode().IsRegular() {
		httpErr(w, 404, "not found")
		return
	}
	if st.Size() > maxFileSize {
		httpErr(w, 413, "file too large")
		return
	}
	b, err := os.ReadFile(full)
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	if !utf8.Valid(b) {
		httpErr(w, 415, "file is not valid UTF-8")
		return
	}
	content, eol := string(b), "lf"
	if strings.Contains(content, "\r\n") {
		eol = "crlf"
		content = strings.ReplaceAll(content, "\r\n", "\n")
	}
	writeJSON(w, 200, fileResponse{Path: rel, Content: content, Mtime: mtimeString(st.ModTime()), EOL: eol})
}

func (s *Server) writeFile(w http.ResponseWriter, r *http.Request, rel, full string) {
	if s.cfg.readonly {
		httpErr(w, 403, "server is read-only")
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		httpErr(w, 415, "expected application/json")
		return
	}
	var req putRequest
	body := http.MaxBytesReader(w, r.Body, maxFileSize+1024)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		httpErr(w, 400, "invalid body: "+err.Error())
		return
	}

	mode := os.FileMode(0o644)
	if st, err := os.Stat(full); err == nil {
		if !st.Mode().IsRegular() {
			httpErr(w, 400, "not a regular file")
			return
		}
		mode = st.Mode().Perm()
		cur := mtimeString(st.ModTime())
		if req.BaseMtime != "" && req.BaseMtime != cur {
			writeJSON(w, http.StatusConflict, map[string]string{
				"error": "file changed on disk since it was loaded", "mtime": cur,
			})
			return
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		httpErr(w, 500, err.Error())
		return
	} else if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		httpErr(w, 500, err.Error())
		return
	}

	content := strings.ReplaceAll(req.Content, "\r\n", "\n")
	if req.EOL == "crlf" {
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}

	// Atomic replace: write a temp file next to the target, then rename.
	tmp, err := os.CreateTemp(filepath.Dir(full), ".specli-*.tmp")
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	tmpName := tmp.Name()
	_, werr := tmp.WriteString(content)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmpName, mode)
	}
	if werr == nil {
		werr = os.Rename(tmpName, full)
	}
	if werr != nil {
		os.Remove(tmpName)
		httpErr(w, 500, werr.Error())
		return
	}
	st, err := os.Stat(full)
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"path": rel, "mtime": mtimeString(st.ModTime())})
}

var imageTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
}

// handleAsset serves images referenced from Markdown. SVGs are sandboxed so
// scripts inside them cannot run in the app's origin.
func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	ct, ok := imageTypes[strings.ToLower(filepath.Ext(rel))]
	if !ok {
		httpErr(w, 400, "unsupported asset type")
		return
	}
	full, err := s.resolve(rel)
	if err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	f, err := os.Open(full)
	if err != nil {
		httpErr(w, 404, "not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		httpErr(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, filepath.Base(full), st.ModTime(), f)
}

func (s *Server) handlePlantUML(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpErr(w, 405, "method not allowed")
		return
	}
	if !s.pu.Available() {
		httpErr(w, 501, "PlantUML rendering is not configured")
		return
	}
	src, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		httpErr(w, 400, err.Error())
		return
	}
	svg, err := s.pu.Render(r.Context(), src)
	if err != nil {
		httpErr(w, 422, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Write(svg)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		httpErr(w, 500, "streaming unsupported")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(200)
	fmt.Fprint(w, ": connected\n\n")
	fl.Flush()

	ch := s.hub.subscribe()
	defer s.hub.unsubscribe(ch)
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}
