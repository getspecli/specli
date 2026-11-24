// Lightweight AsyncAPI viewer (v2.x and v3.x). Everything is built with DOM
// APIs and textContent, so spec text can never inject markup. Only references
// inside the same document ("#/...") are resolved.
import DOMPurify from 'dompurify';
import { marked } from 'marked';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export function renderAsyncApi(root: Obj): HTMLElement {
  const box = el('div', 'md async');

  const lookup = (ref: string): unknown => {
    if (!ref.startsWith('#/')) return undefined;
    let cur: unknown = root;
    for (const part of ref.slice(2).split('/')) {
      if (!isObj(cur) && !Array.isArray(cur)) return undefined;
      cur = (cur as Obj)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return cur;
  };
  // Follow $ref chains (bounded); returns the target plus a display name.
  const deref = (v: unknown): { v: Obj; name?: string } => {
    let name: string | undefined;
    let cur = v;
    for (let i = 0; i < 20 && isObj(cur) && typeof cur.$ref === 'string'; i++) {
      name = cur.$ref.split('/').pop();
      const next = lookup(cur.$ref);
      if (!isObj(next)) return { v: { $unresolved: cur.$ref }, name };
      cur = next;
    }
    return { v: isObj(cur) ? cur : {}, name };
  };

  const markdown = (text: unknown): HTMLElement | null => {
    if (typeof text !== 'string' || !text.trim()) return null;
    const d = el('div', 'async-desc');
    d.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    return d;
  };

  // ---- schemas ----

  const typeLabel = (s: Obj): string => {
    if (s.$unresolved) return String(s.$unresolved);
    let t = Array.isArray(s.type) ? s.type.join(' | ') : (s.type as string | undefined) ?? '';
    if (t === 'array' && s.items) t = `array<${typeLabel(deref(s.items).v) || 'any'}>`;
    if (!t && s.properties) t = 'object';
    if (s.format) t += t ? ` (${s.format})` : String(s.format);
    return t;
  };

  function schemaRows(tbody: HTMLElement, schema: unknown, name: string, required: boolean, depth: number, seen: Set<unknown>) {
    const { v: s, name: refName } = deref(schema);
    const tr = el('tr');
    const n = el('td');
    n.style.paddingLeft = `${9 + depth * 16}px`;
    n.append(el('code', undefined, name));
    if (required) n.append(el('span', 'async-req', ' *'));
    const t = el('td', undefined, typeLabel(s) || (refName ?? ''));
    const d = el('td');
    if (typeof s.description === 'string') d.append(s.description);
    const extra: string[] = [];
    if (Array.isArray(s.enum)) extra.push('enum: ' + s.enum.map((x: unknown) => JSON.stringify(x)).join(', '));
    if (s.const !== undefined) extra.push('const: ' + JSON.stringify(s.const));
    if (s.default !== undefined) extra.push('default: ' + JSON.stringify(s.default));
    if (s.example !== undefined) extra.push('example: ' + JSON.stringify(s.example));
    if (s.minimum !== undefined) extra.push('min: ' + s.minimum);
    if (s.maximum !== undefined) extra.push('max: ' + s.maximum);
    if (extra.length) d.append(el('div', 'async-extra', extra.join(' · ')));
    tr.append(n, t, d);
    tbody.append(tr);

    if (seen.has(s) || depth > 8) return; // circular or very deep
    const next = new Set(seen).add(s);
    const reqs: string[] = Array.isArray(s.required) ? s.required : [];
    if (isObj(s.properties)) {
      for (const [k, v] of Object.entries(s.properties)) schemaRows(tbody, v, k, reqs.includes(k), depth + 1, next);
    }
    if (s.items) {
      const it = deref(s.items).v;
      if (isObj(it.properties) || it.oneOf || it.anyOf || it.allOf) schemaRows(tbody, s.items, 'items', false, depth + 1, next);
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      if (Array.isArray(s[key])) s[key].forEach((v: unknown, i: number) => schemaRows(tbody, v, `${key}[${i}]`, false, depth + 1, next));
    }
  }

  const schemaTable = (schema: unknown, title: string, rootName = 'payload'): HTMLElement => {
    const wrap = el('div', 'async-schema');
    wrap.append(el('h5', undefined, title));
    const table = el('table');
    const head = el('thead');
    const hr = el('tr');
    for (const h of ['Field', 'Type', 'Description']) hr.append(el('th', undefined, h));
    head.append(hr);
    const body = el('tbody');
    schemaRows(body, schema, rootName, false, 0, new Set());
    table.append(head, body);
    wrap.append(table);
    return wrap;
  };

  // ---- messages ----

  const messageEl = (raw: unknown, fallbackName: string): HTMLElement => {
    const { v: m, name: refName } = deref(raw);
    const card = el('div', 'async-msg');
    const head = el('div', 'async-msg-head');
    head.append(el('strong', undefined, String(m.name ?? m.title ?? refName ?? fallbackName)));
    if (m.contentType) head.append(el('span', 'async-chip', String(m.contentType)));
    card.append(head);
    if (m.summary) card.append(el('p', 'async-sum', String(m.summary)));
    const desc = markdown(m.description);
    if (desc) card.append(desc);
    if (m.headers) card.append(schemaTable(m.headers, 'Headers', 'headers'));
    if (m.payload) card.append(schemaTable(m.payload, 'Payload'));
    return card;
  };

  // v2: operation.message may be a single message or { oneOf: [...] }
  const messagesOf = (msg: unknown): unknown[] => {
    if (!msg) return [];
    if (isObj(msg) && Array.isArray(msg.oneOf)) return msg.oneOf;
    return [msg];
  };

  const operationEl = (action: string, label: string, op: Obj, messages: unknown[]): HTMLElement => {
    const o = el('div', 'async-op');
    const head = el('div', 'async-op-head');
    head.append(el('span', `async-act async-${action}`, label.toUpperCase()));
    const title = op.operationId ?? op.title ?? op.summary;
    if (title) head.append(el('span', undefined, String(title)));
    o.append(head);
    if (op.summary && op.summary !== title) o.append(el('p', 'async-sum', String(op.summary)));
    const desc = markdown(op.description);
    if (desc) o.append(desc);
    messages.forEach((m, i) => o.append(messageEl(m, `message ${i + 1}`)));
    return o;
  };

  // ---- sections ----

  const section = (title: string): HTMLElement => {
    const s = el('section', 'async-sec');
    s.append(el('h3', undefined, title));
    box.append(s);
    return s;
  };

  const info = isObj(root.info) ? root.info : {};
  const head = el('div', 'async-title');
  head.append(el('h1', undefined, String(info.title ?? 'AsyncAPI')));
  if (info.version) head.append(el('span', 'async-chip', 'v' + info.version));
  head.append(el('span', 'async-chip', 'AsyncAPI ' + String(root.asyncapi)));
  box.append(head);
  const idesc = markdown(info.description);
  if (idesc) box.append(idesc);

  const isV3 = String(root.asyncapi).startsWith('3');

  // Servers
  if (isObj(root.servers) && Object.keys(root.servers).length) {
    const sec = section('Servers');
    const table = el('table');
    const hr = el('tr');
    for (const h of ['Name', 'URL', 'Protocol', 'Description']) hr.append(el('th', undefined, h));
    const th = el('thead');
    th.append(hr);
    const tb = el('tbody');
    for (const [k, raw] of Object.entries(root.servers)) {
      const s = deref(raw).v;
      const url = s.url ?? [s.host, s.pathname].filter(Boolean).join('');
      const tr = el('tr');
      tr.append(el('td', undefined, k), el('td', undefined, String(url ?? '')),
        el('td', undefined, [s.protocol, s.protocolVersion].filter(Boolean).join(' ')), el('td', undefined, String(s.description ?? '')));
      tb.append(tr);
    }
    table.append(th, tb);
    sec.append(table);
  }

  // Channels + operations
  const channels = isObj(root.channels) ? root.channels : {};
  const chSec = Object.keys(channels).length ? section(isV3 ? 'Channels & operations' : 'Channels') : null;
  const v3ops = isObj(root.operations) ? Object.entries(root.operations) : [];

  for (const [key, rawCh] of Object.entries(channels)) {
    const { v: ch } = deref(rawCh);
    const card = el('div', 'async-ch');
    const h = el('h4');
    h.append(el('code', undefined, String(ch.address ?? key)));
    if (isV3 && ch.address && ch.address !== key) h.append(el('span', 'async-chip', key));
    card.append(h);
    const d = markdown(ch.description);
    if (d) card.append(d);

    if (isObj(ch.parameters) && Object.keys(ch.parameters).length) {
      const ps = el('div', 'async-params');
      ps.append(el('strong', undefined, 'Parameters: '));
      Object.entries(ch.parameters).forEach(([pk, pv], i) => {
        const p = deref(pv).v;
        ps.append(i ? ', ' : '', el('code', undefined, pk), p.description ? ` – ${p.description}` : '');
      });
      card.append(ps);
    }

    if (isV3) {
      // v3: operations live at the top level and point at the channel
      const here = v3ops.filter(([, o]) => {
        const target = isObj(o) && isObj(o.channel) ? o.channel.$ref : undefined;
        return target === `#/channels/${key}`;
      });
      for (const [opKey, rawOp] of here) {
        const op = deref(rawOp).v;
        const msgs = Array.isArray(op.messages) ? op.messages : isObj(ch.messages) ? Object.values(ch.messages) : [];
        card.append(operationEl(String(op.action ?? 'op'), String(op.action ?? 'op'), { ...op, operationId: op.title ?? opKey }, msgs));
      }
      if (!here.length && isObj(ch.messages)) {
        for (const [mk, mv] of Object.entries(ch.messages)) card.append(messageEl(mv, mk));
      }
    } else {
      for (const action of ['publish', 'subscribe'] as const) {
        if (!isObj(ch[action])) continue;
        const op = deref(ch[action]).v;
        card.append(operationEl(action, action, op, messagesOf(op.message)));
      }
    }
    chSec!.append(card);
  }

  // Reusable components
  const comps = isObj(root.components) ? root.components : {};
  if (isObj(comps.schemas) && Object.keys(comps.schemas).length) {
    const sec = section('Schemas');
    for (const [k, v] of Object.entries(comps.schemas)) sec.append(schemaTable(v, k, k));
  }

  if (!box.querySelector('.async-sec')) box.append(el('p', 'async-sum', 'No servers, channels or schemas defined.'));
  return box;
}
