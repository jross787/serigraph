import { parseMap } from '../shared/model.js';

const WORKBENCH_ORIGIN = 'https://workbench.md';
const LINK_START = '<!-- serigraph-link:start -->';
const LINK_END = '<!-- serigraph-link:end -->';
const DOC_PATH = /^\/d\/([A-Za-z0-9_-]+)(?:\/agent)?\/?$/;
const SHARE_ROLES = new Set(['view', 'comment', 'suggest', 'edit']);

export class WorkbenchError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = 'WorkbenchError';
    this.status = status;
    Object.assign(this, details);
  }
}

export function parseWorkbenchShareUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); }
  catch { throw new WorkbenchError(400, 'Paste a complete Workbench share link.'); }
  const match = url.pathname.match(DOC_PATH);
  const key = url.searchParams.get('key');
  if (url.origin !== WORKBENCH_ORIGIN || !match || !key || /\s/.test(key)) {
    throw new WorkbenchError(400, 'Use a workbench.md document link that includes its share key.');
  }
  return { docId: match[1], key };
}

function authHeaders(key, extra = {}) {
  return { 'X-Share-Key': key, ...extra };
}

async function errorMessage(response) {
  try {
    const data = await response.json();
    return data.error || data.message || response.statusText;
  } catch {
    try { return (await response.text()).trim() || response.statusText; }
    catch { return response.statusText; }
  }
}

async function checkedFetch(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw new WorkbenchError(response.status, await errorMessage(response));
  return response;
}

function contentUrl(docId, suffix = '') {
  return `${WORKBENCH_ORIGIN}/api/docs/${encodeURIComponent(docId)}${suffix}`;
}

function normalizeSource(source) {
  return source.endsWith('\n') ? source : `${source}\n`;
}

export function extractSerigraphSource(content) {
  const start = content.indexOf(LINK_START);
  const end = content.indexOf(LINK_END, start + LINK_START.length);
  if (start < 0 || end < 0) return null;
  const linked = content.slice(start + LINK_START.length, end);
  const match = linked.match(/(?:^|\n)(`{3,})yaml(?:[ \t]+[^\n]*)?\n([\s\S]*?)\n\1(?=\n|$)/);
  return match ? normalizeSource(match[2]) : null;
}

function fenceFor(source) {
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function graphFromModel(model) {
  const groups = [];
  const visit = (scope, id, label) => {
    groups.push({
      id,
      label,
      nodes: scope.nodes.map((node) => ({ id: node.id, label: node.label, type: node.type })),
      edges: scope.edges.map((edge) => ({ from: edge.from, to: edge.to, label: edge.label || '' })),
    });
    for (const node of scope.nodes) if (node.children) visit(node.children, node.id, node.label);
  };
  visit(model.root, 'root', 'Overview');
  return { name: model.name, mode: model.mode, nodeCount: model.nodeCount, groups };
}

const PREVIEW_HTML = `<style>
:root{color-scheme:light dark;font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:Canvas;color:CanvasText}.wrap{padding:16px}.head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}.head h2{font-size:18px;margin:0}.meta{opacity:.62;font-size:11px}.groups{display:grid;gap:12px}.group{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:10px;padding:12px;background:color-mix(in srgb,Canvas 95%,CanvasText 5%)}.group h3{font-size:12px;margin:0 0 9px}.nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px}.node{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:7px;padding:8px;background:Canvas}.type{display:block;opacity:.55;font-size:9px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}.label{font-weight:650}.edges{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.edge{font-size:10px;opacity:.72;padding:3px 6px;border-radius:999px;background:color-mix(in srgb,CanvasText 8%,transparent)}.empty{opacity:.6}</style><div class="wrap"><div class="head"><h2 id="title"></h2><span class="meta" id="meta"></span></div><div class="groups" id="groups"></div></div><script>
const graph=(window.margin&&window.margin.state&&window.margin.state.graph)||{};const title=document.getElementById('title');const meta=document.getElementById('meta');const groups=document.getElementById('groups');title.textContent=graph.name||'Serigraph map';meta.textContent=[graph.mode,Number.isFinite(graph.nodeCount)?graph.nodeCount+' items':null].filter(Boolean).join(' · ');for(const group of graph.groups||[]){const section=document.createElement('section');section.className='group';const heading=document.createElement('h3');heading.textContent=group.label||group.id;section.append(heading);const nodes=document.createElement('div');nodes.className='nodes';for(const item of group.nodes||[]){const card=document.createElement('div');card.className='node';const type=document.createElement('span');type.className='type';type.textContent=item.type||'item';const label=document.createElement('span');label.className='label';label.textContent=item.label||item.id;card.append(type,label);nodes.append(card)}if(!nodes.childElementCount){const empty=document.createElement('div');empty.className='empty';empty.textContent='No items in this group';nodes.append(empty)}section.append(nodes);if((group.edges||[]).length){const edges=document.createElement('div');edges.className='edges';for(const item of group.edges){const edge=document.createElement('span');edge.className='edge';edge.textContent=item.from+' → '+item.to+(item.label?' · '+item.label:'');edges.append(edge)}section.append(edges)}groups.append(section)}</script>`;

export function upsertSerigraphContent(content, source) {
  const normalized = normalizeSource(source);
  const { model, errors } = parseMap(normalized);
  if (!model || errors.length) throw new WorkbenchError(422, 'Workbench sync requires a valid Serigraph map.', { errors });
  const fence = fenceFor(normalized);
  const widget = JSON.stringify({
    title: `Serigraph · ${model.name}`,
    state: { graph: graphFromModel(model) },
    html: PREVIEW_HTML,
  });
  const section = [
    LINK_START,
    '## Serigraph map',
    '',
    'This preview and its YAML source stay in sync with Serigraph.',
    '',
    `${fence}yaml`,
    normalized.trimEnd(),
    fence,
    '',
    '```widget #serigraph-preview',
    widget,
    '```',
    LINK_END,
  ].join('\n');
  const start = content.indexOf(LINK_START);
  const end = content.indexOf(LINK_END, start + LINK_START.length);
  if (start >= 0 && end >= 0) return `${content.slice(0, start)}${section}${content.slice(end + LINK_END.length)}`;
  return `${content.trimEnd()}\n\n${section}\n`;
}

