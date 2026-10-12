/**
 * Prometheus-compatible HTTP API client for fleet Monitoring.
 *
 * Instant query + query_range with a short TTL cache so dashboards
 * do not re-hit the metrics backend on every UI poll.
 *
 * Join key on series: `grid_unit_id` = infrastructure unit id (any provider).
 */

import { config } from '../../config';

export type PromMetric = Record<string, string>;

export interface PromSample {
  metric: PromMetric;
  /** Instant vector: [unixSeconds, valueString] */
  value?: [number, string];
  /** Range vector: [[unixSeconds, valueString], ...] */
  values?: Array<[number, string]>;
}

interface PromApiResponse {
  status: string;
  data?: {
    resultType?: string;
    result?: PromSample[];
  };
  error?: string;
  errorType?: string;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

/** True when a metrics backend URL is configured. */
export function isPrometheusConfigured(): boolean {
  return Boolean(config.prometheus.url?.trim());
}

export function clearPrometheusCache(): void {
  cache.clear();
}

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const bearer = config.prometheus.bearerToken?.trim();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
    return headers;
  }
  const user = config.prometheus.basicUser?.trim();
  const pass = config.prometheus.basicPassword ?? '';
  if (user) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return headers;
}

async function promFetch(path: string, params: Record<string, string>): Promise<PromApiResponse> {
  const base = config.prometheus.url.replace(/\/+$/, '');
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.prometheus.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: authHeaders(),
      signal: controller.signal,
    });
    const body = (await res.json()) as PromApiResponse;
    if (!res.ok) {
      throw new Error(body.error || `Prometheus HTTP ${res.status} for ${path}`);
    }
    if (body.status !== 'success') {
      throw new Error(body.error || `Prometheus query failed (${body.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Instant query. */
export async function promQuery(query: string): Promise<PromSample[]> {
  const cacheKey = `q:${query}`;
  const cached = cacheGet<PromSample[]>(cacheKey);
  if (cached) return cached;

  const body = await promFetch('/api/v1/query', { query });
  const result = body.data?.result ?? [];
  cacheSet(cacheKey, result, config.prometheus.cacheTtlMs);
  return result;
}

/** Range query. */
export async function promQueryRange(input: {
  query: string;
  start: number;
  end: number;
  step: string;
}): Promise<PromSample[]> {
  const cacheKey = `qr:${input.query}:${input.start}:${input.end}:${input.step}`;
  const cached = cacheGet<PromSample[]>(cacheKey);
  if (cached) return cached;

  const body = await promFetch('/api/v1/query_range', {
    query: input.query,
    start: String(input.start),
    end: String(input.end),
    step: input.step,
  });
  const result = body.data?.result ?? [];
  cacheSet(cacheKey, result, config.prometheus.cacheTtlMs);
  return result;
}

/**
 * Fleet reachability from `up`, grouped by unit id.
 * Returns map of infrastructure id → up value (1 = up, 0 = down).
 */
export async function fetchUnitUpById(): Promise<Map<string, number>> {
  const query = 'max by (grid_unit_id) (up{grid_unit_id!=""})';
  const samples = await promQuery(query);
  const map = new Map<string, number>();
  for (const s of samples) {
    const id = s.metric?.grid_unit_id?.trim();
    if (!id || !s.value) continue;
    const n = Number(s.value[1]);
    if (Number.isFinite(n)) map.set(id, n);
  }
  return map;
}
