package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GitStatus is what /api/git reports. Everything is read-only: specli only ever
// runs `git rev-parse` and `git status` against the served directory.
type GitStatus struct {
	Available bool              `json:"available"`        // a git executable was found
	Repo      bool              `json:"repo"`             // the served directory is inside a work tree
	Branch    string            `json:"branch,omitempty"` // "(detached)" when HEAD is detached
	Upstream  string            `json:"upstream,omitempty"`
	Ahead     int               `json:"ahead"`
	Behind    int               `json:"behind"`
	Changed   int               `json:"changed"`
	Files     map[string]string `json:"files,omitempty"` // root-relative path -> M, A, D, R, U (conflict) or ? (untracked)
	orig      map[string]string // renamed path -> original path (root-relative)
}

type gitProbe struct {
	root    string
	enabled bool
	bin     string // "" until looked up / when git is missing

	mu     sync.Mutex
	cached GitStatus
	at     time.Time
}

func newGitProbe(root string, enabled bool) *gitProbe {
	g := &gitProbe{root: root, enabled: enabled}
	if enabled {
		g.bin, _ = exec.LookPath("git")
	}
	return g
}

// status returns a short-lived cached result so bursts of UI refreshes do not
// spawn a git process each.
func (g *gitProbe) status() GitStatus {
	if g.bin == "" {
		return GitStatus{}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.at.IsZero() && time.Since(g.at) < time.Second {
		return g.cached
	}
	g.cached = g.query()
	g.at = time.Now()
	return g.cached
}

func (g *gitProbe) run(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// fsmonitor and hooks-style config can execute programs named in a repo's
	// own .git/config, so switch fsmonitor off; optional locks are skipped so
	// we never block or interfere with the user's own git commands.
	full := append([]string{"-C", g.root, "-c", "core.fsmonitor=false", "-c", "core.quotepath=off"}, args...)
	cmd := exec.CommandContext(ctx, g.bin, full...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(errb.String() + out.String()); msg != "" {
			return nil, errors.New(msg)
		}
		return nil, err
	}
	return out.Bytes(), nil
}

func (g *gitProbe) query() GitStatus {
	st := GitStatus{Available: true}
	pre, err := g.run("rev-parse", "--is-inside-work-tree", "--show-prefix")
	if err != nil {
		return st // not a repository (or unsafe ownership): git is there, nothing to show
	}
	lines := strings.SplitN(string(pre), "\n", 3)
	if len(lines) < 1 || strings.TrimSpace(lines[0]) != "true" {
		return st
	}
	st.Repo = true
	prefix := ""
	if len(lines) > 1 {
		prefix = strings.TrimSpace(lines[1])
	}
	out, err := g.run("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", ".")
	if err != nil {
		return st
	}
	st.Files = map[string]string{}
	st.orig = map[string]string{}
	recs := strings.Split(string(out), "\x00")
	for i := 0; i < len(recs); i++ {
		r := recs[i]
		switch {
		case strings.HasPrefix(r, "# branch.head "):
			st.Branch = strings.TrimPrefix(r, "# branch.head ")
		case strings.HasPrefix(r, "# branch.upstream "):
			st.Upstream = strings.TrimPrefix(r, "# branch.upstream ")
		case strings.HasPrefix(r, "# branch.ab "):
			f := strings.Fields(strings.TrimPrefix(r, "# branch.ab "))
			if len(f) == 2 {
				st.Ahead, _ = strconv.Atoi(strings.TrimPrefix(f[0], "+"))
				st.Behind, _ = strconv.Atoi(strings.TrimPrefix(f[1], "-"))
			}
		case strings.HasPrefix(r, "1 "): // ordinary change: 8 fields before the path
			if f := strings.SplitN(r, " ", 9); len(f) == 9 {
				st.add(prefix, f[8], letter(f[1]))
			}
		case strings.HasPrefix(r, "2 "): // rename/copy: path, then the original path as the next record
			if f := strings.SplitN(r, " ", 10); len(f) == 10 {
				st.add(prefix, f[9], "R")
				if i+1 < len(recs) {
					st.orig[filepath.ToSlash(path.Clean(strings.TrimPrefix(f[9], prefix)))] = filepath.ToSlash(path.Clean(strings.TrimPrefix(recs[i+1], prefix)))
				}
			}
			i++
		case strings.HasPrefix(r, "u "): // unmerged
			if f := strings.SplitN(r, " ", 11); len(f) == 11 {
				st.add(prefix, f[10], "U")
			}
		case strings.HasPrefix(r, "? "):
			st.add(prefix, r[2:], "?")
		}
	}
	st.Changed = len(st.Files)
	return st
}

// letter picks the most telling of the two XY status characters.
func letter(xy string) string {
	for _, c := range []byte(xy) {
		switch c {
		case 'A', 'D', 'R', 'M', 'T':
			if c == 'T' {
				return "M"
			}
			return string(c)
		}
	}
	return "M"
}

func (st *GitStatus) add(prefix, p, kind string) {
	p = strings.TrimPrefix(p, prefix)
	st.Files[filepath.ToSlash(path.Clean(p))] = kind
}

// commit stages and commits exactly the given paths (root-relative). Every path
// must currently be reported as changed, so the API cannot be used to touch
// arbitrary files; other staged changes stay out of the commit.
func (g *gitProbe) commit(message string, paths []string) (string, error) {
	if g.bin == "" {
		return "", errors.New("git is not available")
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return "", errors.New("commit message is empty")
	}
	if len(paths) == 0 {
		return "", errors.New("no files selected")
	}
	g.mu.Lock()
	g.at = time.Time{}
	g.mu.Unlock()
	st := g.status()
	if !st.Repo {
		return "", errors.New("not a git repository")
	}
	seen := map[string]bool{}
	var specs []string
	add := func(p string) {
		if !seen[p] {
			seen[p] = true
			specs = append(specs, p)
		}
	}
	for _, p := range paths {
		if _, ok := st.Files[p]; !ok {
			return "", fmt.Errorf("%s has no changes", p)
		}
		add(p)
		if o := st.orig[p]; o != "" {
			add(o)
		}
	}
	args := append([]string{"--literal-pathspecs", "add", "-A", "--"}, specs...)
	if _, err := g.run(args...); err != nil {
		return "", err
	}
	args = append([]string{"--literal-pathspecs", "commit", "-m", message, "--"}, specs...)
	out, err := g.run(args...)
	g.mu.Lock()
	g.at = time.Time{}
	g.mu.Unlock()
	if err != nil {
		return "", err
	}
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return first, nil
}
