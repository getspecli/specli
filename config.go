package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// configNames are the project config files looked up in the served directory.
var configNames = []string{".specli.yml", ".specli.yaml"}

// lintRules are the rule names that can be disabled in the config.
var lintRules = []string{"placeholder", "empty-section", "broken-link", "missing-section"}

var defaultPlaceholders = []string{"TODO", "TBD", "FIXME", "XXX", "lorem ipsum"}

// lintConfig is the lint section of .specli.yml:
//
//	lint:
//	  disable: [empty-section]
//	  placeholders: [TODO, TBD, "<fill in>"]
//	  ignore: ["archive/**"]
//	  require-sections:
//	    "specs/**": [Goal, Acceptance Criteria]
type lintConfig struct {
	disabled     map[string]bool
	placeholders *regexp.Regexp
	ignore       []*regexp.Regexp
	require      []requireRule
}

type requireRule struct {
	glob     *regexp.Regexp
	sections []string
}

func defaultLintConfig() *lintConfig {
	lc := &lintConfig{disabled: map[string]bool{}}
	lc.placeholders = placeholderRe(defaultPlaceholders)
	return lc
}

func placeholderRe(words []string) *regexp.Regexp {
	var parts []string
	for _, w := range words {
		if w == "" {
			continue
		}
		p := regexp.QuoteMeta(w)
		if isWordChar(w[0]) {
			p = `\b` + p
		}
		if isWordChar(w[len(w)-1]) {
			p += `\b`
		}
		parts = append(parts, p)
	}
	if len(parts) == 0 {
		return nil
	}
	return regexp.MustCompile(`(?i)` + strings.Join(parts, "|"))
}

