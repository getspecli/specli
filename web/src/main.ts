import './style.css';
import 'swagger-ui-dist/swagger-ui.css';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { load as loadYaml } from 'js-yaml';
import { detectDelimiter, parseCsv } from './csv';
import { renderAsyncApi } from './asyncapi';
import { renderMermaid, renderPlantumlInBrowser, type DiagramResult } from './diagrams';

// ---------- types & state ----------

type Kind = 'markdown' | 'plantuml' | 'mermaid' | 'csv' | 'openapi' | 'asyncapi' | 'data';
type Mode = 'edit' | 'split' | 'preview';

interface FileInfo { path: string; kind: Kind; size: number; mtime: string }
interface Info { name: string; path: string; readonly: boolean; version: string; plantuml: { available: boolean; mode: string } }
interface UpdateInfo { current: string; latest?: string; available: boolean; url?: string; manager?: string }
interface GitInfo { available: boolean; repo: boolean; branch?: string; upstream?: string; ahead: number; behind: number; changed: number; files?: Record<string, string> }
interface Doc { path: string; kind: Kind; mtime: string; eol: 'lf' | 'crlf'; saved: string }
interface ChangeEvent { type: 'change'; path: string; op: 'added' | 'modified' | 'removed'; mtime?: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  newBtn: $<HTMLButtonElement>('new'), filter: $<HTMLInputElement>('filter'),
  tree: $('tree'), foot: $('foot'), title: $('title'), dirty: $('dirty'), modes: $('modes'),
  save: $<HTMLButtonElement>('save'), banner: $('banner'), panes: $('panes'), editor: $('editor'),
  preview: $('preview'), pvError: $('pv-error'), pvBody: $('pv-body'), empty: $('empty'),
};

let info: Info = { name: '', path: '', readonly: true, version: '', plantuml: { available: false, mode: 'none' } };
let files: FileInfo[] = [];
let git: GitInfo | null = null;
let doc: Doc | null = null;
let mode: Mode = 'split';
let isDirty = false;
let renderSeq = 0;
// Folders start collapsed; the ones the user (or an opened file) expanded stay open.
const openDirs = new Set<string>();
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
type Theme = 'auto' | 'light' | 'dark';
const themeIcon: Record<Theme, string> = { auto: '◐', light: '☀', dark: '☾' };
let theme: Theme = 'auto';
try {
  const saved = localStorage.getItem('specli-theme');
  if (saved === 'light' || saved === 'dark') theme = saved;
} catch { /* storage blocked: stay on auto */ }
const isDark = () => theme === 'dark' || (theme === 'auto' && darkQuery.matches);
const themeCompartment = new Compartment();

// ---------- small helpers ----------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enc = (p: string) => encodeURIComponent(p);
const extOf = (p: string) => (p.match(/\.[^./]+$/)?.[0] ?? '').toLowerCase();
const isPuml = (p: string) => ['.puml', '.plantuml', '.pu', '.iuml', '.wsd'].includes(extOf(p));
const isMermaid = (p: string) => ['.mmd', '.mermaid'].includes(extOf(p));
type DiagramKind = 'plantuml' | 'mermaid';
const diagramKindOf = (p: string): DiagramKind | null => (isPuml(p) ? 'plantuml' : isMermaid(p) ? 'mermaid' : null);
const isImage = (p: string) => ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extOf(p));
const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => {
  let t: number | undefined;
  return (...a: A) => { window.clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
};

function resolvePath(base: string, rel: string): string | null {
  const parts = base.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

const hashFor = (p: string) => '#/' + p.split('/').map(enc).join('/');
const pathFromHash = () =>
  location.hash.startsWith('#/') ? decodeURIComponent(location.hash.slice(2)) : null;

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(url, init);
  let data: unknown = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, data: data as T };
}

// ---------- banner ----------

function showBanner(msg: string, actions: { label: string; fn: () => void }[] = [], error = false) {
  els.banner.className = error ? 'error' : '';
  els.banner.replaceChildren();
  const span = document.createElement('span');
  span.textContent = msg;
  els.banner.append(span);
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = a.fn;
    els.banner.append(b);
  }
  els.banner.hidden = false;
}
const hideBanner = () => { els.banner.hidden = true; };

// ---------- editor ----------

function languageFor(path: string): Extension {
  switch (extOf(path)) {
    case '.md': case '.markdown': return markdown();
    case '.yaml': case '.yml': return yaml();
    case '.json': return json();
    default: return [];
  }
}

function makeState(text: string, path: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void save(); return true; } }]),
      basicSetup,
      languageFor(path),
      EditorView.lineWrapping,
      EditorState.readOnly.of(info.readonly),
      EditorView.updateListener.of((u) => { if (u.docChanged) onEdit(); }),
      themeCompartment.of(isDark() ? oneDark : []),
    ],
  });
}

const view = new EditorView({ parent: els.editor, state: makeState('', 'x.txt') });

function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  view.dispatch({ effects: themeCompartment.reconfigure(isDark() ? oneDark : []) });
  const btn = $('theme');
  btn.textContent = themeIcon[theme];
  btn.title = `Theme: ${theme} (click to change)`;
}
$('theme').addEventListener('click', () => {
  theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
  try {
    if (theme === 'auto') localStorage.removeItem('specli-theme');
    else localStorage.setItem('specli-theme', theme);
  } catch { /* ignore */ }
  applyTheme();
});
darkQuery.addEventListener('change', () => { if (theme === 'auto') applyTheme(); });
applyTheme();

function setDirty(d: boolean) {
  isDirty = d;
  els.dirty.hidden = !d;
  els.save.disabled = !d;
}

function onEdit() {
  if (!doc) return;
  setDirty(view.state.doc.toString() !== doc.saved);
  schedulePreview();
}

// ---------- modes ----------

function effectiveMode(): Mode {
  return doc?.kind === 'data' ? 'edit' : mode;
}

function applyMode() {
  const m = effectiveMode();
  els.panes.className = 'mode-' + m;
  for (const b of els.modes.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.mode === m);
    (b as HTMLButtonElement).disabled = doc?.kind === 'data';
  }
}

const restoring = () => restorePv !== null && Date.now() < restorePv.until;

// Split view: keep both panes at the same relative scroll position.
function syncScroll(a: HTMLElement, b: HTMLElement) {
  let echo: HTMLElement | null = null; // pane whose next scroll event is our own doing
  const follow = (from: HTMLElement, to: HTMLElement) => () => {
    if (echo === from) { echo = null; return; }
    if (effectiveMode() !== 'split') return;
    if (restoring()) return; // positions are being restored per pane, don't cross-sync
    const room = from.scrollHeight - from.clientHeight;
    const target = Math.round((room > 0 ? from.scrollTop / room : 0) * (to.scrollHeight - to.clientHeight));
    if (Math.abs(target - to.scrollTop) < 1) return;
    echo = to;
    to.scrollTop = target;
  };
  a.addEventListener('scroll', follow(a, b), { passive: true });
  b.addEventListener('scroll', follow(b, a), { passive: true });
}
syncScroll(view.scrollDOM, els.preview);

