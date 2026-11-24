package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// releasesAPI is a variable so tests can point it at a local server.
var releasesAPI = "https://api.github.com/repos/getspecli/specli/releases/latest"

const (
	updateCacheTTL = time.Hour
	updateRetryTTL = 5 * time.Minute // after a failed check
	maxBinarySize  = 200 << 20
)

type release struct {
	Tag    string `json:"tag_name"`
	URL    string `json:"html_url"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r *release) asset(name string) string {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL
		}
	}
	return ""
}

var updateClient = &http.Client{Timeout: 30 * time.Second}

func httpGet(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "specli/"+version)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := updateClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound && url == releasesAPI {
		return nil, errors.New("no release has been published yet")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("GET %s: response too large", url)
	}
	return b, nil
}

func fetchLatest(ctx context.Context) (*release, error) {
	b, err := httpGet(ctx, releasesAPI, 1<<20)
	if err != nil {
		return nil, err
	}
	var r release
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if _, ok := parseVersion(r.Tag); !ok {
		return nil, fmt.Errorf("unexpected release tag %q", r.Tag)
	}
	return &r, nil
}

// parseVersion reads the leading "v1.2.3" of a version string. Builds from
// "git describe" (v0.2.0-3-gabc) parse as their base release; "dev" does not parse.
func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// isNewer reports whether latest is a higher release than current. A build
// that is already past a release (v0.2.0-3-gabc) counts as that release.
func isNewer(current, latest string) bool {
	c, ok1 := parseVersion(current)
	l, ok2 := parseVersion(latest)
	if !ok1 || !ok2 {
		return false
	}
	for i := range c {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

// ---- update notice for the UI ----

type updateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	Available bool   `json:"available"`
	URL       string `json:"url,omitempty"`
	// Manager names the package manager that owns this binary ("homebrew"),
	// so the UI can suggest its upgrade command instead of --self-update.
	Manager string `json:"manager,omitempty"`
}

type updateChecker struct {
	enabled bool
	mu      sync.Mutex
	at      time.Time
	ttl     time.Duration
	cached  updateInfo
}

func newUpdateChecker(enabled bool) *updateChecker {
	_, ok := parseVersion(version)
	return &updateChecker{enabled: enabled && ok, cached: updateInfo{Current: version, Manager: installManager()}}
}

// Check returns the cached result, refreshing it at most every updateCacheTTL.
// Network errors are swallowed (and retried after updateRetryTTL): the notice is
// best-effort and must never get in the way of the editor.
func (u *updateChecker) Check(ctx context.Context) updateInfo {
	if !u.enabled {
		return u.cached
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.at.IsZero() && time.Since(u.at) < u.ttl {
		return u.cached
	}
	u.at = time.Now()
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	r, err := fetchLatest(cctx)
	if err != nil {
		u.ttl = updateRetryTTL
		return u.cached
	}
	u.ttl = updateCacheTTL
	u.cached = updateInfo{Current: version, Latest: r.Tag, Available: isNewer(version, r.Tag), URL: r.URL, Manager: u.cached.Manager}
	return u.cached
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.upd.Check(r.Context()))
}

// upgradeHint is the command that installs a newer release for this install.
func upgradeHint(manager string) string {
	if manager == "homebrew" {
		return "brew upgrade specli"
	}
	return "specli --self-update"
}

// runCheckUpdate implements --check-update: it always asks GitHub (no cache)
// and reports whether a newer release exists.
func runCheckUpdate(ctx context.Context, out io.Writer) error {
	if _, ok := parseVersion(version); !ok {
		return fmt.Errorf("this is a development build (%s), cannot compare versions", version)
	}
	rel, err := fetchLatest(ctx)
	if err != nil {
		return fmt.Errorf("checking for updates: %w", err)
	}
	if !isNewer(version, rel.Tag) {
		fmt.Fprintf(out, "specli %s is up to date (latest release: %s)\n", version, rel.Tag)
		return nil
	}
	fmt.Fprintf(out, "update available: %s -> %s\n  %s\n  install with: %s\n", version, rel.Tag, rel.URL, upgradeHint(installManager()))
	return nil
}

// ---- self-update ----

// isHomebrewPath reports whether exe (symlinks resolved) lives in a Homebrew
// Cellar, i.e. brew owns the file and replacing it would break its bookkeeping.
func isHomebrewPath(exe string) bool {
	return strings.Contains(filepath.ToSlash(exe), "/Cellar/")
}

// installManager returns "homebrew" when the running binary was installed by brew.
func installManager() string {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err == nil && isHomebrewPath(exe) {
		return "homebrew"
	}
	return ""
}

func archiveName(tag, goos, goarch string) string {
	ext := ".tar.gz"
	if goos == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("specli_%s_%s_%s%s", tag, goos, goarch, ext)
}

func exeName(goos string) string {
	if goos == "windows" {
		return "specli.exe"
	}
	return "specli"
}

// checksumFor finds the sha256 of name in a "sha256sum" style file.
func checksumFor(sums []byte, name string) (string, bool) {
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return strings.ToLower(f[0]), true
		}
	}
	return "", false
}

func extractBinary(archive []byte, name, exe string) ([]byte, error) {
	if strings.HasSuffix(name, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if path.Base(f.Name) != exe || f.FileInfo().IsDir() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return readCapped(rc)
		}
		return nil, fmt.Errorf("%s not found in %s", exe, name)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("%s not found in %s", exe, name)
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag == tar.TypeReg && path.Base(h.Name) == exe {
			return readCapped(tr)
		}
	}
}

func readCapped(r io.Reader) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, maxBinarySize+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxBinarySize {
		return nil, errors.New("binary too large")
	}
	return b, nil
}

// replaceExecutable swaps the file at exe for bin. The new file is written
// next to the target so the final rename stays on one filesystem. Windows
// cannot overwrite a running exe but can rename it, so the old one is moved
// aside first.
func replaceExecutable(exe string, bin []byte) error {
	dir := filepath.Dir(exe)
	tmp, err := os.CreateTemp(dir, ".specli-update-*")
	if err != nil {
		return fmt.Errorf("cannot write to %s (try with sufficient permissions): %w", dir, err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(bin); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return err
		}
		if err := os.Rename(tmp.Name(), exe); err != nil {
			os.Rename(old, exe)
			return err
		}
		return nil
	}
	return os.Rename(tmp.Name(), exe)
}

// selfUpdate downloads the latest release for this platform, verifies it
// against the release's checksums.txt and replaces the binary at exe.
func selfUpdate(ctx context.Context, exe string, out io.Writer) error {
	if _, ok := parseVersion(version); !ok {
		return fmt.Errorf("this is a development build (%s), refusing to self-update", version)
	}
	rel, err := fetchLatest(ctx)
	if err != nil {
		return fmt.Errorf("checking for updates: %w", err)
	}
	if !isNewer(version, rel.Tag) {
		fmt.Fprintf(out, "specli %s is up to date (latest release: %s)\n", version, rel.Tag)
		return nil
	}
	name := archiveName(rel.Tag, runtime.GOOS, runtime.GOARCH)
	archiveURL, sumsURL := rel.asset(name), rel.asset("checksums.txt")
	if archiveURL == "" {
		return fmt.Errorf("release %s has no build for %s/%s", rel.Tag, runtime.GOOS, runtime.GOARCH)
	}
	if sumsURL == "" {
		return fmt.Errorf("release %s has no checksums.txt, refusing to install unverified binary", rel.Tag)
	}

	fmt.Fprintf(out, "updating %s -> %s\n", version, rel.Tag)
	sums, err := httpGet(ctx, sumsURL, 1<<20)
	if err != nil {
		return err
	}
	want, ok := checksumFor(sums, name)
	if !ok {
		return fmt.Errorf("no checksum for %s in checksums.txt", name)
	}
	archive, err := httpGet(ctx, archiveURL, maxBinarySize)
	if err != nil {
		return err
	}
	got := sha256.Sum256(archive)
	if hex.EncodeToString(got[:]) != want {
		return fmt.Errorf("checksum mismatch for %s", name)
	}
	bin, err := extractBinary(archive, name, exeName(runtime.GOOS))
	if err != nil {
		return err
	}
	if err := replaceExecutable(exe, bin); err != nil {
		return err
	}
	fmt.Fprintf(out, "updated %s to %s\n", exe, rel.Tag)
	return nil
}

func runSelfUpdate() error {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		return err
	}
	if isHomebrewPath(exe) {
		return errors.New("specli was installed with Homebrew; update it with: brew upgrade specli")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return selfUpdate(ctx, exe, os.Stdout)
}
