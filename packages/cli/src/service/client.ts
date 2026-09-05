import { PROTOCOL_HEADER, PROTOCOL_VERSION, type ErrorCode } from '@pdf-testkit/protocol';

/** Network failure, 5xx, or 429 exhausted: the service's problem (PROTOCOL.md §8). */
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

/** A 4xx with a protocol error code: the customer's configuration, always actionable. */
export class ServiceClientError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode | 'unknown',
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceClientError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  userAgent: string;
  /** Backoff between attempts; length + 1 = total attempts. Default 1 s / 2 s / 4 s. */
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ServiceClient {
  private readonly delays: number[];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.delays = opts.retryDelaysMs ?? [1000, 2000];
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** PUT raw bytes to a presigned URL with exactly the headers the service gave. */
  async putObject(url: string, headers: Record<string, string>, body: Uint8Array): Promise<void> {
    await this.withRetries(`PUT ${new URL(url).pathname}`, async () => {
      const res = await this.fetchImpl(url, { method: 'PUT', headers: { ...headers, 'content-length': String(body.length) }, body });
      if (res.status >= 500 || res.status === 429) return { retry: true, status: res.status, retryAfter: retryAfter(res) };
      if (!res.ok) throw new ServiceClientError(res.status, 'unknown', `upload rejected with HTTP ${res.status}`);
      return { retry: false, value: undefined };
    });
  }

  /** Fetch an artifact the service pointed at (a presigned GET). */
  async getObject(url: string): Promise<Uint8Array> {
    return this.withRetries(`GET ${new URL(url).pathname}`, async () => {
      const res = await this.fetchImpl(url);
      if (res.status >= 500 || res.status === 429) return { retry: true, status: res.status, retryAfter: retryAfter(res) };
      if (!res.ok) throw new ServiceClientError(res.status, 'unknown', `artifact fetch failed with HTTP ${res.status}`);
      return { retry: false, value: new Uint8Array(await res.arrayBuffer()) };
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.withRetries(`${method} ${path}`, async () => {
      const res = await this.fetchImpl(this.opts.baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
          'user-agent': this.opts.userAgent,
          ...(body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status >= 500 || res.status === 429) return { retry: true, status: res.status, retryAfter: retryAfter(res) };
      const json = (await res.json().catch(() => null)) as { error?: string; code?: ErrorCode; details?: Record<string, unknown> } | null;
      if (!res.ok) {
        throw new ServiceClientError(res.status, json?.code ?? 'unknown', json?.error ?? `HTTP ${res.status}`, json?.details);
      }
      return { retry: false, value: json as T };
    });
  }

  private async withRetries<T>(
    label: string,
    attempt: () => Promise<{ retry: true; status: number; retryAfter: number | null } | { retry: false; value: T }>,
  ): Promise<T> {
    let last = '';
    for (let i = 0; ; i++) {
      try {
        const r = await attempt();
        if (!r.retry) return r.value;
        last = `HTTP ${r.status}`;
        if (i >= this.delays.length) break;
        await sleep(r.retryAfter ?? this.delays[i]!);
      } catch (err) {
        if (err instanceof ServiceClientError) throw err;
        last = (err as Error).message;
        if (i >= this.delays.length) break;
        await sleep(this.delays[i]!);
      }
    }
    throw new ServiceUnavailableError(`${label}: ${last} after ${this.delays.length + 1} attempts`);
  }
}

function retryAfter(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  return Number.isFinite(s) ? s * 1000 : null;
}