// Remember the scroll position per file: opening a file restores where it was
// left (or starts at the top), instead of inheriting the previous file's offset.
const scrollMemory = new Map<string, { ed?: number; pv?: number }>();
let restorePv: { top: number; until: number } | null = null;
function rememberScroll(path: string) {
  const prev = scrollMemory.get(path);
  // A hidden pane reports 0, so keep the old value unless the pane is visible.
  scrollMemory.set(path, {
    ed: view.scrollDOM.clientHeight ? view.scrollDOM.scrollTop : prev?.ed,
    pv: els.preview.clientHeight ? els.preview.scrollTop : prev?.pv,
  });
}
function restoreScroll(path: string) {
  const m = scrollMemory.get(path);
  restorePv = { top: m?.pv ?? 0, until: Date.now() + 2500 };
  els.preview.scrollTop = restorePv.top;
  const ed = m?.ed ?? 0;
  view.scrollDOM.scrollTop = ed;
  requestAnimationFrame(() => { view.scrollDOM.scrollTop = ed; });
}
// Diagrams and images grow the preview after the first render; keep the
// restored position until the user scrolls on their own.
for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
  for (const pane of [els.preview, view.scrollDOM]) pane.addEventListener(ev, () => { restorePv = null; }, { passive: true });
}
new ResizeObserver(() => {
  if (restorePv && Date.now() < restorePv.until) els.preview.scrollTop = restorePv.top;
}).observe(els.pvBody);

els.modes.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b || !b.dataset.mode) return;
  mode = b.dataset.mode as Mode;
  applyMode();
  if (mode !== 'edit') void renderPreview();
});

// ---------- Diagrams (PlantUML + Mermaid) ----------

const diagramCache = new Map<string, DiagramResult>();

async function plantumlSvg(src: string): Promise<DiagramResult> {
  const text = /@start\w+/.test(src) ? src : `@startuml\n${src}\n@enduml\n`;
  if (!info.plantuml.available) return renderPlantumlInBrowser(text);
  // Optional server-side rendering (--plantuml-server / --plantuml-jar)
  try {
    const r = await fetch('/api/plantuml', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
    const body = await r.text();
    if (!r.ok) {
      let msg = body;
      try { msg = (JSON.parse(body) as { error: string }).error; } catch { /* keep raw */ }
      return { ok: false, error: msg };
    }
    return { ok: true, svg: DOMPurify.sanitize(body, { USE_PROFILES: { svg: true, svgFilters: true } }) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function diagramSvg(kind: DiagramKind, src: string): Promise<DiagramResult> {
  const key = kind + '\0' + src;
  const cached = diagramCache.get(key);
  if (cached) return cached;
  const res = kind === 'mermaid' ? await renderMermaid(src) : await plantumlSvg(src);
  if (res.ok) {
    if (diagramCache.size > 100) diagramCache.clear();
    diagramCache.set(key, res);
  }
  return res;
}

async function fillDiagram(el: HTMLElement, kind: DiagramKind, src: string, seq: number) {
  const res = await diagramSvg(kind, src);
  if (seq !== renderSeq) return;
  el.replaceChildren();
  if (res.ok) {
    const wrap = document.createElement('div');
    wrap.className = 'uml-page';
    wrap.innerHTML = res.svg;
    el.append(wrap);
  } else {
    const msg = document.createElement('div');
    msg.className = 'uml-err';
    msg.textContent = res.error;
    const pre = document.createElement('pre');
    // Source with line numbers; the offending line (if known) is highlighted.
    src.split(/\r\n|\r|\n/).forEach((text, i) => {
      const row = document.createElement('span');
      row.className = res.line === i + 1 ? 'uml-line uml-bad' : 'uml-line';
      row.dataset.n = String(i + 1);
      row.textContent = text + '\n';
      pre.append(row);
    });
    el.append(msg, pre);
  }
}

// Click a diagram to open it in a zoomable overlay (wheel/pinch zoom, drag to pan).
function openDiagramZoom(svgSrc: SVGElement) {
  const r = svgSrc.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const ov = document.createElement('div');
  ov.className = 'zoom-overlay';
  const stage = document.createElement('div');
  stage.className = 'zoom-stage';
  const svg = svgSrc.cloneNode(true) as SVGElement;
  const fit = Math.min((innerWidth * 0.92) / r.width, (innerHeight * 0.88) / r.height);
  svg.style.cssText = `width:${r.width * fit}px;height:${r.height * fit}px;max-width:none;display:block`;
  stage.append(svg);
  const hint = document.createElement('div');
  hint.className = 'zoom-hint';
  hint.textContent = 'Scroll to zoom · drag to move · double-click to reset · Esc to close';
  ov.append(stage, hint);

  let scale = 1, x = 0, y = 0;
  const apply = () => { stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const next = Math.min(20, Math.max(0.2, scale * factor));
    const k = next / scale;
    // Keep the point under the cursor fixed (stage origin is the viewport centre).
    const ox = cx - innerWidth / 2, oy = cy - innerHeight / 2;
    x = ox - (ox - x) * k; y = oy - (oy - y) * k; scale = next; apply();
  };
  const close = () => { ov.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === '+' || e.key === '=') zoomAt(1.25, innerWidth / 2, innerHeight / 2);
    else if (e.key === '-') zoomAt(0.8, innerWidth / 2, innerHeight / 2);
    else if (e.key === '0') { scale = 1; x = 0; y = 0; apply(); }
  };
  ov.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY); }, { passive: false });
  ov.addEventListener('dblclick', () => { scale = 1; x = 0; y = 0; apply(); });
  let drag: { px: number; py: number; moved: boolean } | null = null;
  ov.addEventListener('pointerdown', (e) => { drag = { px: e.clientX, py: e.clientY, moved: false }; ov.setPointerCapture(e.pointerId); ov.classList.add('grabbing'); });
  ov.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.px = e.clientX; drag.py = e.clientY; x += dx; y += dy; apply();
  });
  ov.addEventListener('pointerup', (e) => {
    const wasClick = drag && !drag.moved;
    drag = null; ov.classList.remove('grabbing');
    if (wasClick && e.target === ov) close();
  });
  window.addEventListener('keydown', onKey, true);
  document.body.append(ov);
}

els.pvBody.addEventListener('click', (e) => {
  const page = (e.target as HTMLElement).closest('.uml-page');
  const svg = page?.querySelector('svg');
  if (svg) openDiagramZoom(svg);
});

// ---------- Markdown ----------

