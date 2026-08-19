/**
 * Ops console routes.
 *
 * Every page reads from the same repositories the API uses, and every action is
 * a POST that goes through the same services. There is no admin back door: an
 * ops manager quarantining a lot travels the identical code path as an inspector
 * doing it from the phone, and gets refused by the identical rules.
 *
 * That is the point of an internal console. The tempting shortcut — "just update
 * the row, we're admins" — is how a platform ends up with lots in states its own
 * state machine says are impossible.
 */

import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { lots, orders, payments, parties, auditLog, orderTermVersions } from '@reharvest/db/schema';
import { ServiceError, type LotService } from '../../api/src/service/lot-order-service.ts';
import { verifyAuditChain } from '../../api/src/repo/payment-postgres.ts';
import type { Principal } from '../../api/src/auth.ts';
import { layout, instrument, table, empty, pill, blockCard, esc, egpStr, kgStr, ago } from './layout.ts';

type Db = PostgresJsDatabase<Record<string, never>>;

export interface OpsDeps {
  readonly db: Db;
  readonly lots: LotService;
  readonly authenticate: (req: Request) => Promise<Principal | null>;
  readonly concentrationCeilingPct: number;
}

const SELLABLE = ['AVAILABLE', 'PARTIALLY_RESERVED'] as const;