async function readContent(ref, fetchImpl) {
  const response = await checkedFetch(contentUrl(ref.docId, '/content'), {
    headers: authHeaders(ref.key, { Accept: 'text/markdown' }),
  }, fetchImpl);
  const content = await response.text();
  return {
    content,
    source: extractSerigraphSource(content),
    version: response.headers.get('x-doc-version') || response.headers.get('etag'),
    etag: response.headers.get('etag'),
  };
}

export async function inspectWorkbench(link, { fetchImpl = fetch } = {}) {
  const ref = parseWorkbenchShareUrl(link);
  const [metadataResponse, current] = await Promise.all([
    checkedFetch(contentUrl(ref.docId), { headers: authHeaders(ref.key, { Accept: 'application/json' }) }, fetchImpl),
    readContent(ref, fetchImpl),
  ]);
  const metadata = await metadataResponse.json();
  const doc = metadata.doc ?? metadata;
  return {
    docId: ref.docId,
    title: doc.title || ref.docId,
    role: doc.role || metadata.role || 'view',
    hasMap: current.source != null,
    source: current.source,
    version: current.version,
  };
}

export async function pushWorkbench(link, source, {
  baseVersion = null,
  baseSource = null,
  fetchImpl = fetch,
} = {}) {
  const ref = parseWorkbenchShareUrl(link);
  const normalized = normalizeSource(source);
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readContent(ref, fetchImpl);
    const remote = current.source;
    const base = baseSource == null ? null : normalizeSource(baseSource);
    if (baseVersion && current.version !== baseVersion
      && remote !== base
      && remote !== normalized) {
      throw new WorkbenchError(409, 'The Workbench map changed after your last sync.', {
        currentVersion: current.version,
        remoteSource: remote,
      });
    }
    const content = upsertSerigraphContent(current.content, normalized);
    if (content === current.content) {
      return { ok: true, version: current.version, source: remote ?? normalized };
    }
    const response = await fetchImpl(`${contentUrl(ref.docId, '/content')}?author=serigraph-sync`, {
      method: 'PUT',
      headers: authHeaders(ref.key, {
        'Content-Type': 'text/markdown',
        ...(current.etag ? { 'If-Match': current.etag } : {}),
      }),
      body: content,
    });
    if (response.status === 409 && attempt === 0) continue;
    if (!response.ok) throw new WorkbenchError(response.status, await errorMessage(response));
    let result = {};
    try { result = await response.json(); } catch { /* successful empty response */ }
    return {
      ok: true,
      version: result.version || response.headers.get('x-doc-version') || response.headers.get('etag'),
      source: normalized,
    };
  }
  throw new WorkbenchError(409, 'Workbench changed while Serigraph was syncing. Try again.');
}

export async function createWorkbenchShare(link, role, { fetchImpl = fetch } = {}) {
  if (!SHARE_ROLES.has(role)) throw new WorkbenchError(400, 'Choose view, comment, suggest, or edit access.');
  const ref = parseWorkbenchShareUrl(link);
  const response = await checkedFetch(contentUrl(ref.docId, '/shares'), {
    method: 'POST',
    headers: authHeaders(ref.key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ role }),
  }, fetchImpl);
  const data = await response.json();
  return { role: data.share.role, url: data.share.url, agentUrl: data.share.agent_url };
}

export async function watchWorkbench(link, since = 'latest', { fetchImpl = fetch, wait = 25 } = {}) {
  const ref = parseWorkbenchShareUrl(link);
  const cursor = since === 'latest' || /^\d+$/.test(String(since)) ? String(since) : 'latest';
  const response = await checkedFetch(`${contentUrl(ref.docId, '/events')}?since=${encodeURIComponent(cursor)}&wait=${Math.min(55, Math.max(0, wait))}`, {
    headers: authHeaders(ref.key, { Accept: 'application/json' }),
  }, fetchImpl);
  return response.json();
}