const slug = (s: string) =>
  s.replace(/<[^>]*>/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

// Diagram sources are kept out of the HTML: DOMPurify drops attribute values
// containing "-->" (PlantUML's arrow!), so blocks are referenced by index.
let umlBlocks: { kind: DiagramKind; text: string }[] = [];

const marked = new Marked({
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const l = (lang ?? '').split(/\s+/)[0].toLowerCase();
      const dk: DiagramKind | null = l === 'plantuml' || l === 'puml' ? 'plantuml' : l === 'mermaid' ? 'mermaid' : null;
      if (dk) return `<div class="uml" data-idx="${umlBlocks.push({ kind: dk, text }) - 1}"></div>`;
      return `<pre><code>${esc(text)}</code></pre>\n`;
    },
    heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth }: Tokens.Heading) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${esc(slug(inner))}">${inner}</h${depth}>\n`;
    },
  },
});

// Leading YAML front matter ("---" ... "---") is shown as a key/value table.
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function fmValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) return v.map(String).join(', ');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function frontMatterEl(src: string): HTMLElement {
  let data: unknown;
  try { data = loadYaml(src); } catch { data = undefined; }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const table = document.createElement('table');
    table.className = 'frontmatter';
    for (const [k, v] of Object.entries(data)) {
      const tr = table.insertRow();
      tr.append(Object.assign(document.createElement('th'), { textContent: k }));
      tr.insertCell().textContent = fmValue(v);
    }
    return table;
  }
  const pre = document.createElement('pre');
  pre.className = 'frontmatter';
  pre.textContent = src;
  return pre;
}

function renderMarkdown(text: string, docPath: string, seq: number) {
  umlBlocks = [];
  const fm = FRONTMATTER_RE.exec(text);
  if (fm) text = text.slice(fm[0].length);
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
  const blocks = umlBlocks;
  const known = new Set(files.map((f) => f.path));
  const box = document.createElement('div');
  box.className = 'md';
  // Parse into an inert <template> so <img src="diagram.puml"> is rewritten
  // before the browser tries to fetch it.
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const frag = tpl.content;

  for (const a of frag.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (href && !href.startsWith('#')) {
      const target = resolvePath(docPath, decodeURIComponent(href.split('#')[0]));
      if (target && known.has(target)) a.setAttribute('href', hashFor(target));
      else a.classList.add('broken');
    }
  }
  for (const img of Array.from(frag.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (/^(https?:|data:)/i.test(src)) { img.title = 'External images are blocked'; continue; }
    const target = resolvePath(docPath, decodeURIComponent(src));
    if (!target) continue;
    if (diagramKindOf(target)) {
      const d = document.createElement('div');
      d.className = 'uml';
      d.dataset.path = target;
      d.textContent = 'Rendering…';
      img.replaceWith(d);
    } else if (isImage(target)) {
      img.setAttribute('src', '/api/asset?path=' + enc(target));
    }
  }
  if (fm) box.append(frontMatterEl(fm[1]));
  box.append(frag);
  els.pvBody.className = '';
  els.pvBody.replaceChildren(box);

  for (const el of box.querySelectorAll<HTMLElement>('.uml')) {
    if (el.dataset.idx !== undefined) {
      const b = blocks[Number(el.dataset.idx)];
      if (b) void fillDiagram(el, b.kind, b.text, seq);
    } else if (el.dataset.path) {
      const p = el.dataset.path;
      const dk = diagramKindOf(p)!;
      void api<{ content: string }>('/api/file?path=' + enc(p)).then((r) => {
        if (seq !== renderSeq) return;
        if (r.ok) void fillDiagram(el, dk, r.data.content, seq);
        else { el.textContent = `Cannot load ${p}`; el.className = 'uml uml-err'; }
      });
    }
  }
}

// In-document anchors must not touch location.hash (used for file routing).
els.preview.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  const href = a?.getAttribute('href');
  if (a && href && href.startsWith('#') && !href.startsWith('#/')) {
    e.preventDefault();
    const target = els.preview.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
    target?.scrollIntoView({ behavior: 'smooth' });
  }
});

// ---------- OpenAPI ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let swagger: any = null;
let swaggerFor: string | null = null;

function setPreviewError(msg: string | null) {
  els.pvError.hidden = msg === null;
  els.pvError.textContent = msg ?? '';
}

async function renderOpenApi(text: string, path: string, seq: number) {
  let spec: unknown;
  try {
    spec = loadYaml(text);
  } catch (e) {
    setPreviewError('Parse error: ' + (e as Error).message);
    return;
  }
  if (!spec || typeof spec !== 'object') {
    setPreviewError('Document is not a YAML/JSON object');
    return;
  }
  const s = spec as Record<string, unknown>;
  if (!('openapi' in s) && !('swagger' in s)) {
    setPreviewError('Missing "openapi" or "swagger" version field');
    return;
  }
  setPreviewError(null);

  if (swagger && swaggerFor === path && document.getElementById('swagger')) {
    swagger.specActions.updateJsonSpec(spec);
    return;
  }
  const mod = await import('swagger-ui-dist/swagger-ui-es-bundle.js');
  if (seq !== renderSeq) return;
  els.pvBody.className = 'api';
  els.pvBody.innerHTML = '<div id="swagger"></div>';
  swagger = mod.default({
    domNode: document.getElementById('swagger'),
    spec,
    supportedSubmitMethods: [], // view only: never fire requests from a design review tool
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    deepLinking: false,
  });
  swaggerFor = path;
}

function renderAsyncApiDoc(text: string) {
  let spec: unknown;
  try {
    spec = loadYaml(text);
  } catch (e) {
    setPreviewError('Parse error: ' + (e as Error).message);
    return;
  }
  if (!spec || typeof spec !== 'object' || !('asyncapi' in spec)) {
    setPreviewError('Missing "asyncapi" version field');
    return;
  }
  setPreviewError(null);
  els.pvBody.className = '';
  els.pvBody.replaceChildren(renderAsyncApi(spec as Record<string, unknown>));
}

// ---------- CSV ----------

const MAX_CSV_ROWS = 5000;

function renderCsv(text: string, path: string) {
  const rows = parseCsv(text, detectDelimiter(text, path));
  const box = document.createElement('div');
  box.className = 'md csv';
  if (!rows.length) {
    box.textContent = 'Empty file';
  } else {
    const [head, ...body] = rows;
    const table = document.createElement('table');
    const tr = table.createTHead().insertRow();
    for (const h of head) tr.append(Object.assign(document.createElement('th'), { textContent: h }));
    const tb = table.createTBody();
    for (const r of body.slice(0, MAX_CSV_ROWS)) {
      const row = tb.insertRow();
      for (const c of r) row.insertCell().textContent = c;
    }
    box.append(table);
    if (body.length > MAX_CSV_ROWS) {
      box.append(Object.assign(document.createElement('p'), { textContent: `Showing first ${MAX_CSV_ROWS} of ${body.length} rows.` }));
    }
  }
  els.pvBody.className = '';
  els.pvBody.replaceChildren(box);
}

// ---------- preview dispatch ----------

