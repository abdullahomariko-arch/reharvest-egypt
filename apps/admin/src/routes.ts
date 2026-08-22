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

import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { lots, orders, payments, parties, auditLog, orderTermVersions } from '@reharvest/db/schema';
import { ServiceError, type LotService } from '../../api/src/service/lot-order-service.ts';
import { verifyAuditChain } from '../../api/src/repo/payment-postgres.ts';
import { allocatePayment, approvePayout } from '../../api/src/repo/allocation.ts';
import type { Principal } from '../../api/src/auth.ts';
import {
  createSessionStore,
  checkCsrf,
  CSRF_FIELD,
  type SessionStore,
  type StaffSession,
} from '../../api/src/session.ts';
import { layout, instrument, table, empty, pill, blockCard, esc, egpStr, kgStr, ago } from './layout.ts';

type Db = PostgresJsDatabase<Record<string, never>>;

export interface OpsDeps {
  readonly db: Db;
  readonly lots: LotService;
  /** Bearer authentication, still accepted for scripted access and tests. */
  readonly authenticate: (req: Request) => Promise<Principal | null>;
  readonly sessions: SessionStore;
  /** Verifies a staff sign-in. Returns the user, or null. */
  readonly verifyStaffLogin: (
    identifier: string,
    secret: string,
  ) => Promise<{ userId: string; displayName: string; partyId: string; roles: readonly string[] } | null>;
  readonly concentrationCeilingPct: number;
}

const SELLABLE = ['AVAILABLE', 'PARTIALLY_RESERVED'] as const;

/** Context variables the console's middleware chain sets. */
type Vars = {
  principal: Principal;
  session: StaffSession;
  parsedForm: Record<string, unknown>;
};

