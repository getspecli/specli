// Client-side diagram engines. Both run entirely in the browser, so diagram
// text never leaves the machine and no Java/Graphviz installation is needed.
import DOMPurify from 'dompurify';
import vizUrl from '@plantuml/core/viz-global.js?url';

export type DiagramResult = { ok: true; svg: string } | { ok: false; error: string; line?: number };

// ---- PlantUML (official engine compiled to JS with TeaVM, Graphviz via Viz.js) ----

type RenderToString = (lines: string[], ok: (svg: string) => void, err: (msg: string) => void) => void;
let plantuml: Promise<RenderToString> | null = null;
let puQueue: Promise<unknown> = Promise.resolve();

function loadClassicScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('cannot load ' + src));
    document.head.append(s);
  });
}

function loadPlantuml(): Promise<RenderToString> {
  plantuml ??= (async () => {
    // Stdlib bundles (!include <archimate/Archimate>) are self-hosted and loaded on demand.
    (window as unknown as { PLANTUML_STDLIB_BASE: string }).PLANTUML_STDLIB_BASE = '/plantuml-stdlib/';
    // Without Viz.js the engine falls back to its built-in Smetana layout.
    await loadClassicScript(vizUrl).catch((e) => console.warn('PlantUML: Graphviz layout unavailable', e));
    return (await import('@plantuml/core')).renderToString as RenderToString;
  })();
  return plantuml;
}

// The engine reports problems as an *image* containing the echoed source and a
// message, not as an exception. Turn that into a short error with a line number.
function plantumlProblem(src: string): { error: string; line?: number } | null {
  // Unbalanced @start…/@end… is the most common cause and gives a useless engine message.
  let open = 0;
  const lines = src.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^@start\w+/i.test(l)) {
      if (open) return { error: `Line ${i + 1}: ${l.split(/\s/)[0]} starts a new diagram, but the one from line ${open} has no @end… (duplicated block?)`, line: i + 1 };
      open = i + 1;
    } else if (/^@end\w+/i.test(l)) {
      open = 0;
    }
  }
  if (open) return { error: `Line ${open}: ${lines[open - 1].trim().split(/\s/)[0]} is never closed with @end…`, line: open };
  return null;
}

function plantumlErrorFromSvg(svg: string, src: string): { error: string; line?: number } | null {
  const texts = [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')]
    .map((t) => (t.textContent ?? '').trim()).filter(Boolean);
  const m = texts.map((t) => /^\[From .*\(line (\d+)/.exec(t)).find(Boolean);
  if (!m) return null; // not an error image
  const line = Number(m[1]);
  const last = texts[texts.length - 1];
  const srcLine = src.split(/\r\n|\r|\n/)[line - 1]?.trim();
  const type = /Assumed diagram type: (\w+)/.exec(last)?.[1];
  const what = /Syntax Error/i.test(last)
    ? `syntax error${srcLine ? ` near "${srcLine}"` : ''}${type ? ` (read as a ${type} diagram)` : ''}`
    : last;
  return { error: `Line ${line}: ${what}`, line };
}

export function renderPlantumlInBrowser(src: string): Promise<DiagramResult> {
  // The engine keeps global state, so render one diagram at a time.
  const run = puQueue.then(async (): Promise<DiagramResult> => {
    try {
      const pre = plantumlProblem(src);
      if (pre) return { ok: false, ...pre };
      const render = await loadPlantuml();
      const svg = await new Promise<string>((res, rej) =>
        render(src.split(/\r\n|\r|\n/), res, (m) => rej(new Error(m))));
      const bad = plantumlErrorFromSvg(svg, src);
      if (bad) return { ok: false, ...bad };
      return { ok: true, svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) };
    } catch (e) {
      return { ok: false, error: (e as Error).message ?? String(e) };
    }
  });
  puQueue = run;
  return run;
}

// ---- Mermaid ----

type Mermaid = typeof import('mermaid')['default'];
let mermaid: Promise<Mermaid> | null = null;
let mmQueue: Promise<unknown> = Promise.resolve();
let mmCounter = 0;

function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import('mermaid').then((m) => {
    // htmlLabels off: labels become plain SVG <text>, which survives sanitizing
    // (HTML inside <foreignObject> would be stripped).
    m.default.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'default',
      htmlLabels: false, flowchart: { htmlLabels: false }, class: { htmlLabels: false },
    } as Parameters<Mermaid['initialize']>[0]);
    return m.default;
  });
  return mermaid;
}

export function renderMermaid(src: string): Promise<DiagramResult> {
  const run = mmQueue.then(async (): Promise<DiagramResult> => {
    const id = 'mmd' + mmCounter++;
    try {
      const m = await loadMermaid();
      await m.parse(src);
      const { svg } = await m.render(id, src);
      return {
        ok: true,
        svg: DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_ATTR: ['dominant-baseline'],
        }),
      };
    } catch (e) {
      // mermaid leaves a temporary error node in the DOM when rendering fails
      document.getElementById('d' + id)?.remove();
      document.getElementById(id)?.remove();
      return { ok: false, error: (e as Error).message ?? String(e) };
    }
  });
  mmQueue = run;
  return run;
}