async function renderPreview() {
  if (!doc || effectiveMode() === 'edit') return;
  const seq = ++renderSeq;
  const text = view.state.doc.toString();
  const { kind, path } = doc;
  if (kind !== 'openapi') { swagger = null; swaggerFor = null; }
  if (kind !== 'openapi' && kind !== 'asyncapi') setPreviewError(null);
  if (kind === 'markdown') {
    renderMarkdown(text, path, seq);
  } else if (kind === 'plantuml' || kind === 'mermaid') {
    els.pvBody.className = '';
    const box = document.createElement('div');
    box.className = 'uml';
    box.textContent = 'Rendering…';
    els.pvBody.replaceChildren(box);
    await fillDiagram(box, kind, text, seq);
  } else if (kind === 'csv') {
    renderCsv(text, path);
  } else if (kind === 'openapi') {
    await renderOpenApi(text, path, seq);
  } else if (kind === 'asyncapi') {
    renderAsyncApiDoc(text);
  }
}
const schedulePreview = debounce(() => void renderPreview(), 350);

// ---------- file tree ----------

const kindBadge: Record<Kind, string> = { markdown: 'MD', plantuml: 'UML', mermaid: 'MMD', csv: 'CSV', openapi: 'API', asyncapi: 'ASY', data: 'DAT' };

interface TreeNode { name: string; path: string; dirs: Map<string, TreeNode>; files: FileInfo[] }

function buildTree(list: FileInfo[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of list) {
    const parts = f.path.split('/');
    let n = root;
    for (const seg of parts.slice(0, -1)) {
      const p = n.path ? n.path + '/' + seg : seg;
      if (!n.dirs.has(seg)) n.dirs.set(seg, { name: seg, path: p, dirs: new Map(), files: [] });
      n = n.dirs.get(seg)!;
    }
    n.files.push(f);
  }
  return root;
}

const gitLabels: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Merge conflict', '?': 'Untracked' };

function fileLink(f: FileInfo, label: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'file' + (doc?.path === f.path ? ' active' : '');
  a.href = hashFor(f.path);
  a.title = f.path;
  a.dataset.path = f.path;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = kindBadge[f.kind];
  const name = document.createElement('span');
  name.className = 'name';
  const slash = label.lastIndexOf('/');
  if (slash < 0) {
    name.textContent = label;
  } else {
    // long paths: shrink the directory part first so the file name stays visible
    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = label.slice(0, slash + 1);
    const base = document.createElement('span');
    base.className = 'base';
    base.textContent = label.slice(slash + 1);
    name.append(dir, base);
    name.classList.add('split');
  }
  a.append(badge, name);
  const g = git?.files?.[f.path];
  if (g) {
    const m = document.createElement('span');
    m.className = 'git git-' + g.replace('?', 'u');
    m.textContent = g === '?' ? 'U' : g;
    m.title = gitLabels[g] ?? 'Changed';
    a.append(m);
  }
  return a;
}

function renderNode(n: TreeNode, into: HTMLElement) {
  for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const det = document.createElement('details');
    det.dataset.dir = d.path;
    det.open = openDirs.has(d.path);
    det.addEventListener('toggle', () => { if (det.open) openDirs.add(d.path); else openDirs.delete(d.path); });
    const sum = document.createElement('summary');
    sum.textContent = d.name;
    const kids = document.createElement('div');
    kids.className = 'children';
    renderNode(d, kids);
    det.append(sum, kids);
    into.append(det);
  }
  for (const f of n.files) into.append(fileLink(f, f.path.split('/').pop()!));
}

// ---------- search ----------

interface SearchHit { path: string; kind: Kind; line: number; text: string }
let hits: SearchHit[] = [];
let hitsQuery = '';
let hitsTruncated = false;
let searching = false;

function highlight(text: string, q: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  for (let j = lower.indexOf(ql); j >= 0 && ql; j = lower.indexOf(ql, i)) {
    frag.append(text.slice(i, j));
    const m = document.createElement('mark');
    m.textContent = text.slice(j, j + ql.length);
    frag.append(m);
    i = j + ql.length;
  }
  frag.append(text.slice(i));
  return frag;
}

function renderHits(into: HTMLElement) {
  if (!hitsQuery) return;
  const head = document.createElement('div');
  head.className = 'hits-head';
  const stale = hitsQuery !== els.filter.value.trim();
  head.textContent = searching || stale ? 'Text matches…' : `Text matches: ${hits.length}${hitsTruncated ? '+' : ''}`;
  into.append(head);
  if (stale) return; // do not show results of an older query
  let last = '';
  for (const h of hits) {
    if (h.path !== last) {
      into.append(fileLink({ path: h.path, kind: h.kind, size: 0, mtime: '' }, h.path));
      last = h.path;
    }
    const row = document.createElement('a');
    row.className = 'hit';
    row.href = hashFor(h.path);
    row.title = `${h.path}:${h.line}`;
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = String(h.line);
    const tx = document.createElement('span');
    tx.className = 'tx';
    tx.append(highlight(h.text, hitsQuery));
    row.append(ln, tx);
    row.addEventListener('click', (e) => { e.preventDefault(); void openAt(h.path, h.line); });
    into.append(row);
  }
}

async function runSearch() {
  const q = els.filter.value.trim();
  if (q.length < 2) { hits = []; hitsQuery = ''; searching = false; renderTree(); return; }
  searching = true;
  renderTree();
  const r = await api<{ results: SearchHit[]; truncated: boolean }>('/api/search?q=' + enc(q));
  if (els.filter.value.trim() !== q) return; // a newer query is already running
  searching = false;
  if (r.ok) { hits = r.data.results; hitsTruncated = r.data.truncated; hitsQuery = q; }
  renderTree();
}
const searchSoon = debounce(() => void runSearch(), 250);

let pendingLine: { path: string; line: number } | null = null;

function gotoLine(n: number) {
  if (mode === 'preview' && doc?.kind !== 'data') { mode = 'split'; applyMode(); }
  requestAnimationFrame(() => {
    const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.focus();
  });
}

async function openAt(path: string, line: number) {
  if (doc?.path === path) { gotoLine(line); return; }
  pendingLine = { path, line };
  location.hash = hashFor(path);
}

els.filter.addEventListener('input', () => { renderTree(); searchSoon(); });
els.filter.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { els.filter.value = ''; els.filter.blur(); void runSearch(); renderTree(); }
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    els.filter.focus();
    els.filter.select();
  }
});

function renderTree() {
  const q = els.filter.value.trim().toLowerCase();
  els.tree.replaceChildren();
  if (q) {
    const names = files.filter((x) => x.path.toLowerCase().includes(q));
    if (names.length) {
      const head = document.createElement('div');
      head.className = 'hits-head';
      head.textContent = `Files: ${names.length}`;
      els.tree.append(head);
      for (const f of names) els.tree.append(fileLink(f, f.path));
    }
    renderHits(els.tree);
    if (!names.length && !hitsQuery && !searching) els.tree.append('No matches.');
  } else {
    renderNode(buildTree(files), els.tree);
    if (!files.length) els.tree.textContent = 'No Markdown, PlantUML, Mermaid, CSV or OpenAPI files found.';
  }
}

