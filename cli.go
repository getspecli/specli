package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const lintUsage = `Usage:
  specli lint [directory] [options]

Checks the Markdown specs of a directory (placeholders, empty sections, broken
relative links and the rules of .specli.yml) and exits 1 if there are findings.

Options:
  --format text|json|github   Output format (default text). "github" prints
                              workflow annotations for GitHub Actions.
`

const bundleUsage = `Usage:
  specli bundle <file.md> [options]

Writes a Markdown spec together with the specs it links to as one document,
ready to paste into an agent prompt. Every file is introduced by an
HTML comment holding its path.

Options:
  --root DIR      Directory the specs live in (default: current directory)
  --depth N       How many link levels to follow (default 1, 0 = only the file, -1 = all)
  --out FILE      Write to FILE instead of standard output
`

// runSubcommand handles "specli lint" and "specli bundle". It returns false if
// args do not name a subcommand.
func runSubcommand(args []string, stdout, stderr io.Writer) (code int, handled bool) {
	if len(args) == 0 {
		return 0, false
	}
	switch args[0] {
	case "lint":
		return runLint(args[1:], stdout, stderr), true
	case "bundle":
		return runBundle(args[1:], stdout, stderr), true
	}
	return 0, false
}

// parseInterspersed parses flags that may come before or after positional arguments.
func parseInterspersed(fl *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fl.Parse(args); err != nil {
			return nil, err
		}
		rest := fl.Args()
		if len(rest) == 0 {
			return pos, nil
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
}

func resolveRoot(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err == nil {
		abs, err = filepath.EvalSymlinks(abs)
	}
	if err != nil {
		return "", err
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		return "", fmt.Errorf("%s is not a directory", abs)
	}
	return abs, nil
}

type lintFinding struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	Rule    string `json:"rule"`
	Message string `json:"message"`
}

