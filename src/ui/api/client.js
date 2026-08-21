let baseUrl = null;
let apiToken = null;

// Bumped on every re-init. The app points at either the local API or a remote Flashback
// Server, and both are just a {url, token} pair — so "switch vault" and "connect to a
// remote" are the same operation from here, and this counter is how the UI knows the
// data underneath it belongs to a different vault now. Used as a React key to discard
// every view's state rather than let the previous vault's documents linger.
let connectionId = 0;

export function initClient(url, token = null) {
  baseUrl = url;
  apiToken = token || null;
  connectionId += 1;
}

export function getConnectionId() {
  return connectionId;
}

export function getBaseUrl() {
  return baseUrl;
}

export function getToken() {
  return apiToken;
}

// Builds request headers with the bearer token attached (when configured).
function authHeaders(extra = {}) {
  return apiToken ? { ...extra, Authorization: `Bearer ${apiToken}` } : { ...extra };
}

// Appends the token as a query param for browser-initiated loads that can't set
// headers — PDF/media URLs, <img>/<audio> src. No-op when no token is configured.
export function appendToken(url) {
  if (!apiToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(apiToken)}`;
}

// Lightweight readiness probe. Hits the API root (`GET /` → 200) so the app can
// gate rendering until the server process is actually listening. Resolves true
// on any 2xx, false on a network error or non-2xx — never throws.
export async function pingApi() {
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function request(method, path, body = null) {
  const options = {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json' }),
  };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // `code` and `etag` come from a refused write: the document changed since this client
    // read it (see documents._assertFresh). They ride on the error so a caller can tell
    // "you are out of date, here is the current version" apart from a generic failure —
    // isStale() below is the only thing a view should need to check.
    throw Object.assign(new Error(err.error ?? res.statusText), {
      status: res.status,
      code: err.code,
      etag: err.etag,
    });
  }
  return res.json();
}

/**
 * True when a write was refused because someone else got there first.
 *
 * Not the same as any other 409 the API returns (a name collision, say), which is why it
 * tests the code rather than the status: a stale write is recoverable by re-reading, and
 * nothing else with that status is.
 */
export function isStale(err) {
  return err?.status === 409 && err?.code === 'stale';
}

export async function upload(path, formData) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', body: formData, headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  return res.json();
}

export function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}${path}`);
    if (apiToken) xhr.setRequestHeader('Authorization', `Bearer ${apiToken}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { resolve({}); }
      } else {
        try { reject(Object.assign(new Error(JSON.parse(xhr.responseText).error), { status: xhr.status })); }
        catch { reject(new Error(xhr.statusText)); }
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(formData);
  });
}
