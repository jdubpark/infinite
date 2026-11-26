import { randomUUID } from "node:crypto";

export type ClientConfig = { origin: string; token: string; projectId?: string };

export const DEFAULT_API_TIMEOUT_MS = 15000;
const MAX_API_TIMEOUT_MS = 2_147_483_647;

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export type ClientApi = {
  request(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<Response>;
  json<T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string, timeoutMs?: number): Promise<T>;
};

export function createClientApi(config: ClientConfig, clientId = randomUUID()): ClientApi {
  const request = async (path: string, body?: unknown, signal?: AbortSignal, headers: Record<string, string> = {}, method?: string) => {
    const response = await fetch(config.origin + "/api" + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "X-Infinite-Client": clientId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body as unknown as BodyInit : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { code?: unknown };
      const code = typeof detail.code === "string" && /^[a-z0-9-]{1,80}$/.test(detail.code) ? detail.code : undefined;
      const guidance = code === "stale-enrollment-revision" ? "The repository enrollment changed; refresh its status and submit a new request ID." :
        response.status === 401 ? "Pair a current device key." : response.status === 403 ? "This device is not permitted to perform that action." : "Inspect the current state before retrying a mutation.";
      throw new HttpError(response.status, `Host returned HTTP ${response.status}${code ? ` (${code})` : ""}. ${guidance}`, code);
    }
    return response;
  };
  const json = async <T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
    method?: string,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
  ): Promise<T> => {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_API_TIMEOUT_MS) {
      throw new RangeError(`Request timeout must be an integer between 1 and ${MAX_API_TIMEOUT_MS} milliseconds.`);
    }
    const effectiveSignal = signal?.aborted
      ? signal
      : signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
    return (await request(path, body, effectiveSignal, headers, method)).json() as Promise<T>;
  };
  return { request, json };
}
