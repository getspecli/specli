package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// PlantUML optionally renders diagram text to SVG on the server:
//   - "server": POST text to a configured HTTP endpoint (Kroki, plantuml-server, gopuml)
//   - "local":  run `java -jar plantuml.jar -pipe -tsvg`
//   - "none":   nothing configured; the browser renders with the built-in
//     engine (@plantuml/core), so no Java, Graphviz or server is needed
type PlantUML struct {
	mode   string
	server string
	cmd    []string
	sem    chan struct{}
	client *http.Client

	mu    sync.Mutex
	cache map[[32]byte][]byte
}

func newPlantUML(server, jar string) *PlantUML {
	p := &PlantUML{
		mode:   "none",
		sem:    make(chan struct{}, 3),
		client: &http.Client{Timeout: 30 * time.Second},
		cache:  map[[32]byte][]byte{},
	}
	switch {
	case server != "":
		p.mode, p.server = "server", server
	case jar != "":
		if java, err := exec.LookPath("java"); err == nil {
			if _, err := os.Stat(jar); err == nil {
				p.mode = "local"
				p.cmd = []string{java, "-Djava.awt.headless=true", "-jar", jar, "-pipe", "-tsvg", "-charset", "UTF-8"}
			}
		}
	}
	return p
}

func (p *PlantUML) Available() bool { return p.mode != "none" }

func (p *PlantUML) Describe() string {
	switch p.mode {
	case "server":
		return "server " + p.server
	case "local":
		return "local (" + strings.Join(p.cmd[:1], " ") + ")"
	}
	return "built-in engine (runs in the browser, no Java needed)"
}

func (p *PlantUML) Render(ctx context.Context, src []byte) ([]byte, error) {
	if !p.Available() {
		return nil, fmt.Errorf("PlantUML rendering is not configured")
	}
	key := sha256.Sum256(src)
	p.mu.Lock()
	if svg, ok := p.cache[key]; ok {
		p.mu.Unlock()
		return svg, nil
	}
	p.mu.Unlock()

	select {
	case p.sem <- struct{}{}:
		defer func() { <-p.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	var svg []byte
	var err error
	if p.mode == "server" {
		svg, err = p.renderServer(ctx, src)
	} else {
		svg, err = p.renderLocal(ctx, src)
	}
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	if len(p.cache) >= 200 {
		p.cache = map[[32]byte][]byte{}
	}
	p.cache[key] = svg
	p.mu.Unlock()
	return svg, nil
}

func (p *PlantUML) renderServer(ctx context.Context, src []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.server, bytes.NewReader(src))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	req.Header.Set("Accept", "image/svg+xml")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("PlantUML server: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, err
	}
	// Kroki answers syntax errors with 4xx and a text message; plantuml-server
	// answers with an SVG that shows the error. Pass both through usefully.
	if resp.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 500 {
			msg = msg[:500]
		}
		return nil, fmt.Errorf("PlantUML server returned %d: %s", resp.StatusCode, msg)
	}
	return body, nil
}

func (p *PlantUML) renderLocal(ctx context.Context, src []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, p.cmd[0], p.cmd[1:]...)
	cmd.Stdin = bytes.NewReader(src)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 500 {
			msg = msg[:500]
		}
		return nil, fmt.Errorf("plantuml failed: %v %s", err, msg)
	}
	return out.Bytes(), nil
}
