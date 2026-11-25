package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

//go:embed all:web/dist
var webFS embed.FS

// version is set at build time: -ldflags "-X main.version=1.2.3"
var version = "dev"

type config struct {
	root        string
	host        string
	port        int
	portSet     bool
	noOpen      bool
	readonly    bool
	includeData bool
	puServer    string
	puJar       string
	showVersion bool
	selfUpdate  bool
	checkUpdate bool
	noUpdateChk bool
	noGit       bool
}

const usage = `specli - browser viewer/editor for spec-driven design artifacts
(Markdown, PlantUML, Mermaid, OpenAPI/Swagger and AsyncAPI YAML/JSON)

Usage:
  specli [directory] [options]

Options:
  --port N               Port to listen on (default 4747, next free port if busy; 0 = random)
  --host ADDR            Address to bind (default 127.0.0.1). Non-loopback addresses force --readonly.
  --no-open              Do not open the browser
  --readonly             Disable saving/creating files
  --include-data         Also list non-API .yaml/.yml/.json files (editor only)
  --plantuml-server URL  Optional: render PlantUML on a server instead of the built-in browser engine.
                         The endpoint must accept the diagram as POST body and return SVG
                         (Kroki: http://host:8000/plantuml/svg, plantuml-server: http://host:8080/svg).
                         Env: SPECLI_PLANTUML_SERVER
  --plantuml-jar PATH    Optional: render PlantUML locally with "java -jar PATH".
                         Env: SPECLI_PLANTUML_JAR
  --check-update         Check whether a newer release exists and exit
  --self-update          Download the latest release, verify its checksum and replace this binary
  --no-update-check      Do not ask GitHub whether a newer release exists (the UI notice).
                         Env: SPECLI_NO_UPDATE_CHECK=1
  --no-git               Do not run the system git to show branch and change status.
                         Env: SPECLI_NO_GIT=1
  --version              Print version

By default PlantUML and Mermaid are rendered inside your browser; diagram text never leaves
your machine unless you configure a PlantUML server yourself. The only other outbound request is
the update check against the GitHub releases API (disable with --no-update-check).
`

func parseArgs(args []string) (*config, error) {
	cfg := &config{}
	flags := flag.NewFlagSet("specli", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	flags.StringVar(&cfg.host, "host", "127.0.0.1", "")
	flags.IntVar(&cfg.port, "port", 4747, "")
	flags.BoolVar(&cfg.noOpen, "no-open", false, "")
	flags.BoolVar(&cfg.readonly, "readonly", false, "")
	flags.BoolVar(&cfg.includeData, "include-data", false, "")
	flags.StringVar(&cfg.puServer, "plantuml-server", os.Getenv("SPECLI_PLANTUML_SERVER"), "")
	flags.StringVar(&cfg.puJar, "plantuml-jar", os.Getenv("SPECLI_PLANTUML_JAR"), "")
	flags.BoolVar(&cfg.showVersion, "version", false, "")
	flags.BoolVar(&cfg.checkUpdate, "check-update", false, "")
	flags.BoolVar(&cfg.selfUpdate, "self-update", false, "")
	flags.BoolVar(&cfg.noGit, "no-git", os.Getenv("SPECLI_NO_GIT") != "", "")
	flags.BoolVar(&cfg.noUpdateChk, "no-update-check", os.Getenv("SPECLI_NO_UPDATE_CHECK") != "", "")

	// Go's flag package stops at the first positional argument; allow
	// "specli ./docs --port 5000" by parsing repeatedly.
	var positional []string
	for {
		if err := flags.Parse(args); err != nil {
			return nil, err
		}
		rest := flags.Args()
		if len(rest) == 0 {
			break
		}
		positional = append(positional, rest[0])
		args = rest[1:]
	}
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "port" {
			cfg.portSet = true
		}
	})
	if len(positional) > 1 {
		return nil, fmt.Errorf("expected at most one directory, got %d", len(positional))
	}
	cfg.root = "."
	if len(positional) == 1 {
		cfg.root = positional[0]
	}
	return cfg, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func listen(cfg *config) (net.Listener, error) {
	if cfg.portSet || cfg.port == 0 {
		return net.Listen("tcp", net.JoinHostPort(cfg.host, fmt.Sprint(cfg.port)))
	}
	var lastErr error
	for p := cfg.port; p < cfg.port+20; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort(cfg.host, fmt.Sprint(p)))
		if err == nil {
			return ln, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "could not open browser (%v) - open %s manually\n", err, url)
		return
	}
	go cmd.Wait()
}

func main() {
	cfg, err := parseArgs(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}
	if cfg.showVersion {
		fmt.Println(version)
		return
	}

	if cfg.checkUpdate {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := runCheckUpdate(ctx, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		return
	}

	if cfg.selfUpdate {
		if err := runSelfUpdate(); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		return
	}

	abs, err := filepath.Abs(cfg.root)
	if err == nil {
		abs, err = filepath.EvalSymlinks(abs)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		fmt.Fprintf(os.Stderr, "error: %s is not a directory\n", abs)
		os.Exit(1)
	}

	if !isLoopback(cfg.host) && !cfg.readonly {
		fmt.Fprintln(os.Stderr, "warning: binding to a non-loopback address - forcing --readonly")
		cfg.readonly = true
	}

	ln, err := listen(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: cannot listen:", err)
		os.Exit(1)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	dist, err := fs.Sub(webFS, "web/dist")
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	srv := newServer(cfg, abs, dist, port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.watch(ctx)

	httpSrv := &http.Server{Handler: srv.routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		httpSrv.Shutdown(sctx)
	}()

	shown := cfg.host
	if shown == "0.0.0.0" || shown == "::" || shown == "" {
		shown = "localhost"
	}
	url := "http://" + net.JoinHostPort(shown, fmt.Sprint(port))
	mode := "read/write"
	if cfg.readonly {
		mode = "read-only"
	}
	fmt.Printf("specli %s - serving %s (%s)\n  %s\n  PlantUML: %s\n  Ctrl+C to stop\n",
		version, abs, mode, url, srv.pu.Describe())
	go func() {
		if u := srv.upd.Check(ctx); u.Available {
			fmt.Printf("  Update available: %s (you have %s) - run: %s\n", u.Latest, u.Current, upgradeHint(u.Manager))
		}
	}()
	if !cfg.noOpen {
		openBrowser(url)
	}

	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
