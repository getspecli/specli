package main

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Issue is one finding of the Markdown spec linter.
type Issue struct {
	Line    int    `json:"line"`
	Rule    string `json:"rule"` // placeholder | empty-section | broken-link | missing-section
	Message string `json:"message"`
}

var (
	lintFrontRe   = regexp.MustCompile(`^\x{FEFF}?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)`)
	lintStatusRe  = regexp.MustCompile(`(?m)^status[ \t]*:[ \t]*(.*?)[ \t]*$`)
	lintHeadingRe = regexp.MustCompile(`^(#{1,6})[ \t]+(\S.*?)[ \t#]*$`)
	lintFenceRe   = regexp.MustCompile("^[ \t]*(```|~~~)")
	lintCodeRe    = regexp.MustCompile("`[^`\n]*`")
	lintLinkRe    = regexp.MustCompile(`!?\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)`)
	lintSchemeRe  = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
)

type linkRef struct {
	line   int
	target string
}

// lintResult is what is derived from the file content alone, so it can be
// cached per file version. Link targets are checked against the disk later.
type lintResult struct {
	status   string
	issues   []Issue
	links    []linkRef
	headings []string // lower case titles, for the required sections check
}

// lintMarkdown analyses the text of one Markdown file.
// placeholders may be nil to skip the placeholder rule.
func lintMarkdown(text string, placeholders *regexp.Regexp) lintResult {
	var res lintResult
	text = strings.ReplaceAll(text, "\r\n", "\n")
	body := text
	offset := 0 // lines taken by the front matter
	if m := lintFrontRe.FindStringSubmatchIndex(text); m != nil {
		fm := text[m[2]:m[3]]
		if sm := lintStatusRe.FindStringSubmatch(fm); sm != nil {
			v := strings.ToLower(strings.Trim(strings.TrimSpace(sm[1]), `"'`))
			res.status = v
		}
		offset = strings.Count(text[:m[1]], "\n")
		body = text[m[1]:]
	}

	type heading struct {
		line, level int
		title       string
		content     bool
	}
	var heads []heading
	inFence := false
	for i, ln := range strings.Split(body, "\n") {
		n := offset + i + 1
		if lintFenceRe.MatchString(ln) {
			inFence = !inFence
			if len(heads) > 0 {
				heads[len(heads)-1].content = true
			}
			continue
		}
		if inFence {
			if len(heads) > 0 {
				heads[len(heads)-1].content = true
			}
			continue
		}
		if m := lintHeadingRe.FindStringSubmatch(ln); m != nil {
			heads = append(heads, heading{line: n, level: len(m[1]), title: m[2]})
			res.headings = append(res.headings, strings.ToLower(strings.TrimSpace(m[2])))
			continue
		}
		if strings.TrimSpace(ln) == "" {
			continue
		}
		if len(heads) > 0 {
			heads[len(heads)-1].content = true
		}
		plain := lintCodeRe.ReplaceAllString(ln, "")
		if placeholders != nil {
			if m := placeholders.FindString(plain); m != "" {
				res.issues = append(res.issues, Issue{n, "placeholder", "Placeholder text: " + m})
			}
		}
		for _, m := range lintLinkRe.FindAllStringSubmatch(plain, -1) {
			res.links = append(res.links, linkRef{n, m[1]})
		}
	}
	// A section is empty if nothing follows its heading before the next heading
	// of the same or a higher level (a parent heading directly followed by a
	// subheading is fine).
	for i, h := range heads {
		if h.content {
			continue
		}
		if i+1 < len(heads) && heads[i+1].level > h.level {
			continue
		}
		res.issues = append(res.issues, Issue{h.line, "empty-section", "Empty section: " + h.title})
	}
	return res
}

// brokenLinks returns issues for relative links that point to a file that
// does not exist inside the root. External URLs and in-page anchors are skipped.
func brokenLinks(root, rel string, links []linkRef) []Issue {
	var out []Issue
	dir := filepath.Dir(filepath.FromSlash(rel))
	for _, l := range links {
		t := l.target
		if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "/") || strings.HasPrefix(t, "//") || lintSchemeRe.MatchString(t) {
			continue
		}
		if i := strings.IndexAny(t, "#?"); i >= 0 {
			t = t[:i]
		}
		if t == "" {
			continue
		}
		full := filepath.Join(root, dir, filepath.FromSlash(unescapeLink(t)))
		if !within(root, full) {
			out = append(out, Issue{l.line, "broken-link", "Link leaves the project: " + l.target})
			continue
		}
		if _, err := os.Stat(full); err != nil {
			out = append(out, Issue{l.line, "broken-link", "Broken link: " + l.target})
		}
	}
	return out
}

func unescapeLink(s string) string {
	if u, err := url.PathUnescape(s); err == nil {
		return u
	}
	return s
}
