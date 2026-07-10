// Thin fetch wrapper for the MCP server — the Node equivalent of src/ui/api/client.js.
// The MCP server never touches src/api/access/ directly; every tool call goes through
// the already-running Flashback API, exactly like the React renderer does.

// Read lazily (not at module load) so a test harness can start the API on an
// ephemeral port and set the env vars before the first request goes out.
const baseUrl = () => process.env.FLASHBACK_API_URL || 'http://localhost:50500';
const apiToken = () => process.env.FLASHBACK_API_TOKEN || null;

// The Electron host injects FLASHBACK_API_TOKEN when it launches this server (see
// getMcpServerConfig in electron/main.js); attach it to every request.
function authHeaders(extra = {}) {
  const token = apiToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

export async function request(method, path, body = null) {
  const options = { method, headers: authHeaders({ 'Content-Type': 'application/json' }) };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl()}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  return res.json();
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
