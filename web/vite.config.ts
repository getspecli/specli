import { defineConfig } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The PlantUML engine loads its `!theme` definitions on demand from the page's
// own directory, so ship themes.js next to index.html.
const plantumlThemes = {
  name: 'plantuml-themes',
  generateBundle(this: { emitFile(f: { type: 'asset'; fileName: string; source: string }): void }) {
    const file = require.resolve('@plantuml/core/themes.js');
    this.emitFile({ type: 'asset', fileName: 'themes.js', source: readFileSync(file, 'utf8') });
  },
};

// Vite empties dist/ on every build, but the Go side embeds web/dist and needs the
// directory to exist in a fresh checkout. Keep the tracked placeholder alive.
const keepDistPlaceholder = {
  name: 'keep-dist-placeholder',
  closeBundle() {
    writeFileSync(new URL('./dist/.gitkeep', import.meta.url), '');
  },
};

export default defineConfig({
  plugins: [plantumlThemes, keepDistPlaceholder],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 6000 },
  server: { proxy: { '/api': 'http://127.0.0.1:4747' } },
});
