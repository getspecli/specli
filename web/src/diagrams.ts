// Client-side diagram engines. Both run entirely in the browser, so diagram
// text never leaves the machine and no Java/Graphviz installation is needed.
import DOMPurify from 'dompurify';
import vizUrl from '@plantuml/core/viz-global.js?url';

export type DiagramResult = { ok: true; svg: string } | { ok: false; error: string };

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

export function renderPlantumlInBrowser(src: string): Promise<DiagramResult> {
  // The engine keeps global state, so render one diagram at a time.
  const run = puQueue.then(async (): Promise<DiagramResult> => {
    try {
      const render = await loadPlantuml();
      const svg = await new Promise<string>((res, rej) =>
        render(src.split(/\r\n|\r|\n/), res, (m) => rej(new Error(m))));
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
