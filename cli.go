package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const lintUsage = `Usage:
  specli lint [directory] [options]

Checks the Markdown specs of a directory (placeholders, empty sections, broken
relative links and the rules of .specli.yml) and exits 1 if there are findings.

Options:
  --format text|json|github   Output format (default text). "github" prints
                              workflow annotations for GitHub Actions.
`

// runSubcommand handles "specli lint". It returns false if
// args do not name a subcommand.
func runSubcommand(args []string, stdout, stderr io.Writer) (code int, handled bool) {
	if len(args) == 0 {
		return 0, false
	}
	switch args[0] {
	case "lint":
		return runLint(args[1:], stdout, stderr), true
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
