// Thin fetch wrapper for the MCP server — the Node equivalent of src/ui/api/client.js.
// The MCP server never touches src/api/access/ directly; every tool call goes through
// the already-running Flashback API, exactly like the React renderer does.

const baseUrl = process.env.FLASHBACK_API_URL || 'http://localhost:50500';
const apiToken = process.env.FLASHBACK_API_TOKEN || null;

// The Electron host injects FLASHBACK_API_TOKEN when it launches this server (see
// getMcpServerConfig in electron/main.js); attach it to every request.
function authHeaders(extra = {}) {
  return apiToken ? { ...extra, Authorization: `Bearer ${apiToken}` } : { ...extra };
}

export async function request(method, path, body = null) {
  const options = { method, headers: authHeaders({ 'Content-Type': 'application/json' }) };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  return res.json();
}

export async function upload(path, formData) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', body: formData, headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  return res.json();
}

export function getBaseUrl() {
  return baseUrl;
}