export function buildOpsConsole(deps: OpsDeps) {
  const app = new Hono();
  const { db } = deps;

  /* ---------------- auth ---------------- */

  app.use('/ops', guard);
  app.use('/ops/*', guard);

  async function guard(c: any, next: () => Promise<void>) {
    const p = await deps.authenticate(c.req.raw);
    if (!p) {
      return c.html(signInPage(), 401);
    }
    // The console is for staff. A supplier with a valid token must not be able
    // to read the whole book by guessing the URL.
    if (!p.roles.some((r) => ['ops_agent', 'ops_manager', 'finance', 'executive'].includes(r))) {
      return c.html(forbiddenPage(p), 403);
    }
    c.set('principal', p);
    await next();
  }

  const who = (c: any): Principal => c.get('principal');

  /** Sidebar badge counts, computed once per render. */
  async function counts() {
    const [alerts] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(lots)
      .where(inArray(lots.state, ['QUARANTINED', 'HELD'] as never));
    const [unmatched] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(eq(payments.state, 'UNMATCHED' as never));
    const [payouts] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(eq(payments.direction, 'outbound'), eq(payments.state, 'PENDING_APPROVAL' as never)));
    return { alerts: alerts?.n ?? 0, unmatched: unmatched?.n ?? 0, payouts: payouts?.n ?? 0 };
  }

  /* ---------------- dashboard ---------------- */

  app.get('/ops', async (c) => {
    const cts = await counts();

    const rows = await db.select().from(lots);
    const live = rows.filter((l) => (SELLABLE as readonly string[]).includes(l.state));

    // Open exposure is what we have committed to buy, valued at the ask.
    const exposure = live.reduce(
      (acc, l) => acc + (l.askPricePerKgPiastres * l.acceptedGrams) / 1000n,
      0n,
    );

    const reserved = live.reduce(
      (acc, l) => acc + (l.askPricePerKgPiastres * l.reservedGrams) / 1000n,
      0n,
    );

    /*
      Concentration is measured as a share of money at risk, never as a count of
      buyers. Five buyers where one is 80% of the book is not diversification,
      and a headline "5 active buyers" would hide exactly the risk that matters.
    */
    const byBuyer = await db
      .select({
        buyerId: orders.buyerId,
        piastres: sql<string>`coalesce(sum(${orderTermVersions.pricePerKgPiastres} * ${orderTermVersions.quantityGrams} / 1000), 0)::text`,
      })
      .from(orders)
      .innerJoin(orderTermVersions, eq(orderTermVersions.orderId, orders.id))
      /*
        Exposure-bearing states only. Interest and quotes are not demand — an
        order that has not cleared a deposit creates no procurement commitment,
        so counting it here would inflate concentration and hide real risk
        behind imaginary volume.
      */
      .where(
        inArray(orders.state, [
          'DEPOSIT_CLEARED', 'CONFIRMED', 'ALLOCATED', 'IN_FULFILMENT',
          'DELIVERED_PENDING_ACCEPTANCE', 'ACCEPTED', 'PARTIALLY_ACCEPTED',
        ] as never),
      )
      .groupBy(orders.buyerId);

    const total = byBuyer.reduce((a, b) => a + BigInt(b.piastres), 0n);
    const top = byBuyer.reduce((a, b) => (BigInt(b.piastres) > a ? BigInt(b.piastres) : a), 0n);
    const concPct = total > 0n ? Number((top * 100n) / total) : 0;
    const over = concPct >= deps.concentrationCeilingPct;
    const hot = concPct >= deps.concentrationCeilingPct * 0.8;

    const frozen = rows.filter((l) => l.state === 'QUARANTINED' || l.state === 'HELD');
    const closing = live.filter((l) => l.collectBy && l.collectBy.getTime() - Date.now() < 86_400_000);
    const unmatchedRows = await db
      .select()
      .from(payments)
      .where(eq(payments.state, 'UNMATCHED' as never))
      .limit(5);

    const alerts: string[] = [];
    for (const l of frozen) {
      alerts.push(
        alertRow('stop', `Lot frozen — ${l.state === 'QUARANTINED' ? 'failed inspection' : 'held'}`,
          `${l.lotCode} · ${kgStr(l.acceptedGrams)} kg · no override exists at any level`,
          `/ops/lots/${l.id}`),
      );
    }
    for (const p of unmatchedRows) {
      alerts.push(
        alertRow('warn', `Unallocated payment of ${egpStr(p.amountPiastres)} EGP`,
          `Provider reference ${p.providerTransactionId ?? '—'} · finance must allocate it`,
          '/ops/payments'),
      );
    }
    for (const l of closing) {
      alerts.push(
        alertRow('info', 'Collection window closes today',
          `${l.lotCode} · ${kgStr(l.acceptedGrams - l.reservedGrams)} kg still unsold`,
          `/ops/lots/${l.id}`),
      );
    }

    const body = `
      <div class="grid">
        ${instrument({ caption: 'Open buying commitment', value: egpStr(exposure), unit: 'EGP', sub: `${live.length} lots on the market` })}
        ${instrument({ caption: 'Reserved against orders', value: egpStr(reserved), unit: 'EGP', sub: 'Committed to buyers' })}
        ${instrument({
          caption: 'Largest buyer concentration',
          value: `${concPct}%`,
          tone: over ? 'bad' : hot ? 'warn' : 'ok',
          meter: { pct: concPct, ceilingPct: deps.concentrationCeilingPct },
          sub: `Ceiling ${deps.concentrationCeilingPct}%. Above it, one default really hurts.`,
        })}
      </div>

      <h2>Needs a decision today</h2>
      ${alerts.length ? alerts.join('') : empty('Nothing outstanding', 'Every approval and alert is cleared.')}
    `;

    return c.html(layout({ title: 'Today', active: 'dash', counts: cts, body }));
  });

  /* ---------------- lots ---------------- */

  app.get('/ops/lots', async (c) => {
    const cts = await counts();
    const rows = await db.select().from(lots).orderBy(desc(lots.createdAt)).limit(100);
    const partyRows = await db.select().from(parties);
    const nameOf = (id: string) => partyRows.find((p) => p.id === id)?.legalNameAr ?? id.slice(0, 8);

    const body = rows.length
      ? table(
          ['Lot', 'Supplier', 'State', 'Accepted', 'Available', 'Ask/kg', 'Listed', ''],
          rows.map((l) => {
            const avail = l.acceptedGrams - l.reservedGrams - l.heldGrams - l.rejectedGrams - l.disposedGrams;
            return `<tr>
              <td class="mono">${esc(l.lotCode)}</td>
              <td>${esc(nameOf(l.supplierId))}</td>
              <td>${stateP(l.state)}</td>
              <td class="num">${kgStr(l.acceptedGrams)} kg</td>
              <td class="num">${kgStr(avail)} kg</td>
              <td class="num">${egpStr(l.askPricePerKgPiastres)}</td>
              <td class="mono">${esc(ago(l.createdAt))}</td>
              <td><a class="btn" href="/ops/lots/${esc(l.id)}">Open</a></td>
            </tr>`;
          }),
        )
      : empty('No lots yet', 'Lots appear here as suppliers list them.');

    return c.html(layout({ title: 'Lots', active: 'lots', counts: cts, body }));
  });

  app.get('/ops/lots/:id', async (c) => {
    const cts = await counts();
    const [lot] = await db.select().from(lots).where(eq(lots.id, c.req.param('id'))).limit(1);
    if (!lot) return c.html(layout({ title: 'Lot not found', active: 'lots', counts: cts, body: empty('Not found', 'That lot does not exist.') }), 404);

    const [supplier] = await db.select().from(parties).where(eq(parties.id, lot.supplierId)).limit(1);
    const avail = lot.acceptedGrams - lot.reservedGrams - lot.heldGrams - lot.rejectedGrams - lot.disposedGrams;
    const blocked = c.req.query('blocked');
    const done = c.req.query('done');

    const frozen = lot.state === 'QUARANTINED' || lot.state === 'HELD';

    const body = `
      ${done ? `<div class="good">${esc(done)}</div>` : ''}
      ${blocked ? blockCard(JSON.parse(blocked)) : ''}

      <div class="grid">
        ${instrument({ caption: 'Accepted weight', value: kgStr(lot.acceptedGrams), unit: 'kg', sub: 'From a calibrated weighing' })}
        ${instrument({ caption: 'Available to promise', value: kgStr(avail), unit: 'kg', tone: avail <= 0n ? 'warn' : 'ok', sub: 'Accepted minus reserved, held, rejected' })}
        ${instrument({ caption: 'Value at ask', value: egpStr((lot.askPricePerKgPiastres * lot.acceptedGrams) / 1000n), unit: 'EGP' })}
      </div>

      <h2>Detail</h2>
      <div class="card"><table><tbody>
        ${kv('Lot code', `<span class="mono">${esc(lot.lotCode)}</span>`)}
        ${kv('Supplier', esc(supplier?.legalNameAr ?? lot.supplierId))}
        ${kv('Crop', esc(lot.crop))}
        ${kv('State', stateP(lot.state))}
        ${kv('Crates', String(lot.containerCount))}
        ${kv('Packaging spec', lot.packagingSpecId ? `${esc(lot.packagingSpecId)} v${lot.packagingSpecVersion}` : '<span class="pill warn">not pinned</span>')}
        ${kv('Collect by', lot.collectBy ? esc(lot.collectBy.toISOString().slice(0, 10)) : '—')}
        ${kv('Row version', `<span class="num">${lot.version}</span>`)}
      </tbody></table></div>

      <h2>Actions</h2>
      ${
        frozen
          ? `<div class="block"><b>This lot is frozen.</b>
              <p>Nothing from it can be sold or moved. No role in this console can release it — not ops, not finance, not an executive.
                 A qualified inspector must examine it in person and file a report.</p>
              <code>D31 · FOOD_SAFETY_HARD_STOP</code></div>`
          : `<div class="row">
              <form class="inline" method="post" action="/ops/lots/${esc(lot.id)}/quarantine">
                <button class="btn danger" type="submit">Quarantine this lot</button>
              </form>
              <span class="lede" style="margin:0">Quarantine is irreversible from this console, by design.</span>
             </div>`
      }
    `;

    return c.html(
      layout({
        title: lot.lotCode,
        active: 'lots',
        counts: cts,
        crumbs: [{ label: 'Lots', href: '/ops/lots' }, { label: lot.lotCode }],
        body,
      }),
    );
  });

  /**
   * Quarantine goes through the same LotService the inspector's phone calls.
   * If the state machine refuses, the console shows the refusal rather than
   * forcing the row.
   */
  app.post('/ops/lots/:id/quarantine', async (c) => {
    const p = who(c);
    const id = c.req.param('id');
    try {
      await deps.lots.recordInspection({
        lotId: id,
        checks: {},
        freeze: true,
        inspectorId: p.userId,
        actorRoles: p.roles,
        idempotencyKey: `ops-quarantine:${id}:${Date.now()}`,
      });
      return c.redirect(`/ops/lots/${id}?done=${encodeURIComponent('Lot quarantined. It is off the market immediately.')}`);
    } catch (e) {
      if (e instanceof ServiceError) {
        const payload = JSON.stringify({
          message: e.message,
          correction: e.correctionPath,
          domainId: e.domainId,
          reasonCode: e.reasonCode,
        });
        return c.redirect(`/ops/lots/${id}?blocked=${encodeURIComponent(payload)}`);
      }
      throw e;
    }
  });

  /* ---------------- orders ---------------- */

  app.get('/ops/orders', async (c) => {
    const cts = await counts();
    const rows = await db
      .select({
        code: orders.orderCode,
        state: orders.state,
        buyerId: orders.buyerId,
        createdAt: orders.createdAt,
        qty: orderTermVersions.quantityGrams,
        price: orderTermVersions.pricePerKgPiastres,
      })
      .from(orders)
      .leftJoin(orderTermVersions, eq(orderTermVersions.orderId, orders.id))
      .orderBy(desc(orders.createdAt))
      .limit(100);

    const partyRows = await db.select().from(parties);
    const nameOf = (id: string) => partyRows.find((p) => p.id === id)?.legalNameAr ?? id.slice(0, 8);

    const body = rows.length
      ? table(
          ['Order', 'Buyer', 'State', 'Quantity', 'Value', 'Deposit', 'Placed'],
          rows.map((o) => {
            const total = o.qty && o.price ? (o.price * o.qty) / 1000n : 0n;
            const dep = (total * 3000n + 5000n) / 10000n;
            return `<tr>
              <td class="mono">${esc(o.code)}</td>
              <td>${esc(nameOf(o.buyerId))}</td>
              <td>${stateP(o.state)}</td>
              <td class="num">${o.qty ? `${kgStr(o.qty)} kg` : '—'}</td>
              <td class="num">${egpStr(total)}</td>
              <td class="num">${egpStr(dep)}</td>
              <td class="mono">${esc(ago(o.createdAt))}</td>
            </tr>`;
          }),
        )
      : empty('No orders yet', 'Orders appear here once buyers reserve stock.');

    return c.html(layout({ title: 'Orders', active: 'orders', counts: cts, body }));
  });

  /* ---------------- unmatched money ---------------- */

  app.get('/ops/payments', async (c) => {
    const cts = await counts();
    const rows = await db
      .select()
      .from(payments)
      .where(inArray(payments.state, ['UNMATCHED', 'RECEIVED'] as never))
      .orderBy(desc(payments.createdAt))
      .limit(100);

    const body = `
      <div class="note">
        Money in this queue has cleared at the payment provider and is really in the merchant account.
        It has not been attributed to an order, so it must never be counted as a paid deposit.
        Nothing here advances an order until a person allocates it.
      </div>
      ${
        rows.length
          ? table(
              ['Provider reference', 'Amount', 'State', 'Method', 'Received', ''],
              rows.map(
                (p) => `<tr>
                  <td class="mono">${esc(p.providerTransactionId ?? '—')}</td>
                  <td class="num">${egpStr(p.amountPiastres)} EGP</td>
                  <td>${p.state === 'UNMATCHED' ? pill('unattributed', 'bad') : pill('short / unconfirmed', 'warn')}</td>
                  <td>${esc(p.method)}</td>
                  <td class="mono">${esc(ago(p.createdAt))}</td>
                  <td>
                    <form class="inline" method="post" action="/ops/payments/${esc(p.id)}/allocate">
                      <input type="text" name="orderCode" placeholder="ORD-…" required>
                      <button class="btn primary" type="submit">Allocate</button>
                    </form>
                  </td>
                </tr>`,
              ),
            )
          : empty('Nothing unallocated', 'Every payment received has been matched to an order.')
      }
    `;

    return c.html(layout({ title: 'Unmatched payments', active: 'payments', counts: cts, body }));
  });

  /* ---------------- audit ---------------- */

  app.get('/ops/audit', async (c) => {
    const cts = await counts();
    const integrity = await verifyAuditChain(db);
    const rows = await db.select().from(auditLog).orderBy(desc(auditLog.seq)).limit(80);

    const body = `
      ${
        integrity.ok
          ? `<div class="good"><b>Chain verified.</b> ${integrity.checked} entries, each hash following from the one before it.
              Any alteration to a historical entry would break every hash after it.</div>`
          : `<div class="block"><b>Audit chain is broken.</b>
              <p>The chain fails at sequence ${esc(integrity.brokenAtSeq)}. This means either a bug in how entries are
                 written, or someone with direct database access editing history. Both need a person now.</p>
              <code>D53 · AUDIT_CHAIN_BROKEN</code></div>`
      }
      ${
        rows.length
          ? table(
              ['Seq', 'When', 'Action', 'Subject', 'Decision', 'Reason', 'Hash'],
              rows.map(
                (r) => `<tr>
                  <td class="num">${r.seq.toString()}</td>
                  <td class="mono">${esc(r.at.toISOString().replace('T', ' ').slice(0, 19))}</td>
                  <td>${esc(r.action)}</td>
                  <td class="mono">${esc(r.subjectTable)} ${esc(r.subjectId.slice(0, 8))}</td>
                  <td>${r.decision === 'blocked' ? pill('blocked', 'bad') : pill('allowed', 'ok')}</td>
                  <td class="mono">${esc(r.reasonCode)}</td>
                  <td class="chain">${esc(r.hash.slice(0, 16))}…</td>
                </tr>`,
              ),
            )
          : empty('No audit entries yet', 'Entries appear as decisions are made.')
      }
    `;

    return c.html(layout({ title: 'Audit log', active: 'audit', counts: cts, body }));
  });

  /* ---------------- payouts ---------------- */

  app.get('/ops/payouts', async (c) => {
    const cts = await counts();
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.direction, 'outbound'))
      .orderBy(desc(payments.createdAt))
      .limit(50);

    const body = `
      <div class="note">
        A payout needs two different people: one to prepare it, another to approve it.
        The database refuses a row where those are the same person, so this is not merely a screen rule.
        A beneficiary whose bank details changed in the last 24 hours cannot be paid at all.
      </div>
      ${
        rows.length
          ? table(
              ['Settlement', 'Amount', 'State', 'Prepared by', 'Approved by', 'Created'],
              rows.map(
                (p) => `<tr>
                  <td class="mono">${esc(p.idempotencyKey)}</td>
                  <td class="num">${egpStr(p.amountPiastres)} EGP</td>
                  <td>${stateP(p.state)}</td>
                  <td class="mono">${esc(p.preparedBy.slice(0, 8))}</td>
                  <td class="mono">${p.approvedBy ? esc(p.approvedBy.slice(0, 8)) : pill('awaiting', 'warn')}</td>
                  <td class="mono">${esc(ago(p.createdAt))}</td>
                </tr>`,
              ),
            )
          : empty('No payouts', 'Supplier settlements appear here once orders complete.')
      }
    `;

    return c.html(layout({ title: 'Payouts', active: 'payouts', counts: cts, body }));
  });

  return app;
}

