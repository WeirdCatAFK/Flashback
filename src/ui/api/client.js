let baseUrl = null;
let apiToken = null;

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

function authHeaders(extra = {}) {
  return apiToken
    ? { ...extra, Authorization: `Bearer ${apiToken}` }
    : { ...extra };
}

export function appendToken(url) {
  if (!apiToken) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(apiToken)}`;
}

export async function pingApi() {
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl}/`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function request(method, path, body = null) {
  const options = {
    method,
    headers: authHeaders({ "Content-Type": "application/json" }),
  };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), {
      status: res.status,
      code: err.code,
      etag: err.etag,
    });
  }
  return res.json();
}

export async function requestWithEtag(method, path) {
  const options = { method, headers: authHeaders() };
  const res = await fetch(`${baseUrl}${path}`, options);
  if (res.status === 404) return { data: null, etag: null };
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
  }
  return { data: await res.json(), etag: res.headers.get("ETag") };
}

export function isStale(err) {
  return err?.status === 409 && err?.code === "stale";
}

export async function upload(path, formData) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    body: formData,
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? res.statusText), {
      status: res.status,
    });
  }
  return res.json();
}

export function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${baseUrl}${path}`);
    if (apiToken) xhr.setRequestHeader("Authorization", `Bearer ${apiToken}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({});
        }
      } else {
        try {
          reject(
            Object.assign(new Error(JSON.parse(xhr.responseText).error), {
              status: xhr.status,
            }),
          );
        } catch {
          reject(new Error(xhr.statusText));
        }
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(formData);
  });
}