async function refreshFiles() {
  const r = await api<FileInfo[]>('/api/files');
  if (r.ok) {
    files = r.data;
    renderTree();
    if (els.filter.value.trim().length >= 2) searchSoon(); // results may have changed on disk
  }
}
const refreshFilesSoon = debounce(() => { void refreshFiles(); refreshGitSoon(); }, 300);

// ---------- drag and drop (move files, add files from the desktop) ----------

const DND_TYPE = 'application/x-specli-path';
let dropEl: HTMLElement | null = null;

// The folder a drop lands in: the folder under the pointer, else the root.
function dropTarget(e: DragEvent): { dir: string; el: HTMLElement } {
  const det = (e.target as HTMLElement).closest<HTMLDetailsElement>('#tree details[data-dir]');
  return det ? { dir: det.dataset.dir!, el: det.querySelector<HTMLElement>(':scope > summary')! } : { dir: '', el: els.tree };
}
function clearDrop() { dropEl?.classList.remove('drop'); dropEl = null; }

els.tree.addEventListener('dragstart', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.file');
  if (!a?.dataset.path || info.readonly || !e.dataTransfer) { e.preventDefault(); return; }
  e.dataTransfer.setData(DND_TYPE, a.dataset.path);
  e.dataTransfer.effectAllowed = 'move';
});
els.tree.addEventListener('dragend', clearDrop);
els.tree.addEventListener('dragover', (e) => {
  if (info.readonly || !e.dataTransfer || searching || els.filter.value.trim()) return;
  const types = [...e.dataTransfer.types];
  if (!types.includes(DND_TYPE) && !types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = types.includes(DND_TYPE) ? 'move' : 'copy';
  const { el } = dropTarget(e);
  if (el !== dropEl) { clearDrop(); dropEl = el; el.classList.add('drop'); }
});
els.tree.addEventListener('dragleave', (e) => {
  if (!els.tree.contains(e.relatedTarget as Node | null)) clearDrop();
});
els.tree.addEventListener('drop', (e) => {
  if (info.readonly || !e.dataTransfer) return;
  e.preventDefault();
  const { dir } = dropTarget(e);
  clearDrop();
  if (dir) openDirs.add(dir);
  const from = e.dataTransfer.getData(DND_TYPE);
  if (from) void moveFile(from, dir);
  else if (e.dataTransfer.files.length) void addFiles([...e.dataTransfer.files], dir);
});

const joinPath = (dir: string, name: string) => (dir ? dir + '/' + name : name);

const moveFile = (from: string, dir: string) => moveTo(from, joinPath(dir, from.split('/').pop()!));

async function moveTo(from: string, to: string) {
  if (to === from) return;
  if (doc?.path === from && isDirty) {
    showBanner(`Save or discard your changes in ${from} before moving it.`, [], true);
    return;
  }
  const r = await api<{ error?: string }>('/api/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!r.ok) { showBanner(`Cannot move ${from}: ${r.data?.error ?? r.status}`, [], true); return; }
  hideBanner();
  if (doc?.path === from) location.hash = hashFor(to);
  await refreshFiles();
}

async function addFiles(list: File[], dir: string) {
  const errors: string[] = [];
  let last = '';
  for (const f of list) {
    const path = joinPath(dir, f.name);
    if (files.some((x) => x.path === path)) { errors.push(`${path} already exists`); continue; }
    if (f.size > 5 << 20) { errors.push(`${f.name} is too large`); continue; }
    let content: string;
    try { content = await f.text(); } catch { errors.push(`Cannot read ${f.name}`); continue; }
    const eol = content.includes('\r\n') ? 'crlf' : 'lf';
    const r = await api<{ error?: string }>('/api/file?path=' + enc(path), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseMtime: '', eol }),
    });
    if (r.ok) last = path; else errors.push(`${f.name}: ${r.data?.error ?? r.status}`);
  }
  if (errors.length) showBanner('Not added: ' + errors.join('; '), [], true); else hideBanner();
  await refreshFiles();
  if (last && list.length === 1) location.hash = hashFor(last);
}

// ---------- context menu (copy, paste, duplicate, delete) ----------

let clipboardPath: string | null = null;

// "a.md" -> "a copy.md" -> "a copy 2.md" ... in the given folder
function freeName(dir: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (!files.some((f) => f.path === joinPath(dir, name))) return joinPath(dir, name);
  for (let i = 1; ; i++) {
    const p = joinPath(dir, `${stem} copy${i > 1 ? ' ' + i : ''}${ext}`);
    if (!files.some((f) => f.path === p)) return p;
  }
}

