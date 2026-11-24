const baseUrl = () => process.env.FLASHBACK_API_URL || 'http://localhost:50500';
const apiToken = () => process.env.FLASHBACK_API_TOKEN || null;

function authHeaders(extra = {}) {
  const token = apiToken();
  const base = { ...extra, 'X-Flashback-Client': 'mcp' };
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

export async function request(method, path, body = null) {
  const options = { method, headers: authHeaders({ 'Content-Type': 'application/json' }) };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl()}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status, code: err.code });
  }
  return res.json();
}

export async function requestWithEtag(method, path) {
  const res = await fetch(`${baseUrl()}${path}`, { method, headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  return { data: await res.json(), etag: res.headers.get('ETag') };
}

export async function requestBuffer(path) {
  const res = await fetch(`${baseUrl()}${path}`, { method: 'GET', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim(),
  };
}

export async function upload(path, formData) {
  const res = await fetch(`${baseUrl()}${path}`, { method: 'POST', body: formData, headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  return res.json();
}

export function getBaseUrl() {
  return baseUrl();
}
