package main

import (
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// rewriteLinks adjusts the relative links of one Markdown text.
//
// The file lives in oldDir and will live in newDir (both absolute). When
// movedFrom is set, links that point at that file are redirected to movedTo.
// Links in code blocks and inline code, external URLs, anchors and absolute
// paths are left alone. It returns the new text and the number of links changed.
func rewriteLinks(text, oldDir, newDir, movedFrom, movedTo string) (string, int) {
	lines := strings.Split(text, "\n")
	changed := 0
	inFence := false
	for i, ln := range lines {
		if lintFenceRe.MatchString(ln) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		spans := lintCodeRe.FindAllStringIndex(ln, -1)
		matches := lintLinkRe.FindAllStringSubmatchIndex(ln, -1)
		for j := len(matches) - 1; j >= 0; j-- { // right to left keeps the offsets valid
			m := matches[j]
			if inSpan(spans, m[0]) {
				continue
			}
			target := ln[m[2]:m[3]]
			nt, ok := retarget(target, oldDir, newDir, movedFrom, movedTo)
			if !ok {
				continue
			}
			ln = ln[:m[2]] + nt + ln[m[3]:]
			changed++
		}
		lines[i] = ln
	}
	return strings.Join(lines, "\n"), changed
}

func inSpan(spans [][]int, pos int) bool {
	for _, s := range spans {
		if pos >= s[0] && pos < s[1] {
			return true
		}
	}
	return false
}

// retarget computes the replacement for one link target, ok=false if unchanged.
func retarget(t, oldDir, newDir, movedFrom, movedTo string) (string, bool) {
	if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "/") || lintSchemeRe.MatchString(t) {
		return "", false
	}
	pathPart, suffix := t, ""
	if i := strings.IndexAny(t, "#?"); i >= 0 {
		pathPart, suffix = t[:i], t[i:]
	}
	if pathPart == "" {
		return "", false
	}
	abs := filepath.Join(oldDir, filepath.FromSlash(unescapeLink(pathPart)))
	dest := abs
	if movedFrom != "" && abs == movedFrom {
		dest = movedTo
	}
	if oldDir == newDir && dest == abs {
		return "", false
	}
	rel, err := filepath.Rel(newDir, dest)
	if err != nil {
		return "", false
	}
	rel = filepath.ToSlash(rel)
	if strings.HasPrefix(pathPart, "./") && !strings.HasPrefix(rel, "../") {
		rel = "./" + rel
	}
	if strings.Contains(pathPart, "%") {
		segs := strings.Split(rel, "/")
		for k, sg := range segs {
			if sg != "." && sg != ".." {
				segs[k] = url.PathEscape(sg)
			}
		}
		rel = strings.Join(segs, "/")
	} else {
		rel = strings.ReplaceAll(rel, " ", "%20")
	}
	if rel+suffix == t {
		return "", false
	}
	return rel + suffix, true
}

// fixLinksAfterMove updates the Markdown files of the root after from was
// renamed to to: links to the moved file, and the relative links inside it if
// it changed folder. It returns the number of files it rewrote.
func fixLinksAfterMove(root, from, to string) int {
	updated := 0
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if p != root && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || kindByExt(d.Name()) != "markdown" {
			return nil
		}
		oldDir, newDir := filepath.Dir(p), filepath.Dir(p)
		if p == to {
			oldDir = filepath.Dir(from)
		}
		if rewriteFile(p, oldDir, newDir, from, to) {
			updated++
		}
		return nil
	})
	return updated
}

// rewriteFile rewrites the links of one Markdown file in place.
func rewriteFile(p, oldDir, newDir, movedFrom, movedTo string) bool {
	st, err := os.Stat(p)
	if err != nil || st.Size() > maxFileSize {
		return false
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return false
	}
	out, n := rewriteLinks(string(b), oldDir, newDir, movedFrom, movedTo)
	if n == 0 {
		return false
	}
	return atomicWrite(p, []byte(out), st.Mode().Perm()) == nil
}

// atomicWrite replaces a file by writing a temp file next to it and renaming.
func atomicWrite(full string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(full), ".specli-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = tmp.Write(data)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(name, mode)
	}
	if err == nil {
		err = os.Rename(name, full)
	}
	if err != nil {
		os.Remove(name)
	}
	return err
}