async function copyFile(from: string, dir: string) {
  const to = freeName(dir, from.split('/').pop()!);
  const r = await api<{ error?: string }>('/api/copy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!r.ok) { showBanner(`Cannot copy ${from}: ${r.data?.error ?? r.status}`, [], true); return; }
  hideBanner();
  if (dir) openDirs.add(dir);
  await refreshFiles();
  location.hash = hashFor(to);
}

async function deleteFile(path: string) {
  const r = await api<{ error?: string }>('/api/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) { showBanner(`Cannot delete ${path}: ${r.data?.error ?? r.status}`, [], true); return; }
  hideBanner();
  if (doc?.path === path) {
    doc = null;
    setDirty(false);
    els.panes.hidden = true;
    els.empty.hidden = false;
    els.title.textContent = '';
    history.replaceState(null, '', location.pathname + location.search);
  }
  await refreshFiles();
}

const fileDlg = {
  dlg: $<HTMLDialogElement>('file-dlg'), form: $<HTMLFormElement>('file-form'), title: $('file-title'), sub: $('file-sub'),
  renameRow: $('file-rename'), renameLabel: $('file-rename-label'), name: $<HTMLInputElement>('file-name'), msg: $('file-msg'),
  error: $('file-error'), cancel: $('file-cancel'), ok: $<HTMLButtonElement>('file-ok'),
};
let fileDlgSubmit: (() => void) | null = null;

function fileDlgRename(path: string) {
  const base = path.split('/').pop()!;
  const dir = path.split('/').slice(0, -1).join('/');
  fileDlg.title.textContent = 'Rename file';
  fileDlg.sub.textContent = path;
  fileDlg.sub.hidden = false;
  fileDlg.msg.hidden = fileDlg.error.hidden = true;
  fileDlg.renameRow.hidden = fileDlg.ok.hidden = false;
  fileDlg.dlg.showModal();
  fileDlg.ok.textContent = 'Rename';
  fileDlg.name.value = base;
  fileDlg.name.focus();
  fileDlg.name.setSelectionRange(0, base.lastIndexOf('.') > 0 ? base.lastIndexOf('.') : base.length);
  fileDlgSubmit = () => {
    const input = fileDlg.name.value.trim();
    if (!input || input === base) { fileDlg.dlg.close(); return; }
    if (/[\\/]/.test(input) || input.startsWith('.')) {
      fileDlg.error.textContent = 'Invalid file name.';
      fileDlg.error.hidden = false;
      return;
    }
    fileDlg.dlg.close();
    void moveTo(path, joinPath(dir, input));
  };
}

// Folders only exist on disk once they hold a file, so a new folder leads straight into the new-file dialog.
function fileDlgNewFolder(parent: string) {
  fileDlg.title.textContent = 'New folder';
  fileDlg.sub.textContent = parent ? `In ${parent}` : 'In the project root';
  fileDlg.sub.hidden = false;
  fileDlg.msg.hidden = fileDlg.error.hidden = true;
  fileDlg.renameRow.hidden = fileDlg.ok.hidden = false;
  fileDlg.renameLabel.textContent = 'Folder name';
  fileDlg.ok.textContent = 'Next';
  fileDlg.name.value = '';
  fileDlg.dlg.showModal();
  fileDlg.name.focus();
  fileDlgSubmit = () => {
    const name = fileDlg.name.value.trim();
    if (!name || /[\\/]/.test(name) || name.startsWith('.') || name === 'node_modules') {
      fileDlg.error.textContent = 'Invalid folder name.';
      fileDlg.error.hidden = false;
      return;
    }
    fileDlg.dlg.close();
    const dir = joinPath(parent, name);
    if (parent) openDirs.add(parent);
    openDirs.add(dir);
    openNewDialog(dir);
  };
}

function fileDlgDelete(path: string) {
  fileDlg.title.textContent = 'Delete file';
  fileDlg.sub.hidden = true;
  fileDlg.renameRow.hidden = fileDlg.error.hidden = true;
  fileDlg.msg.hidden = fileDlg.ok.hidden = false;
  fileDlg.dlg.showModal();
  fileDlg.msg.textContent = `Delete ${path}? This cannot be undone.`;
  fileDlg.ok.textContent = 'Delete';
  fileDlgSubmit = () => { fileDlg.dlg.close(); void deleteFile(path); };
}

const menu = document.createElement('div');
menu.id = 'ctxmenu';
menu.hidden = true;
document.body.append(menu);
const hideMenu = () => { menu.hidden = true; };
document.addEventListener('click', hideMenu);
document.addEventListener('scroll', hideMenu, true);
window.addEventListener('blur', hideMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

els.tree.addEventListener('contextmenu', (e) => {
  if (info.readonly || els.filter.value.trim()) return;
  const t = e.target as HTMLElement;
  const file = t.closest<HTMLAnchorElement>('a.file')?.dataset.path ?? null;
  const det = t.closest<HTMLDetailsElement>('details[data-dir]');
  const dir = file ? file.split('/').slice(0, -1).join('/') : det?.dataset.dir ?? '';
  const clip = clipboardPath;
  const items: ({ label: string; fn: () => void; off?: boolean } | null)[] = [];
  if (file) {
    items.push({ label: 'Copy', fn: () => { clipboardPath = file; } });
    items.push({ label: 'Duplicate', fn: () => void copyFile(file, dir) });
    items.push({ label: 'Rename…', fn: () => fileDlgRename(file) });
    items.push(null);
  }
  if (!file) {
    items.push({ label: 'New file…', fn: () => openNewDialog(dir) });
    items.push({ label: 'New folder…', fn: () => fileDlgNewFolder(dir) });
    items.push(null);
  }
  items.push({
    label: clip ? `Paste ${clip.split('/').pop()}` : 'Paste',
    off: !clip || !files.some((f) => f.path === clip),
    fn: () => { if (clip) void copyFile(clip, dir); },
  });
  if (file) items.push(null, { label: 'Delete…', fn: () => fileDlgDelete(file) });
  e.preventDefault();
  menu.replaceChildren(...items.map((it) => {
    if (!it) return document.createElement('hr');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.disabled = !!it.off;
    b.addEventListener('click', it.fn);
    return b;
  }));
  menu.hidden = false;
  menu.style.left = Math.max(0, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 4)) + 'px';
  menu.style.top = Math.max(0, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 4)) + 'px';
});
fileDlg.cancel.addEventListener('click', () => fileDlg.dlg.close());
fileDlg.dlg.addEventListener('click', (e) => { if (e.target === fileDlg.dlg) fileDlg.dlg.close(); });
fileDlg.form.addEventListener('submit', (e) => { e.preventDefault(); fileDlgSubmit?.(); });

// ---------- open / save ----------

async function openFile(path: string) {
  if (isDirty && doc && !confirm(`Discard unsaved changes in ${doc.path}?`)) {
    location.hash = hashFor(doc.path);
    return;
  }
  if (doc) rememberScroll(doc.path);
  const r = await api<{ content: string; mtime: string; eol: 'lf' | 'crlf'; error?: string }>('/api/file?path=' + enc(path));
  if (!r.ok) {
    showBanner(`Cannot open ${path}: ${r.data?.error ?? r.status}`, [], true);
    return;
  }
  hideBanner();
  const kind = files.find((f) => f.path === path)?.kind ?? 'data';
  doc = { path, kind, mtime: r.data.mtime, eol: r.data.eol, saved: r.data.content };
  view.setState(makeState(r.data.content, path));
  els.title.textContent = path;
  els.panes.hidden = false;
  els.empty.hidden = true;
  // Reveal the opened file in the tree.
  const parts = path.split('/').slice(0, -1);
  parts.forEach((_, i) => openDirs.add(parts.slice(0, i + 1).join('/')));
  setDirty(false);
  applyMode();
  renderTree();
  setPreviewError(null);
  if (kind !== 'openapi') { swagger = null; swaggerFor = null; }
  restoreScroll(path);
  void renderPreview();
  if (pendingLine?.path === path) { restorePv = null; gotoLine(pendingLine.line); pendingLine = null; }
}

async function save(force = false) {
  if (!doc || info.readonly) return;
  const content = view.state.doc.toString();
  const r = await api<{ mtime: string; error?: string }>('/api/file?path=' + enc(doc.path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseMtime: force ? '' : doc.mtime, eol: doc.eol }),
  });
  if (r.status === 409) {
    showBanner('This file was changed on disk since you opened it.', [
      { label: 'Overwrite with my version', fn: () => void save(true) },
      { label: 'Discard mine and reload', fn: () => { setDirty(false); void openFile(doc!.path); } },
    ]);
    return;
  }
  if (!r.ok) {
    showBanner('Save failed: ' + (r.data?.error ?? r.status), [], true);
    return;
  }
  doc.mtime = r.data.mtime;
  doc.saved = content;
  setDirty(false);
  hideBanner();
}
els.save.addEventListener('click', () => void save());

