VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all web build release test e2e clean
all: build

web:
	cd web && npm ci && npm run build

build: web
	go build -ldflags "$(LDFLAGS)" -o bin/specli .

test:
	gofmt -l . | (! grep .)
	go vet ./...
	go test -count=1 ./...

# Browser tests; needs the built binary and Chromium (installed on first run)
e2e: build
	cd e2e && npm ci && npx playwright install chromium && npx playwright test

# Cross-compiled single binaries (the frontend is embedded, nothing else is needed)
release: web
	GOOS=linux   GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/specli-linux-amd64 .
	GOOS=darwin  GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/specli-darwin-arm64 .
	GOOS=darwin  GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/specli-darwin-amd64 .
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/specli-windows-amd64.exe .

clean:
	rm -rf bin web/dist/* && touch web/dist/.gitkeep