func isWordChar(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// globRe converts a glob ("*" within a folder, "**" across folders, "?") to a
// regexp that matches slash separated paths relative to the root.
func globRe(glob string) (*regexp.Regexp, error) {
	glob = strings.TrimPrefix(filepath.ToSlash(glob), "./")
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(glob); i++ {
		switch c := glob[i]; {
		case c == '*' && i+1 < len(glob) && glob[i+1] == '*':
			i++
			if i+1 < len(glob) && glob[i+1] == '/' {
				i++
				b.WriteString(`(?:.*/)?`)
			} else {
				b.WriteString(`.*`)
			}
		case c == '*':
			b.WriteString(`[^/]*`)
		case c == '?':
			b.WriteString(`[^/]`)
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

// findConfig returns the path of the config file in root, or "".
func findConfig(root string) string {
	for _, n := range configNames {
		p := filepath.Join(root, n)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			return p
		}
	}
	return ""
}

// loadLintConfig reads the project config; a missing file gives the defaults.
func loadLintConfig(root string) (*lintConfig, error) {
	p := findConfig(root)
	if p == "" {
		return defaultLintConfig(), nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return defaultLintConfig(), err
	}
	lc, err := parseLintConfig(string(b))
	if err != nil {
		return defaultLintConfig(), fmt.Errorf("%s: %w", filepath.Base(p), err)
	}
	return lc, nil
}

func parseLintConfig(src string) (*lintConfig, error) {
	tree, err := miniYAML(src)
	if err != nil {
		return nil, err
	}
	lc := defaultLintConfig()
	for key, v := range tree {
		if key != "lint" {
			return nil, fmt.Errorf("unknown key %q (supported: lint)", key)
		}
		sec, ok := v.(map[string]any)
		if !ok && v != nil {
			return nil, fmt.Errorf("lint must be a mapping")
		}
		for k, val := range sec {
			switch k {
			case "disable":
				for _, r := range asList(val) {
					if !contains(lintRules, r) {
						return nil, fmt.Errorf("lint.disable: unknown rule %q (rules: %s)", r, strings.Join(lintRules, ", "))
					}
					lc.disabled[r] = true
				}
			case "placeholders":
				lc.placeholders = placeholderRe(asList(val))
			case "ignore":
				for _, g := range asList(val) {
					re, err := globRe(g)
					if err != nil {
						return nil, fmt.Errorf("lint.ignore: bad pattern %q", g)
					}
					lc.ignore = append(lc.ignore, re)
				}
			case "require-sections":
				m, ok := val.(map[string]any)
				if !ok && val != nil {
					return nil, fmt.Errorf("lint.require-sections must map a path pattern to a list of headings")
				}
				for g, secs := range m {
					re, err := globRe(g)
					if err != nil {
						return nil, fmt.Errorf("lint.require-sections: bad pattern %q", g)
					}
					lc.require = append(lc.require, requireRule{re, asList(secs)})
				}
			default:
				return nil, fmt.Errorf("unknown key lint.%s", k)
			}
		}
	}
	return lc, nil
}

func asList(v any) []string {
	switch t := v.(type) {
	case []string:
		return t
	case string:
		return []string{t}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func (lc *lintConfig) ignored(rel string) bool {
	rel = filepath.ToSlash(rel)
	for _, re := range lc.ignore {
		if re.MatchString(rel) {
			return true
		}
	}
	return false
}

// ---- a tiny YAML subset: mappings, lists of scalars, [a, b] lists, quotes, comments ----

type yline struct {
	indent int
	text   string
}

func miniYAML(src string) (map[string]any, error) {
	var ls []yline
	for n, raw := range strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n") {
		t := strings.TrimRight(stripYComment(raw), " \t")
		if strings.TrimSpace(t) == "" {
			continue
		}
		lead := t[:len(t)-len(strings.TrimLeft(t, " \t"))]
		if strings.Contains(lead, "\t") {
			return nil, fmt.Errorf("line %d: use spaces, not tabs, for indentation", n+1)
		}
		ls = append(ls, yline{len(lead), strings.TrimSpace(t)})
	}
	if len(ls) == 0 {
		return map[string]any{}, nil
	}
	pos := 0
	v, err := parseYBlock(ls, &pos, ls[0].indent)
	if err != nil {
		return nil, err
	}
	if pos < len(ls) {
		return nil, fmt.Errorf("unexpected indentation near %q", ls[pos].text)
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("expected a mapping at the top level")
	}
	return m, nil
}

func stripYComment(s string) string {
	var q byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case q != 0:
			if c == q {
				q = 0
			}
		case c == '"' || c == '\'':
			q = c
		case c == '#' && (i == 0 || s[i-1] == ' ' || s[i-1] == '\t'):
			return s[:i]
		}
	}
	return s
}

func isYItem(t string) bool { return t == "-" || strings.HasPrefix(t, "- ") }

func parseYBlock(ls []yline, pos *int, indent int) (any, error) {
	if *pos >= len(ls) {
		return nil, nil
	}
	if isYItem(ls[*pos].text) {
		var list []string
		for *pos < len(ls) && ls[*pos].indent == indent && isYItem(ls[*pos].text) {
			list = append(list, yScalar(strings.TrimSpace(ls[*pos].text[1:])))
			*pos++
		}
		return list, nil
	}
	m := map[string]any{}
	for *pos < len(ls) && ls[*pos].indent == indent {
		l := ls[*pos]
		if isYItem(l.text) {
			return nil, fmt.Errorf("unexpected list item %q", l.text)
		}
		key, rest, ok := ySplit(l.text)
		if !ok {
			return nil, fmt.Errorf("expected \"key: value\", got %q", l.text)
		}
		*pos++
		if rest != "" {
			m[key] = yValue(rest)
			continue
		}
		if *pos < len(ls) && (ls[*pos].indent > indent || ls[*pos].indent == indent && isYItem(ls[*pos].text)) {
			child, err := parseYBlock(ls, pos, ls[*pos].indent)
			if err != nil {
				return nil, err
			}
			m[key] = child
		} else {
			m[key] = nil
		}
	}
	return m, nil
}

// ySplit splits "key: value" where key may be quoted.
func ySplit(t string) (key, rest string, ok bool) {
	if t[0] == '"' || t[0] == '\'' {
		end := strings.IndexByte(t[1:], t[0])
		if end < 0 {
			return "", "", false
		}
		key, t = t[1:end+1], strings.TrimSpace(t[end+2:])
		if !strings.HasPrefix(t, ":") {
			return "", "", false
		}
		return key, strings.TrimSpace(t[1:]), true
	}
	if strings.HasSuffix(t, ":") {
		return strings.TrimSpace(t[:len(t)-1]), "", true
	}
	i := strings.Index(t, ": ")
	if i < 0 {
		return "", "", false
	}
	return strings.TrimSpace(t[:i]), strings.TrimSpace(t[i+2:]), true
}

func yValue(s string) any {
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		var out []string
		var cur strings.Builder
		var q byte
		flush := func() {
			if v := strings.TrimSpace(cur.String()); v != "" {
				out = append(out, yScalar(v))
			}
			cur.Reset()
		}
		for i := 1; i < len(s)-1; i++ {
			c := s[i]
			switch {
			case q != 0:
				if c == q {
					q = 0
				}
				cur.WriteByte(c)
			case c == '"' || c == '\'':
				q = c
				cur.WriteByte(c)
			case c == ',':
				flush()
			default:
				cur.WriteByte(c)
			}
		}
		flush()
		return out
	}
	return yScalar(s)
}

func yScalar(s string) string {
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		return s[1 : len(s)-1]
	}
	return s
}
