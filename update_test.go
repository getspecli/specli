package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunCheckUpdate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag_name":"v9.9.9","html_url":"https://example.com/r"}`))
	}))
	defer srv.Close()
	oldAPI, oldVer := releasesAPI, version
	defer func() { releasesAPI, version = oldAPI, oldVer }()
	releasesAPI = srv.URL

	version = "v0.1.0"
	var out bytes.Buffer
	if err := runCheckUpdate(context.Background(), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "update available: v0.1.0 -> v9.9.9") {
		t.Errorf("unexpected output: %q", out.String())
	}

	version = "v9.9.9"
	out.Reset()
	if err := runCheckUpdate(context.Background(), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "up to date") {
		t.Errorf("unexpected output: %q", out.String())
	}

	version = "dev"
	if err := runCheckUpdate(context.Background(), &out); err == nil {
		t.Error("expected error for dev build")
	}
}
