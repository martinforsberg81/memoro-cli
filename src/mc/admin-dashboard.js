const BASE = 'https://meetmemoro.app/admin';
const SOURCES = { health: `${BASE}/health`, operations: `${BASE}/operations/status` };
const SERVICE_NAMES = ['secrets', 'd1', 'r2', 'kv', 'universeVectors', 'queues'];
const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 200;
const MAX_CODES = 50;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u001b]/gu;
const clean = (value, max = 120) => typeof value === 'string' ? value.replace(CONTROL, '').slice(0, max) : null;
const numeric = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const safeCodes = (v) => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > MAX_CODES) throw Error('too_many_items'); return v.map(x => clean(String(x), 80)); };
const sourceTime = value => { const text = clean(value, 64); return text && Number.isFinite(Date.parse(text)) ? text : null; };

async function bodyText(response) {
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw Error('oversized'); } chunks.push(value); }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw Error('oversized');
  return text;
}
function age(timestamp, now) {
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(ms)) return { ageSeconds: null, future: false };
  const delta = Math.floor((now - ms) / 1000);
  return { ageSeconds: Math.max(0, delta), future: delta < 0 };
}
function sourceRecord(availability, errorCode, timestamp, data, now) {
  return { availability, errorCode, timestamp, ...age(timestamp, now), data };
}
function healthProjection(body) {
  if (!body || body.ok !== true || typeof body.status !== 'string' || !body.services || typeof body.services !== 'object' || Array.isArray(body.services)) throw Error('invalid_shape');
  const services = SERVICE_NAMES.map(name => {
    const s = body.services[name] || {};
    if (typeof s !== 'object' || Array.isArray(s) || (Object.hasOwn(body.services, name) && typeof s.status !== 'string')) throw Error('invalid_shape');
    const counts = {};
    for (const k of ['present', 'total', 'vectorCount', 'latency']) if (Object.hasOwn(s, k)) counts[k] = numeric(s[k]);
    return { name, status: clean(s.status, 50) || 'unknown', latency: numeric(s.latency), counts, note: name === 'queues' ? clean(s.note, 120) : null };
  });
  return { status: clean(body.status, 50) || 'unknown', services };
}
function operationsProjection(body) {
  if (!body || body.ok !== true || !Array.isArray(body.operations)) throw Error('invalid_shape');
  if (body.operations.length > MAX_ITEMS) throw Error('too_many_items');
  if (!body.incidents || typeof body.incidents !== 'object' || Array.isArray(body.incidents)) throw Error('invalid_shape');
  if (body.warnings !== undefined && !Array.isArray(body.warnings)) throw Error('invalid_shape');
  if (body.warnings?.length > MAX_CODES) throw Error('too_many_items');
  const operations = body.operations.map(op => {
    if (!op || typeof op.key !== 'string') throw Error('invalid_shape');
    if (op.warnings !== undefined && !Array.isArray(op.warnings)) throw Error('invalid_shape');
    if (op.warnings?.length > MAX_CODES) throw Error('too_many_items');
    if (op.conclusion?.reasonCodes !== undefined && !Array.isArray(op.conclusion.reasonCodes)) throw Error('invalid_shape');
    if (op.conclusion?.reasonCodes?.length > MAX_CODES) throw Error('too_many_items');
    const counts = {};
    if (op.counts && typeof op.counts === 'object' && !Array.isArray(op.counts)) for (const [k,v] of Object.entries(op.counts)) if (/^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(k) && numeric(v) !== null) counts[k] = v;
    const key = clean(op.key, 100);
    if (!key) throw Error('invalid_shape');
    const level = ['action','watch','ok'].includes(op.conclusion?.level) ? op.conclusion.level : 'unknown';
    return { key, label: clean(op.label || op.key, 120), state: clean(op.state, 50) || 'unknown', level, reasons: safeCodes(op.conclusion?.reasonCodes), warnings: safeCodes(op.warnings), counts, startedAt: clean(op.latestRun?.startedAt, 64), finishedAt: clean(op.latestRun?.finishedAt || op.latestRun?.processedAt, 64) };
  });
  const inc = body.incidents;
  if (!inc.summary || typeof inc.summary !== 'object' || Array.isArray(inc.summary)) throw Error('invalid_shape');
  const groups = [];
  if (Object.keys(inc.summary).length > MAX_CODES) throw Error('too_many_items');
  for (const [status,g] of Object.entries(inc.summary)) groups.push({ status: clean(status, 50), count: numeric(g?.count), occurrences: numeric(g?.occurrences) });
  return { operations, warnings: safeCodes(body.warnings), incidents: { groups, totalGroups: numeric(inc?.totalGroups), totalOccurrences: numeric(inc?.totalOccurrences) } };
}
async function readSource(name, token, fetchImpl, now) {
  if (!token) return sourceRecord('unavailable', 'missing_credentials', null, null, now);
  try {
    const response = await fetchImpl(SOURCES[name], { method:'GET', cache:'no-store', redirect:'error', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control':'no-store', 'X-Operator-Purpose':'maintenance', Authorization:`Bearer ${token}` } });
    if (!response.ok) return sourceRecord('unavailable', `http_${response.status}`, null, null, now);
    const body = JSON.parse(await bodyText(response));
    const data = name === 'health' ? healthProjection(body) : operationsProjection(body);
    const timestamp = sourceTime(name === 'health' ? body.checkedAt : body.generatedAt);
    return sourceRecord('available', null, timestamp, data, now);
  } catch (error) {
    const code = error?.message === 'oversized' ? 'response_too_large' : ['invalid_shape','too_many_items'].includes(error?.message) ? error.message : error instanceof SyntaxError ? 'invalid_json' : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'read_failed';
    return sourceRecord('unavailable', code, null, null, now);
  }
}
export async function collectDashboard({ token, fetch: fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  const nowDate = clock(); const now = nowDate.getTime(); const fetchedAt = nowDate.toISOString();
  const [health, operations] = await Promise.all(['health','operations'].map(n => readSource(n, token, fetchImpl, now)));
  const model = { schemaVersion:1, environment:'production', fetchedAt, sources:{ health, operations } };
  return { model, exitCode: health.availability === 'available' && operations.availability === 'available' ? 0 : 1 };
}
const order = { action:0, watch:1, unknown:2, ok:3 };
export function renderDashboard(model) {
  const { health, operations } = model.sources;
  const ageText = s => s.ageSeconds === null ? 'unknown' : `${s.ageSeconds}s${s.future ? ' (future timestamp)' : ''}`;
  const out = [`MEMORO ADMIN — production — fetched ${model.fetchedAt}`, `Sources: health ${health.availability}; operations ${operations.availability}`, `Source times: health ${health.timestamp || 'unknown'} (age ${ageText(health)}); operations ${operations.timestamp || 'unknown'} (age ${ageText(operations)})`, '', 'ATTENTION'];
  if (health.availability !== 'available') out.push(`- health unavailable (${health.errorCode})`);
  if (operations.availability !== 'available') out.push(`- operations unavailable (${operations.errorCode})`);
  if (health.availability === 'available') {
    if (health.data.status !== 'healthy') out.push(`- health status ${health.data.status}`);
    for (const service of health.data.services) if (service.status !== 'healthy') out.push(`- service ${service.name}: ${service.status}`);
  }
  if (operations.availability === 'available') {
    for (const op of operations.data.operations) if (op.level !== 'ok') out.push(`- ${op.key}: ${op.level}${op.reasons.length ? ` (${op.reasons.join(', ')})` : ''}`);
    for (const w of operations.data.warnings) out.push(`- warning ${w}`);
    for (const op of operations.data.operations) for (const w of op.warnings) out.push(`- ${op.key} warning ${w}`);
    for (const g of operations.data.incidents.groups) if (['new','regressed','acknowledged'].includes(g.status)) out.push(`- incidents ${g.status}: ${g.count ?? 'unknown'} groups / ${g.occurrences ?? 'unknown'} occurrences`);
  }
  if (out[out.length-1] === 'ATTENTION') out.push('- No reported attention signals; unknown source or conclusion remains unknown.');
  out.push('', 'OPERATIONS');
  if (operations.availability === 'available') for (const op of [...operations.data.operations].sort((a,b)=>(order[a.level]??2)-(order[b.level]??2)||a.key.localeCompare(b.key))) out.push(`${op.key} — ${op.label} — ${op.state} — ${op.level} — reasons: ${op.reasons.join(',')||'none'} — counts: ${Object.entries(op.counts).map(([k,v])=>`${k}=${v}`).join(',')||'unknown'} — run: ${op.startedAt||'unknown'} / ${op.finishedAt||'unknown'}`);
  out.push('', 'INCIDENTS');
  if (operations.availability === 'available') { const i=operations.data.incidents; out.push(`Stored incident aggregates: ${i.totalGroups ?? 'unknown'} groups; ${i.totalOccurrences ?? 'unknown'} occurrences`); for (const g of i.groups) out.push(`${g.status}: ${g.count ?? 'unknown'} groups / ${g.occurrences ?? 'unknown'} occurrences`); }
  else out.push('unknown (operations source unavailable)');
  out.push('', 'SERVICES');
  if (health.availability === 'available') for (const s of health.data.services) out.push(`${s.name}: ${s.status}${s.latency === null ? '' : `; ${s.latency} ms`}${s.counts.present !== undefined || s.counts.total !== undefined ? `; ${s.counts.present ?? 'unknown'}/${s.counts.total ?? 'unknown'}` : ''}${s.note ? `; ${s.note}` : ''}${s.name === 'queues' ? ' (binding availability only; not delivery health or backlog)' : ''}`);
  else out.push('unknown (health source unavailable)');
  out.push('', 'WEB DETAIL', 'https://meetmemoro.app/admin/operations', 'https://meetmemoro.app/admin/', 'Financial, user, content, identity and security dashboards are not connected yet.');
  return out.join('\n');
}
