// Starts the built specli binary on a throw-away copy of ../examples.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const here = import.meta.dirname;
const bin = process.env.SPECLI_BIN ?? resolve(here, '..', 'bin', process.platform === 'win32' ? 'specli.exe' : 'specli');
const port = process.env.E2E_PORT ?? '4799';
const work = mkdtempSync(join(tmpdir(), 'specli-e2e-'));
cpSync(resolve(here, '..', 'examples'), work, { recursive: true });

const child = spawn(bin, [work, '--no-open', '--port', port], { stdio: 'inherit' });
const stop = (code = 0) => {
  child.kill();
  rmSync(work, { recursive: true, force: true });
  process.exit(code);
};
child.on('exit', (code) => stop(code ?? 1));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