export function buildOpsConsole(deps: OpsDeps) {
  const app = new Hono<{ Variables: Vars }>();
  const { db } = deps;

  /* ---------------- auth ---------------- */

  /*
    The guard must not cover the sign-in endpoints, or the login POST is itself
    redirected to the login form and nobody can ever authenticate. Registered
    with an explicit exemption rather than by relying on route ordering, which
    is easy to break with an innocent-looking reshuffle.
  */
  const PUBLIC_PATHS = new Set(['/ops/login', '/ops/logout']);

  const guardUnlessPublic = async (c: Context<{ Variables: Vars }>, next: () => Promise<void>) => {
    if (PUBLIC_PATHS.has(new URL(c.req.url).pathname)) return next();
    return guard(c, next);
  };

  app.use('/ops', guardUnlessPublic);
  app.use('/ops/*', guardUnlessPublic);

  /* ---------------- sign in / out ---------------- */

  app.get('/ops/login', async (c) => c.html(loginPage(c.req.query('error'))));

  app.post('/ops/login', async (c) => {
    const form = await c.req.parseBody();
    const user = await deps.verifyStaffLogin(String(form.identifier ?? ''), String(form.secret ?? ''));

    if (!user) {
      // One message for a wrong identifier and a wrong secret. Distinguishing
      // them tells an attacker which staff accounts exist.
      return c.redirect('/ops/login?error=1');
    }

    const { cookie } = await deps.sessions.create(user);
    c.header('Set-Cookie', cookie);
    return c.redirect('/ops');
  });

  app.post('/ops/logout', async (c) => {
    const session = await deps.sessions.read(c.req.header('cookie') ?? null);

    /*
      Logout is outside the guard, so it does its own CSRF check.

      Forced logout is a minor nuisance rather than a theft, but it is still an
      action taken on someone's behalf without their intent — and an endpoint
      that skips the check because the damage seems small is the one that gets
      copied next time.
    */
    if (session) {
      const form = await c.req.parseBody();
      if (!checkCsrf(session, form[CSRF_FIELD])) return c.html(csrfFailedPage(), 403);
    }
    // Revoked server-side, not merely cleared client-side: a cookie copied
    // before logout must stop working too.
    if (session) await deps.sessions.revoke(session.id);
    c.header('Set-Cookie', deps.sessions.clearedCookie());
    return c.redirect('/ops/login');
  });

  async function guard(c: any, next: () => Promise<void>) {
    // A browser session first; bearer tokens remain for scripts and tests.
    const session = await deps.sessions.read(c.req.header('cookie') ?? null);

    if (session) {
      c.set('session', session);
      c.set('principal', {
        userId: session.userId,
        partyId: session.partyId,
        roles: session.roles,
        displayName: session.displayName,
      } satisfies Principal);
    } else {
      const p = await deps.authenticate(c.req.raw);
      if (!p) {
        // A browser gets the login form; a script gets a 401 it can act on.
        const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
        return wantsHtml ? c.redirect('/ops/login') : c.json({ error: 'unauthenticated' }, 401);
      }
      c.set('principal', p);
    }

    const p = c.get('principal') as Principal;
    // The console is for staff. A supplier with a valid token must not be able
    // to read the whole book by guessing the URL.
    if (!p.roles.some((r) => ['ops_agent', 'ops_manager', 'finance', 'executive'].includes(r))) {
      return c.html(forbiddenPage(p), 403);
    }

    /*
      CSRF on every state-changing request.

      SameSite=Strict already blocks the classic cross-site POST, but SameSite is
      enforced by the browser, and the browsers in a packhouse office are not
      something this system controls. Two independent mechanisms, either
      sufficient on its own.

      Bearer-authenticated callers are exempt: a token is not attached
      automatically by a browser, so there is nothing to forge.
    */
    if (c.req.method === 'POST') {
      const session = c.get('session');
      if (session) {
        const form = await c.req.parseBody();
        if (!checkCsrf(session, form[CSRF_FIELD])) {
          return c.html(csrfFailedPage(), 403);
        }
        // Cache the parsed body so the handler does not re-read a consumed stream.
        c.set('parsedForm', form);
      }
    }

    await next();
  }

  const who = (c: Context<{ Variables: Vars }>): Principal => c.get('principal');

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
    const session = c.get('session');
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
                ${csrfInput(session)}
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
    const session = c.get('session');
    const cts = await counts();
    const rows = await db
      .select()
      .from(payments)
      // RECONCILED money is attached to an order and is not in this queue.
      // Showing it here would invite a second allocation the service refuses.
      .where(inArray(payments.state, ['UNMATCHED', 'RECEIVED'] as never))
      .orderBy(desc(payments.createdAt))
      .limit(100);

    const flash = flashFor(c);

    const body = `
      ${flash}
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
                      ${csrfInput(session)}
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
    const session = c.get('session');
    const cts = await counts();
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.direction, 'outbound'))
      .orderBy(desc(payments.createdAt))
      .limit(50);

    const flash = flashFor(c);

    const body = `
      ${flash}
      <div class="note">
        A payout needs two different people: one to prepare it, another to approve it.
        The database refuses a row where those are the same person, so this is not merely a screen rule.
        A beneficiary whose bank details changed in the last 24 hours cannot be paid at all.
      </div>
      ${
        rows.length
          ? table(
              ['Settlement', 'Amount', 'State', 'Prepared by', 'Approved by', 'Created', ''],
              rows.map(
                (p) => `<tr>
                  <td class="mono">${esc(p.idempotencyKey)}</td>
                  <td class="num">${egpStr(p.amountPiastres)} EGP</td>
                  <td>${stateP(p.state)}</td>
                  <td class="mono">${esc(p.preparedBy.slice(0, 8))}</td>
                  <td class="mono">${p.approvedBy ? esc(p.approvedBy.slice(0, 8)) : pill('awaiting', 'warn')}</td>
                  <td class="mono">${esc(ago(p.createdAt))}</td>
                  <td>${
                    p.state === 'PENDING_APPROVAL'
                      ? `<form class="inline" method="post" action="/ops/payouts/${esc(p.id)}/approve">
                           ${csrfInput(session)}
                           <button class="btn primary" type="submit">Approve</button>
                         </form>`
                      : ''
                  }</td>
                </tr>`,
              ),
            )
          : empty('No payouts', 'Supplier settlements appear here once orders complete.')
      }
    `;

    return c.html(layout({ title: 'Payouts', active: 'payouts', counts: cts, body }));
  });

  /**
   * Allocate an unattributed payment to an order. This is the human resolution
   * of the case the webhook could not resolve, so it carries the same rules and
   * writes the same audit entry.
   */
  app.post('/ops/payments/:id/allocate', async (c) => {
    const p = who(c);
    // Reuse the body the CSRF check already parsed; the stream is consumed.
    const form = c.get('parsedForm') ?? (await c.req.parseBody());
    const orderCode = String(form.orderCode ?? '');

    try {
      const r = await allocatePayment(deps.db, {
        paymentId: c.req.param('id'),
        orderCode,
        actor: p,
        at: new Date().toISOString(),
      });
      const msg = r.orderAdvanced
        ? `Allocated ${egpStr(r.amountPiastres)} EGP to ${r.orderCode}. That brings the total to ${egpStr(r.totalReconciledPiastres)} EGP, the deposit is covered and the order has moved.`
        : `Allocated ${egpStr(r.amountPiastres)} EGP to ${r.orderCode}. Reconciled so far: ${egpStr(r.totalReconciledPiastres)} of ${egpStr(r.depositDuePiastres)} EGP. This money is now attached to the order and cannot be moved elsewhere.`;
      return c.redirect(`/ops/payments?done=${encodeURIComponent(msg)}`);
    } catch (e) {
      return c.redirect(`/ops/payments?blocked=${encodeURIComponent(serialiseBlock(e))}`);
    }
  });

  /** Approve an outbound payout. Refuses self-approval in words, not in SQL errors. */
  app.post('/ops/payouts/:id/approve', async (c) => {
    const p = who(c);
    try {
      const r = await approvePayout(deps.db, {
        paymentId: c.req.param('id'),
        actor: p,
        at: new Date().toISOString(),
      });
      return c.redirect(
        `/ops/payouts?done=${encodeURIComponent(`Approved ${egpStr(r.amountPiastres)} EGP for release.`)}`,
      );
    } catch (e) {
      return c.redirect(`/ops/payouts?blocked=${encodeURIComponent(serialiseBlock(e))}`);
    }
  });

  return app;
}

/* ------------------------------------------------------------------ */

/** Turns a service refusal into the payload the block card renders. */
function serialiseBlock(e: unknown): string {
  if (e instanceof ServiceError) {
    return JSON.stringify({
      message: e.message,
      correction: e.correctionPath,
      domainId: e.domainId,
      reasonCode: e.reasonCode,
    });
  }
  // An unexpected failure still has to say something useful to a finance clerk
  // standing in front of the screen, rather than a stack trace.
  return JSON.stringify({
    message: 'That did not go through.',
    correction: 'Nothing was changed. Try again, and if it keeps failing send this screen to engineering.',
    domainId: 'D51',
    reasonCode: 'UNEXPECTED_FAILURE',
  });
}

function flashFor(c: any): string {
  const done = c.req.query('done');
  const blocked = c.req.query('blocked');
  let out = '';
  if (done) out += `<div class="good">${esc(done)}</div>`;
  if (blocked) {
    try {
      out += blockCard(JSON.parse(blocked));
    } catch {
      /* a malformed query string is not worth an error page */
    }
  }
  return out;
}

/**
 * The hidden CSRF field. Every form in this console includes it; a form without
 * one is refused, which is deliberate — the failure is visible rather than a
 * quietly unprotected endpoint.
 */
function csrfInput(session: StaffSession | undefined): string {
  return session ? `<input type="hidden" name="${CSRF_FIELD}" value="${esc(session.csrfToken)}">` : '';
}

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

/**
 * The login form.
 *
 * No "forgot password", no self-service reset, no account creation. This is a
 * closed staff console; adding an account is an administrative act, and a reset
 * flow is an attack surface guarding nothing but a handful of internal users.
 */
function loginPage(error?: string): string {
  return layout({
    title: 'Sign in',
    active: '',
    body: `
      ${error ? `<div class="block"><b>Those details were not recognised.</b><p>Check the identifier and passphrase and try again.</p></div>` : ''}
      <div class="card" style="padding:22px;max-width:420px">
        <form method="post" action="/ops/login">
          <label class="lb" for="identifier">Staff identifier</label>
          <input type="text" id="identifier" name="identifier" required autocomplete="username"
                 style="width:100%;margin-bottom:14px">
          <label class="lb" for="secret">Passphrase</label>
          <input type="password" id="secret" name="secret" required autocomplete="current-password"
                 style="width:100%;margin-bottom:18px">
          <button class="btn primary" type="submit" style="width:100%">Sign in</button>
        </form>
      </div>
      <p class="lede" style="margin-top:16px;max-width:420px">
        Sessions last 8 hours and end after 45 minutes idle. Sign out when you leave a shared machine —
        this console can move money.
      </p>`,
  });
}

/**
 * Shown when a form arrives without a valid CSRF token.
 *
 * Says plainly what happened rather than a bare 403, because the most common
 * cause is innocent — a form left open past its session — and the person needs
 * to know their action did not go through.
 */
function csrfFailedPage(): string {
  return layout({
    title: 'Request refused',
    active: '',
    body: `<div class="block">
      <b>That request could not be verified.</b>
      <p>Nothing was changed. This usually means the page was left open until the session expired.
         Sign in again and repeat the action. If you did not submit anything, someone may have tried
         to submit it on your behalf — tell whoever runs this system.</p>
      <code>D01 · CSRF_TOKEN_INVALID</code>
    </div>
    <a class="btn" href="/ops">Back to the console</a>`,
  });
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