interface NewType { id: string; label: string; ext: string; hint: string; template: (name: string) => string }
const newTypes: NewType[] = [
  { id: 'md', label: 'Markdown', ext: '.md', hint: 'Notes, specs, docs', template: (n) => `# ${n}\n\n` },
  { id: 'puml', label: 'PlantUML', ext: '.puml', hint: 'UML diagram', template: () => '@startuml\n\n@enduml\n' },
  { id: 'mmd', label: 'Mermaid', ext: '.mmd', hint: 'Flowchart, sequence, ...', template: () => 'flowchart TD\n  A[Start] --> B[End]\n' },
  { id: 'csv', label: 'CSV', ext: '.csv', hint: 'Comma-separated table', template: () => 'name,description\n' },
  { id: 'tsv', label: 'TSV', ext: '.tsv', hint: 'Tab-separated table', template: () => 'name\tdescription\n' },
  { id: 'openapi', label: 'OpenAPI', ext: '.yaml', hint: 'REST API (YAML)', template: (n) => `openapi: 3.0.3\ninfo:\n  title: ${n}\n  version: 0.1.0\npaths: {}\n` },
  { id: 'asyncapi', label: 'AsyncAPI', ext: '.yaml', hint: 'Event API (YAML)', template: (n) => `asyncapi: 3.0.0\ninfo:\n  title: ${n}\n  version: 0.1.0\nchannels: {}\n` },
  { id: 'openapi-json', label: 'OpenAPI JSON', ext: '.json', hint: 'REST API (JSON)', template: (n) => `{\n  "openapi": "3.0.3",\n  "info": { "title": ${JSON.stringify(n)}, "version": "0.1.0" },\n  "paths": {}\n}\n` },
];
const newDlg = {
  dlg: $<HTMLDialogElement>('new-dlg'), form: $<HTMLFormElement>('new-form'), types: $('new-types'),
  dir: $<HTMLInputElement>('new-dir'), dirs: $('new-dirs'), name: $<HTMLInputElement>('new-name'),
  path: $('new-path'), error: $('new-error'), cancel: $('new-cancel'), create: $<HTMLButtonElement>('new-create'),
};
let newType = newTypes[0];

function newPath(): string {
  const dir = newDlg.dir.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  let name = newDlg.name.value.trim().replace(/^\/+/, '');
  if (!name) return '';
  if (extOf(name) !== newType.ext && !(newType.ext === '.yaml' && extOf(name) === '.yml')) name += newType.ext;
  return dir ? `${dir}/${name}` : name;
}
function updateNewPath() {
  const p = newPath();
  newDlg.path.textContent = p || '…';
  newDlg.create.disabled = !p;
  newDlg.error.hidden = true;
}
function selectNewType(t: NewType) {
  newType = t;
  for (const b of newDlg.types.querySelectorAll<HTMLButtonElement>('button')) {
    const on = b.dataset.id === t.id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  updateNewPath();
}
function openNewDialog(presetDir?: string) {
  newDlg.types.innerHTML = newTypes.map((t) =>
    `<button type="button" role="radio" data-id="${t.id}"><b>${esc(t.label)}</b><span>${esc(t.hint)}</span><code>${esc(t.ext)}</code></button>`).join('');
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  newDlg.dirs.innerHTML = [...dirs].sort().map((d) => `<option value="${esc(d)}"></option>`).join('');
  newDlg.dir.value = presetDir ?? (doc?.path.includes('/') ? doc.path.replace(/\/[^/]*$/, '') : '');
  newDlg.name.value = '';
  selectNewType(newTypes[0]);
  newDlg.dlg.showModal();
  newDlg.name.focus();
}
async function createNewFile() {
  const path = newPath();
  if (!path) return;
  if (path.split('/').some((s) => s === '..' || s === '')) { newDlg.error.textContent = 'Invalid path.'; newDlg.error.hidden = false; return; }
  if (files.some((f) => f.path === path)) { newDlg.dlg.close(); location.hash = hashFor(path); return; }
  const title = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
  newDlg.create.disabled = true;
  const r = await api<{ error?: string }>('/api/file?path=' + enc(path), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: newType.template(title), baseMtime: '', eol: 'lf' }),
  });
  newDlg.create.disabled = false;
  if (!r.ok) { newDlg.error.textContent = 'Cannot create file: ' + (r.data?.error ?? r.status); newDlg.error.hidden = false; return; }
  newDlg.dlg.close();
  await refreshFiles();
  location.hash = hashFor(path);
}
els.newBtn.addEventListener('click', () => openNewDialog());
newDlg.types.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.id;
  const t = newTypes.find((x) => x.id === id);
  if (t) { selectNewType(t); newDlg.name.focus(); }
});
newDlg.dir.addEventListener('input', updateNewPath);
newDlg.name.addEventListener('input', updateNewPath);
newDlg.cancel.addEventListener('click', () => newDlg.dlg.close());
newDlg.dlg.addEventListener('click', (e) => { if (e.target === newDlg.dlg) newDlg.dlg.close(); });
newDlg.form.addEventListener('submit', (e) => { e.preventDefault(); void createNewFile(); });

window.addEventListener('beforeunload', (e) => { if (isDirty) e.preventDefault(); });
window.addEventListener('hashchange', () => {
  const p = pathFromHash();
  if (p && p !== doc?.path) void openFile(p);
});

// ---------- live updates ----------

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data) as ChangeEvent;
    refreshFilesSoon();
    if (!doc || ev.path !== doc.path) {
      // A diagram referenced from an open Markdown file may have changed.
      if (doc?.kind === 'markdown' && diagramKindOf(ev.path)) { diagramCache.clear(); schedulePreview(); }
      return;
    }
    if (ev.op === 'removed') {
      showBanner('This file was deleted on disk. Saving will recreate it.');
    } else if (ev.mtime && ev.mtime !== doc.mtime) {
      if (!isDirty) {
        void openFile(doc.path);
      } else {
        showBanner('This file changed on disk while you have unsaved edits.', [
          { label: 'Reload from disk (discard mine)', fn: () => { setDirty(false); void openFile(doc!.path); } },
          { label: 'Keep mine', fn: () => { if (doc) doc.mtime = ev.mtime!; hideBanner(); } },
        ]);
      }
    }
  };
  // EventSource reconnects on its own; re-sync the tree when it does.
  es.onopen = () => void refreshFiles();
}

// ---------- boot ----------

// Best-effort: the server asks GitHub (cached) and any failure just means no notice.
async function showUpdateNotice() {
  const r = await api<UpdateInfo>('/api/update');
  if (!r.ok || !r.data.available || !r.data.latest) return;
  if (els.foot.querySelector('a.update')) return;
  const a = document.createElement('a');
  a.className = 'update';
  a.href = r.data.url || '#';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = `Update available: ${r.data.latest}`;
  a.title = r.data.manager === 'homebrew'
    ? 'Run "brew upgrade specli" to install it'
    : 'Run "specli --self-update" to install it';
  els.foot.append(a);
}

