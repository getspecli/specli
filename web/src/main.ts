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
import { renderMermaid, renderPlantumlInBrowser, type DiagramResult } from './diagrams';

// ---------- types & state ----------

type Kind = 'markdown' | 'plantuml' | 'mermaid' | 'openapi' | 'data';
type Mode = 'edit' | 'split' | 'preview';

interface FileInfo { path: string; kind: Kind; size: number; mtime: string }
interface Info { name: string; path: string; readonly: boolean; version: string; plantuml: { available: boolean; mode: string } }
interface UpdateInfo { current: string; latest?: string; available: boolean; url?: string }
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
let doc: Doc | null = null;
let mode: Mode = 'split';
let isDirty = false;
let renderSeq = 0;
const closedDirs = new Set<string>();
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
    pre.textContent = src;
    el.append(msg, pre);
  }
}

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

function renderMarkdown(text: string, docPath: string, seq: number) {
  umlBlocks = [];
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

// ---------- preview dispatch ----------

async function renderPreview() {
  if (!doc || effectiveMode() === 'edit') return;
  const seq = ++renderSeq;
  const text = view.state.doc.toString();
  const { kind, path } = doc;
  if (kind !== 'openapi') { swagger = null; swaggerFor = null; setPreviewError(null); }
  if (kind === 'markdown') {
    renderMarkdown(text, path, seq);
  } else if (kind === 'plantuml' || kind === 'mermaid') {
    els.pvBody.className = '';
    const box = document.createElement('div');
    box.className = 'uml';
    box.textContent = 'Rendering…';
    els.pvBody.replaceChildren(box);
    await fillDiagram(box, kind, text, seq);
  } else if (kind === 'openapi') {
    await renderOpenApi(text, path, seq);
  }
}
const schedulePreview = debounce(() => void renderPreview(), 350);

// ---------- file tree ----------

const kindBadge: Record<Kind, string> = { markdown: 'MD', plantuml: 'UML', mermaid: 'MMD', openapi: 'API', data: 'DAT' };

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

function fileLink(f: FileInfo, label: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'file' + (doc?.path === f.path ? ' active' : '');
  a.href = hashFor(f.path);
  a.title = f.path;
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
  return a;
}

function renderNode(n: TreeNode, into: HTMLElement) {
  for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const det = document.createElement('details');
    det.open = !closedDirs.has(d.path);
    det.addEventListener('toggle', () => { if (det.open) closedDirs.delete(d.path); else closedDirs.add(d.path); });
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
    if (!files.length) els.tree.textContent = 'No Markdown, PlantUML, Mermaid or OpenAPI files found.';
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
const refreshFilesSoon = debounce(() => void refreshFiles(), 300);

// ---------- open / save ----------

async function openFile(path: string) {
  if (isDirty && doc && !confirm(`Discard unsaved changes in ${doc.path}?`)) {
    location.hash = hashFor(doc.path);
    return;
  }
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
  setDirty(false);
  applyMode();
  renderTree();
  setPreviewError(null);
  if (kind !== 'openapi') { swagger = null; swaggerFor = null; }
  void renderPreview();
  if (pendingLine?.path === path) { gotoLine(pendingLine.line); pendingLine = null; }
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

els.newBtn.addEventListener('click', async () => {
  const p = prompt('New file path, relative to the project root (e.g. docs/design.md, diagrams/flow.puml, diagrams/flow.mmd, api/openapi.yaml):', 'docs/');
  if (!p) return;
  const path = p.trim().replace(/^\/+/, '');
  if (files.some((f) => f.path === path)) { location.hash = hashFor(path); return; }
  const ext = extOf(path);
  let content: string;
  if (ext === '.md' || ext === '.markdown') content = '# Title\n\n';
  else if (isPuml(path)) content = '@startuml\n\n@enduml\n';
  else if (isMermaid(path)) content = 'flowchart TD\n  A[Start] --> B[End]\n';
  else if (ext === '.yaml' || ext === '.yml') content = 'openapi: 3.0.3\ninfo:\n  title: New API\n  version: 0.1.0\npaths: {}\n';
  else if (ext === '.json') content = '{\n  "openapi": "3.0.3",\n  "info": { "title": "New API", "version": "0.1.0" },\n  "paths": {}\n}\n';
  else { alert('Unsupported file type. Use .md, .puml, .mmd, .yaml/.yml or .json'); return; }
  const r = await api<{ error?: string }>('/api/file?path=' + enc(path), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseMtime: '', eol: 'lf' }),
  });
  if (!r.ok) { showBanner('Cannot create file: ' + (r.data?.error ?? r.status), [], true); return; }
  await refreshFiles();
  location.hash = hashFor(path);
});

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
  const a = document.createElement('a');
  a.className = 'update';
  a.href = r.data.url || '#';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = `Update available: ${r.data.latest}`;
  a.title = 'Run "specli --self-update" to install it';
  els.foot.append(a);
}

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
  setDirty(false);
  void showUpdateNotice();
  await refreshFiles();
  connectEvents();
  const p = pathFromHash();
  if (p) void openFile(p);
}
void boot();
