// HTTP client for the Windy Word control server (127.0.0.1:18765).
//
// All MCP tools delegate to this module. It handles the only two failure modes
// that matter to agents:
//   1. Windy Word is not running                  → ECONNREFUSED
//   2. Windy Word returned 4xx/5xx with a body    → surface body verbatim
// Everything else is the agent's problem (passed-through errors include
// timeouts, JSON parse failures on malformed responses, etc.).

const DEFAULT_HOST = process.env.WINDY_WORD_MCP_HOST || '127.0.0.1';
const DEFAULT_PORT = parseInt(process.env.WINDY_WORD_MCP_PORT || '18765', 10);
const BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.WINDY_WORD_MCP_TIMEOUT_MS || '5000', 10);

const NOT_RUNNING_HINT =
  `Windy Word does not appear to be running at ${BASE_URL}. ` +
  `Start it ('npm run start' from the windy-pro repo, or launch the installed app), ` +
  `then retry. Override the host/port with WINDY_WORD_MCP_HOST / WINDY_WORD_MCP_PORT.`;

export class WindyWordClientError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message);
    this.name = 'WindyWordClientError';
    this.status = status;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

async function request(method, path, body, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    clearTimeout(timer);
    const code = err.cause?.code || err.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
      throw new WindyWordClientError(NOT_RUNNING_HINT, { cause: err });
    }
    if (err.name === 'AbortError') {
      throw new WindyWordClientError(
        `Windy Word request to ${path} timed out after ${timeoutMs}ms.`,
        { cause: err },
      );
    }
    throw err;
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    throw new WindyWordClientError(
      `Windy Word returned ${res.status} for ${method} ${path}: ${text || '(empty body)'}`,
      { status: res.status, body: text },
    );
  }
  // Endpoints may return JSON or plain text ("OK" for action triggers).
  // Try JSON first, fall back to the raw string.
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const apiGet = (path, opts) => request('GET', path, undefined, opts);
export const apiPost = (path, body, opts) => request('POST', path, body ?? {}, opts);

export function describeServer() {
  return { baseUrl: BASE_URL, timeoutMs: DEFAULT_TIMEOUT_MS };
}