const gitDlg = {
  dlg: $<HTMLDialogElement>('git-dlg'), branch: $('git-branch'), all: $<HTMLInputElement>('git-all'),
  count: $('git-count'), list: $('git-list'), msg: $<HTMLTextAreaElement>('git-msg'),
  error: $('git-error'), ok: $('git-ok'), close: $('git-close'), commit: $<HTMLButtonElement>('git-commit'),
};
// Files the user unchecked; everything else that is changed is selected by default.
const gitUnchecked = new Set<string>();
let committing = false;

const gitSelected = () => Object.keys(git?.files ?? {}).filter((p) => !gitUnchecked.has(p));

function updateGitDialogState() {
  const total = Object.keys(git?.files ?? {}).length;
  const n = gitSelected().length;
  gitDlg.count.textContent = total ? `${n} of ${total} selected` : 'Nothing to commit';
  gitDlg.all.checked = total > 0 && n === total;
  gitDlg.all.indeterminate = n > 0 && n < total;
  gitDlg.all.disabled = !total;
  gitDlg.commit.disabled = committing || !n || !gitDlg.msg.value.trim() || info.readonly;
  gitDlg.commit.title = info.readonly ? 'specli is running read-only' : '';
  gitDlg.msg.disabled = info.readonly;
}

function renderGitDialog() {
  if (!git) return;
  gitDlg.branch.textContent = git.branch ? `on ${git.branch}` : '';
  const entries = Object.entries(git.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  for (const p of gitUnchecked) if (!git.files?.[p]) gitUnchecked.delete(p);
  gitDlg.list.replaceChildren(...entries.map(([p, k]) => {
    const row = document.createElement('label');
    row.className = 'gd-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !gitUnchecked.has(p);
    cb.addEventListener('change', () => { if (cb.checked) gitUnchecked.delete(p); else gitUnchecked.add(p); updateGitDialogState(); });
    const m = document.createElement('span');
    m.className = 'git git-' + k.replace('?', 'u');
    m.textContent = k === '?' ? 'U' : k;
    m.title = gitLabels[k] ?? 'Changed';
    const name = document.createElement('span');
    name.className = 'gd-path';
    name.textContent = p;
    name.title = p;
    row.append(cb, m, name);
    // Deleted files cannot be opened; everything else jumps to the file.
    if (k !== 'D' && files.some((f) => f.path === p)) {
      const open = document.createElement('a');
      open.href = hashFor(p);
      open.textContent = 'open';
      open.className = 'gd-open';
      open.addEventListener('click', () => gitDlg.dlg.close());
      row.append(open);
    }
    return row;
  }));
  updateGitDialogState();
}

async function openGitDialog() {
  gitDlg.error.hidden = true;
  gitDlg.ok.hidden = true;
  await refreshGit();
  renderGitDialog();
  gitDlg.dlg.showModal();
  gitDlg.msg.focus();
}

async function commitSelected() {
  const paths = gitSelected();
  if (!paths.length || !gitDlg.msg.value.trim() || committing) return;
  committing = true;
  updateGitDialogState();
  gitDlg.error.hidden = true;
  gitDlg.ok.hidden = true;
  const r = await api<{ summary?: string; error?: string }>('/api/git/commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: gitDlg.msg.value, paths }),
  });
  committing = false;
  if (!r.ok) {
    gitDlg.error.textContent = r.data?.error ?? `Commit failed (${r.status})`;
    gitDlg.error.hidden = false;
  } else {
    gitDlg.msg.value = '';
    gitUnchecked.clear();
    gitDlg.ok.textContent = 'Committed: ' + (r.data.summary ?? '');
    gitDlg.ok.hidden = false;
  }
  await refreshGit();
  renderGitDialog();
}

const gitRow = document.createElement('div');
gitRow.className = 'row git-row';
gitRow.tabIndex = 0;
gitRow.setAttribute('role', 'button');
gitRow.hidden = true;

gitRow.addEventListener('click', () => void openGitDialog());
gitRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openGitDialog(); } });
gitDlg.all.addEventListener('change', () => {
  gitUnchecked.clear();
  if (!gitDlg.all.checked) for (const p of Object.keys(git?.files ?? {})) gitUnchecked.add(p);
  renderGitDialog();
});
gitDlg.msg.addEventListener('input', updateGitDialogState);
gitDlg.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commitSelected(); } });
gitDlg.close.addEventListener('click', () => gitDlg.dlg.close());
gitDlg.dlg.addEventListener('click', (e) => { if (e.target === gitDlg.dlg) gitDlg.dlg.close(); });
document.getElementById('git-form')!.addEventListener('submit', (e) => { e.preventDefault(); void commitSelected(); });


async function refreshGit() {
  const r = await api<GitInfo>('/api/git');
  if (!r.ok) return;
  const before = JSON.stringify(git?.files ?? {});
  git = r.data;
  if (!git.available || !git.repo) { gitRow.hidden = true; } else {
    const bits = [`<span class="git-branch">⎇ ${esc(git.branch ?? '?')}</span>`];
    if (git.ahead) bits.push(`↑${git.ahead}`);
    if (git.behind) bits.push(`↓${git.behind}`);
    bits.push(git.changed ? `<span class="git-n">${git.changed} changed</span>` : 'clean');
    gitRow.innerHTML = `<span class="k">Git</span>${bits.join(' ')}`;
    gitRow.title = (git.upstream ? `Tracking ${git.upstream}. ` : 'No upstream branch. ') + 'Click to review changes.';
    gitRow.hidden = false;
  }
  if (JSON.stringify(git.files ?? {}) !== before) renderTree();
  if (gitDlg.dlg.open) renderGitDialog();
}
const refreshGitSoon = debounce(() => void refreshGit(), 400);

async function boot() {
  const r = await api<Info>('/api/info');
  if (r.ok) info = r.data;
  document.title = `${info.name} – specli`;
  els.newBtn.hidden = info.readonly;
  els.save.hidden = info.readonly;
  els.foot.innerHTML =
    `<div class="row"><span class="ver">specli ${esc(info.version)}</span>${info.readonly ? '<span class="chip">read-only</span>' : ''}</div>` +
    `<div class="path" title="${esc(info.path)}"><bdi>${esc(info.path)}</bdi></div>` +
    `<div class="row"><span class="k">PlantUML</span><span>${info.plantuml.available ? esc(info.plantuml.mode) : 'built-in'}</span></div>`;
  els.foot.append(gitRow);
  void refreshGit();
  // .git is not watched, so commits/checkouts are picked up by polling and on focus.
  setInterval(() => { if (!document.hidden) void refreshGit(); }, 5_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshGit(); });
  setDirty(false);
  void showUpdateNotice();
  // Long-running sessions: re-check periodically and when the tab regains focus
  // (the server caches the answer, so this is cheap).
  setInterval(() => void showUpdateNotice(), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void showUpdateNotice(); });
  await refreshFiles();
  connectEvents();
  const p = pathFromHash();
  if (p) void openFile(p);
}
void boot();
