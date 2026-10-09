// Thin client for the FastAPI backend. In dev, Vite proxies /api to :5000.
const API = import.meta.env.VITE_API_URL || '/api';

/** Port of the FastAPI backend the UI talks to (direct URL, else the Vite proxy target). */
export function backendPort() {
  const target = import.meta.env.VITE_API_URL || (typeof __BACKEND_URL__ !== 'undefined' ? __BACKEND_URL__ : '');
  try {
    const url = new URL(target, window.location.href);
    return url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch {
    return '5000';
  }
}

async function json(res) {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || body);
    } catch {
      /* body was not JSON */
    }
    throw new Error(detail);
  }
  return res.json();
}

export async function ping(signal) {
  return json(await fetch(`${API}/ping`, { signal }));
}

export async function verify(body) {
  return json(
    await fetch(`${API}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** POST to the SSE endpoint and invoke onEvent for every `data:` frame. */
export async function streamOptimize(body, onEvent, signal) {
  const res = await fetch(`${API}/optimize/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    await json(res);
    throw new Error('Streaming not supported by this browser');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}
