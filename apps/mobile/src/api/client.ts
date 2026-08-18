/**
 * API client.
 *
 * Written around the assumption that the network is bad, because it is: this app
 * runs in packhouses on the Delta agricultural roads where a 3G bar comes and
 * goes. Three consequences shape the whole file:
 *
 * 1. **Every mutation carries an idempotency key.** The key is supplied by the
 *    caller and derived from the thing being done, never from the clock, so a
 *    retry after a timeout is recognised as the same request rather than a
 *    second lot or a second payment.
 *
 * 2. **A 422 is not an error.** It is the server refusing on a business rule,
 *    and it carries the bilingual message and correction path the UI renders in
 *    a BlockCard. Throwing it as a generic failure would lose that.
 *
 * 3. **A timeout is not a failure either.** The request may well have succeeded
 *    with the response lost on the way back. Mutations that time out go to a
 *    queue and are replayed with the same key rather than reported as failed.
 */

import Constants from 'expo-constants';

export interface ApiBlock {
  readonly error: 'blocked';
  readonly domainId: string;
  readonly reasonCode: string;
  readonly messageEn: string;
  readonly messageAr: string;
  readonly correctionPath: string;
}

export class BlockedByRule extends Error {
  constructor(readonly block: ApiBlock) {
    super(`${block.domainId}/${block.reasonCode}: ${block.messageEn}`);
    this.name = 'BlockedByRule';
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when retrying with the same idempotency key is safe and sensible. */
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE: string = (Constants.expoConfig?.extra?.apiBaseUrl as string) ?? 'http://localhost:8787';

/** Slow enough for a bad connection, short enough that nobody stares at a spinner. */
const TIMEOUT_MS = 12_000;

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly body?: unknown;
  readonly token: string;
  /** Required for every non-GET. Derived from the subject, never from Date.now(). */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions): Promise<T> {
  const method = opts.method ?? 'GET';

  if (method !== 'GET' && !opts.idempotencyKey) {
    // A programming error, caught loudly in development rather than becoming a
    // duplicate payment in production.
    throw new Error(`${method} ${path} is missing an idempotency key`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
        ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    clearTimeout(timer);
    // Could not reach the server, or gave up waiting. The write may still have
    // landed, so this is explicitly retriable rather than failed.
    throw new ApiError((e as Error).message || 'network unreachable', 0, true);
  }
  clearTimeout(timer);

  if (res.status === 422) {
    throw new BlockedByRule((await res.json()) as ApiBlock);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(text || res.statusText, res.status, res.status >= 500 || res.status === 429);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ *
 * Wire types.
 *
 * Money and weight cross the wire as **strings of integer minor units**,
 * not numbers. JSON numbers are IEEE doubles, and 8,800.00 EGP surviving a
 * round trip is luck rather than design. The client parses them back into
 * bigint at the edge and never holds a float.
 * ------------------------------------------------------------------ */

export interface WireLot {
  readonly lotId: string;
  readonly crop: 'tomato' | 'potato' | 'onion' | 'pepper' | 'orange';
  readonly grade: 'A' | 'B' | 'C';
  /** Integer grams, as a decimal string. */
  readonly netGrams: string;
  readonly availableGrams: string;
  readonly containerCount: number;
  /** Integer piastres, as a decimal string. */
  readonly pricePerKgPiastres: string;
  readonly status: string;
  readonly originName: string;
  readonly distanceKm: number;
  readonly inspectedAt: string | null;
  readonly collectBy: string;
  readonly listedAt: string;
  readonly buyerCount: number;
  readonly brix?: string;
}

export interface WireOrder {
  readonly orderCode: string;
  readonly lotId: string;
  readonly state: string;
  readonly quantityGrams: string;
  readonly totalPiastres: string;
  readonly depositPiastres: string;
  readonly depositPaidPiastres: string;
  readonly createdAt: string;
}

export const api = {
  listLots: (token: string, params?: { mine?: boolean }) =>
    request<{ lots: WireLot[] }>(`/lots${params?.mine ? '?mine=true' : ''}`, { token }),

  getLot: (token: string, lotId: string) => request<WireLot>(`/lots/${lotId}`, { token }),

  createLot: (
    token: string,
    idempotencyKey: string,
    body: {
      crop: string;
      grossGrams: string;
      containerCount: number;
      packagingSpecId: string;
      packagingSpecVersion: number;
      pricePerKgPiastres: string;
      collectBy: string;
    },
  ) => request<WireLot>('/lots', { token, method: 'POST', body, idempotencyKey }),

  recordWeighing: (
    token: string,
    idempotencyKey: string,
    lotId: string,
    body: { grossGrams: string; containerCount: number; scaleId: string; photoEvidenceId?: string },
  ) => request<WireLot>(`/lots/${lotId}/weighings`, { token, method: 'POST', body, idempotencyKey }),

  recordInspection: (
    token: string,
    idempotencyKey: string,
    lotId: string,
    body: { checks: Record<string, boolean>; freeze: boolean },
  ) => request<WireLot>(`/lots/${lotId}/inspections`, { token, method: 'POST', body, idempotencyKey }),

  createOrder: (
    token: string,
    idempotencyKey: string,
    body: { lotId: string; quantityGrams: string },
  ) => request<WireOrder>('/orders', { token, method: 'POST', body, idempotencyKey }),

  getOrder: (token: string, orderCode: string) => request<WireOrder>(`/orders/${orderCode}`, { token }),

  createDepositIntention: (token: string, orderCode: string, idempotencyKey: string) =>
    request<{ clientSecret: string; publicKey: string; amountPiastres: string; methods: string[] }>(
      `/orders/${orderCode}/deposit-intention`,
      { token, method: 'POST', body: {}, idempotencyKey },
    ),
};

/* ------------------------------------------------------------------ *
 * Offline queue.
 *
 * A mutation that times out is parked here rather than reported as failed,
 * and replayed with its original key when the app next has a connection.
 * The server deduplicates on that key, so a replay of a request that did
 * land is a no-op returning the original response.
 * ------------------------------------------------------------------ */

export interface QueuedMutation {
  readonly id: string;
  readonly path: string;
  readonly method: 'POST' | 'PATCH';
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly queuedAt: string;
  readonly attempts: number;
}

export function createOfflineQueue(storage: {
  read(): Promise<QueuedMutation[]>;
  write(items: QueuedMutation[]): Promise<void>;
}) {
  return {
    async enqueue(m: Omit<QueuedMutation, 'attempts'>): Promise<void> {
      const items = await storage.read();
      // Same key already queued means this is a retry of something parked,
      // not a new action. Never let it become two rows.
      if (items.some((i) => i.idempotencyKey === m.idempotencyKey)) return;
      await storage.write([...items, { ...m, attempts: 0 }]);
    },

    async flush(token: string): Promise<{ sent: number; blocked: QueuedMutation[]; remaining: number }> {
      const items = await storage.read();
      const keep: QueuedMutation[] = [];
      const blocked: QueuedMutation[] = [];
      let sent = 0;

      for (const item of items) {
        try {
          await request(item.path, {
            method: item.method,
            body: item.body,
            token,
            idempotencyKey: item.idempotencyKey,
          });
          sent += 1;
        } catch (e) {
          if (e instanceof BlockedByRule) {
            // The server refused on a rule. Retrying will refuse identically,
            // so surface it to the person instead of looping forever.
            blocked.push(item);
          } else if (e instanceof ApiError && e.retriable) {
            keep.push({ ...item, attempts: item.attempts + 1 });
          } else {
            blocked.push(item);
          }
        }
      }

      await storage.write(keep);
      return { sent, blocked, remaining: keep.length };
    },
  };
}