/* ------------------------------------------------------------------ */

function kv(k: string, v: string): string {
  return `<tr><td style="width:200px;color:var(--muted)">${esc(k)}</td><td>${v}</td></tr>`;
}

function alertRow(level: 'stop' | 'warn' | 'info', title: string, detail: string, href: string): string {
  const cls = level === 'stop' ? 'block' : level === 'warn' ? 'note' : 'card';
  const inner = `<b style="display:block;font-size:14.5px;font-weight:600">${esc(title)}</b>
    <span style="color:var(--muted);font-size:13.5px">${esc(detail)}</span>`;
  return level === 'info'
    ? `<div class="card" style="padding:13px 15px;margin:9px 0"><a href="${esc(href)}" style="color:inherit">${inner}</a></div>`
    : `<div class="${cls}"><a href="${esc(href)}" style="color:inherit;text-decoration:none">${inner}</a></div>`;
}

const TONES: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  AVAILABLE: 'ok', PARTIALLY_RESERVED: 'ok', FULLY_RESERVED: 'ok',
  DEPOSIT_CLEARED: 'ok', CONFIRMED: 'ok', CLEARED: 'ok', SETTLED: 'ok',
  ALLOCATED: 'ok', IN_FULFILMENT: 'ok', ACCEPTED: 'ok',
  INSPECTION_PENDING: 'warn', DEPOSIT_PENDING: 'warn', PENDING_APPROVAL: 'warn',
  RECEIVED: 'warn', QUOTED: 'warn', CONDITIONAL: 'warn',
  DELIVERED_PENDING_ACCEPTANCE: 'warn', PARTIALLY_ACCEPTED: 'warn',
  DECLARED: 'neutral', SOURCE_VERIFIED: 'neutral', INTEREST: 'neutral',
  QUARANTINED: 'bad', HELD: 'bad', DISPOSED: 'bad', EXPIRED: 'bad',
  CANCELLED: 'bad', FAILED: 'bad', REVERSED: 'bad', UNMATCHED: 'bad', DISPUTED: 'bad',
};

function stateP(state: string): string {
  return pill(state.toLowerCase().replace(/_/g, ' '), TONES[state] ?? 'neutral');
}

function signInPage(): string {
  return layout({
    title: 'Sign in required',
    active: '',
    body: `<div class="empty"><b>You need a staff token</b>
      This console reads live trading data, so it is not open. Send an
      <span class="mono">Authorization: Bearer &lt;token&gt;</span> header, or sign in through the app.</div>`,
  });
}

function forbiddenPage(p: Principal): string {
  return layout({
    title: 'Not your console',
    active: '',
    body: `<div class="block"><b>Your account cannot open the ops console.</b>
      <p>You are signed in as ${esc(p.displayName)} with roles: ${esc(p.roles.join(', ') || 'none')}.
         The console needs an ops, finance or executive role. Suppliers and buyers use the app instead.</p>
      <code>D01 · ROLE_NOT_PERMITTED</code></div>`,
  });
}