func runLint(args []string, stdout, stderr io.Writer) int {
	fl := flag.NewFlagSet("specli lint", flag.ContinueOnError)
	fl.SetOutput(stderr)
	fl.Usage = func() { fmt.Fprint(stderr, lintUsage) }
	format := fl.String("format", "text", "")
	pos, err := parseInterspersed(fl, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if len(pos) > 1 || *format != "text" && *format != "json" && *format != "github" {
		fl.Usage()
		return 2
	}
	dir := "."
	if len(pos) == 1 {
		dir = pos[0]
	}
	root, err := resolveRoot(dir)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}

	sc := newScanner(root, false)
	files, err := sc.scan()
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	if sc.cfgErr != nil {
		fmt.Fprintln(stderr, "error:", sc.cfgErr)
		return 2
	}
	findings := []lintFinding{}
	for _, f := range files {
		if f.Kind != "markdown" || f.Lint == 0 {
			continue
		}
		full := filepath.Join(root, filepath.FromSlash(f.Path))
		st, err := os.Stat(full)
		if err != nil {
			continue
		}
		_, issues := sc.lint(full, filepath.FromSlash(f.Path), st)
		for _, is := range issues {
			findings = append(findings, lintFinding{f.Path, is.Line, is.Rule, is.Message})
		}
	}

	switch *format {
	case "json":
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		enc.Encode(findings)
	case "github":
		for _, f := range findings {
			fmt.Fprintf(stdout, "::warning file=%s,line=%d,title=%s::%s\n", f.File, f.Line, f.Rule, f.Message)
		}
	default:
		for _, f := range findings {
			fmt.Fprintf(stdout, "%s:%d: %s: %s\n", f.File, f.Line, f.Rule, f.Message)
		}
		if len(findings) > 0 {
			fmt.Fprintf(stderr, "%d %s in %d Markdown files\n", len(findings), plural(len(findings), "issue", "issues"), countKind(files, "markdown"))
		}
	}
	if len(findings) > 0 {
		return 1
	}
	return 0
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func countKind(files []FileInfo, kind string) int {
	n := 0
	for _, f := range files {
		if f.Kind == kind {
			n++
		}
	}
	return n
}

func runBundle(args []string, stdout, stderr io.Writer) int {
	fl := flag.NewFlagSet("specli bundle", flag.ContinueOnError)
	fl.SetOutput(stderr)
	fl.Usage = func() { fmt.Fprint(stderr, bundleUsage) }
	rootDir := fl.String("root", ".", "")
	depth := fl.Int("depth", 1, "")
	out := fl.String("out", "", "")
	pos, err := parseInterspersed(fl, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if len(pos) != 1 {
		fl.Usage()
		return 2
	}
	root, err := resolveRoot(*rootDir)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	file, err := filepath.Abs(pos[0])
	if err == nil {
		file, err = filepath.EvalSymlinks(file)
	}
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	text, included, warnings, err := buildBundle(root, file, *depth)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	for _, w := range warnings {
		fmt.Fprintln(stderr, "warning:", w)
	}
	if *out != "" {
		if err := os.WriteFile(*out, []byte(text), 0o644); err != nil {
			fmt.Fprintln(stderr, "error:", err)
			return 1
		}
	} else if _, err := io.WriteString(stdout, text); err != nil {
		return 1
	}
	fmt.Fprintf(stderr, "bundled %d %s\n", len(included), plural(len(included), "spec", "specs"))
	return 0
}

// buildBundle concatenates a Markdown file and the Markdown files it links to
// (breadth first, each file once) up to depth levels; depth < 0 follows all links.
func buildBundle(root, file string, depth int) (text string, included, warnings []string, err error) {
	rel0, err := filepath.Rel(root, file)
	if err != nil || !within(root, file) {
		return "", nil, nil, fmt.Errorf("%s is outside %s", file, root)
	}
	if kindByExt(file) != "markdown" {
		return "", nil, nil, fmt.Errorf("%s is not a Markdown file", filepath.ToSlash(rel0))
	}
	type item struct {
		path  string
		depth int
	}
	queue := []item{{file, 0}}
	seen := map[string]bool{file: true}
	var b strings.Builder
	for i := 0; i < len(queue); i++ {
		it := queue[i]
		rel, _ := filepath.Rel(root, it.path)
		rel = filepath.ToSlash(rel)
		data, rerr := readSpec(it.path)
		if rerr != nil {
			if i == 0 {
				return "", nil, nil, rerr
			}
			warnings = append(warnings, fmt.Sprintf("%s: %v", rel, rerr))
			continue
		}
		included = append(included, rel)
		if b.Len() == 0 {
			b.WriteString("<!-- specli bundle of " + rel + " -->\n\n")
		}
		fmt.Fprintf(&b, "<!-- ===== %s ===== -->\n\n%s\n\n", rel, strings.TrimRight(data, "\n"))
		if depth >= 0 && it.depth >= depth {
			continue
		}
		for _, l := range lintMarkdown(data, nil).links {
			target, ok := linkedSpec(root, it.path, l.target)
			if !ok {
				continue
			}
			if _, err := os.Stat(target); err != nil {
				warnings = append(warnings, fmt.Sprintf("%s:%d: broken link %s", rel, l.line, l.target))
				continue
			}
			if !seen[target] {
				seen[target] = true
				queue = append(queue, item{target, it.depth + 1})
			}
		}
	}
	return b.String(), included, warnings, nil
}

func readSpec(p string) (string, error) {
	st, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", errors.New("not a regular file")
	}
	if st.Size() > maxFileSize {
		return "", errors.New("file too large")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return strings.ReplaceAll(string(b), "\r\n", "\n"), nil
}

// linkedSpec resolves a relative link of the Markdown file from to an absolute
// path, ok=false unless it is a Markdown file inside root that is not hidden.
func linkedSpec(root, from, target string) (string, bool) {
	if target == "" || strings.HasPrefix(target, "#") || strings.HasPrefix(target, "/") || lintSchemeRe.MatchString(target) {
		return "", false
	}
	if i := strings.IndexAny(target, "#?"); i >= 0 {
		target = target[:i]
	}
	if target == "" || kindByExt(target) != "markdown" {
		return "", false
	}
	full := filepath.Join(filepath.Dir(from), filepath.FromSlash(unescapeLink(target)))
	if !within(root, full) {
		return "", false
	}
	rel, err := filepath.Rel(root, full)
	if err != nil {
		return "", false
	}
	for _, seg := range strings.Split(rel, string(filepath.Separator)) {
		if skipDir(seg) {
			return "", false
		}
	}
	return full, true
}
