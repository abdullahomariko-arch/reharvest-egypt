/**
 * Ops console — layout and shared components.
 *
 * Server-rendered HTML, deliberately. This is an internal tool where every
 * number is server-authoritative and every action is a POST that the rules
 * engine either allows or refuses. A client-side app would mean re-implementing
 * the refusal logic in a second place and keeping two copies honest, which is
 * the exact failure this whole system exists to avoid.
 *
 * The design language is the mobile app's: quiet light chrome, and anything
 * that is a *measurement* shown on a dark instrument panel with phosphor-green
 * figures. Consistency here is not decoration — an ops agent and a packhouse
 * foreman discussing the same lot over the phone should be looking at the same
 * visual vocabulary.
 */

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

const CSS = `
:root{
  --bg:#EFEDE7; --surface:#FFF; --sunk:#F7F6F2; --line:#E2DFD6; --line2:#CFCBBE;
  --ink:#131714; --muted:#6E7369;
  --brand:#14684A; --brand-deep:#0D4A34; --brand-soft:#E0EDE6;
  --inst:#0C1411; --inst-rule:#223028; --inst-text:#8FA69A; --inst-val:#DDEAE3;
  --led:#63E39D; --led-dim:#2E5744; --led-red:#FF7261;
  --amber:#A96D14; --amber-soft:#F7EAD5;
  --danger:#AE3125; --danger-soft:#F8E2DE;
  --sans:'Alexandria',system-ui,-apple-system,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:var(--bg);color:var(--ink);font-weight:400;font-size:15px;line-height:1.55}
a{color:var(--brand-deep);text-decoration:none}
a:hover{text-decoration:underline}

.shell{display:flex;min-height:100vh}
.side{width:232px;flex:none;background:var(--surface);border-inline-end:1px solid var(--line);padding:20px 14px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:26px;padding:0 6px}
.mark{width:32px;height:32px;border-radius:9px;background:var(--brand);display:grid;place-items:center;flex:none}
.brand b{font-size:16px;font-weight:600;letter-spacing:-.01em}
.brand span{display:block;font-size:11.5px;color:var(--muted);font-weight:300}
.nav a{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-radius:9px;color:var(--muted);font-size:14px;font-weight:500;margin-bottom:2px}
.nav a:hover{background:var(--sunk);color:var(--ink);text-decoration:none}
.nav a.on{background:var(--brand);color:#fff}
.nav .count{font-family:var(--mono);font-size:12px;background:rgba(0,0,0,.08);padding:1px 7px;border-radius:99px}
.nav a.on .count{background:rgba(255,255,255,.22)}
.nav .sep{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:16px 12px 6px;font-weight:600}

.main{flex:1;min-width:0;padding:26px 30px 60px;max-width:1180px}
.crumbs{font-size:13px;color:var(--muted);margin-bottom:6px}
h1{font-size:24px;font-weight:600;letter-spacing:-.02em;margin-bottom:4px}
.lede{color:var(--muted);font-size:14.5px;font-weight:300;margin-bottom:22px;max-width:70ch}
h2{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:26px 0 10px}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.inst{background:var(--inst);border-radius:16px;padding:18px;position:relative;overflow:hidden}
.inst::after{content:'';position:absolute;inset:0;pointer-events:none;opacity:.45;background:repeating-linear-gradient(180deg,rgba(255,255,255,.03) 0 1px,transparent 1px 3px)}
.inst .cap{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--led-dim);font-weight:600}
.inst .val{font-family:var(--mono);font-size:29px;font-weight:600;color:var(--led);margin-top:5px;letter-spacing:-.02em;text-shadow:0 0 20px rgba(99,227,157,.3)}
.inst .val.warn{color:#FFC65C;text-shadow:0 0 20px rgba(255,198,92,.3)}
.inst .val.bad{color:var(--led-red);text-shadow:0 0 20px rgba(255,114,97,.3)}
.inst .val small{font-size:14px;font-weight:400;opacity:.6}
.inst .sub{font-size:12px;color:var(--inst-text);margin-top:7px;font-weight:300}
.meter{height:7px;border-radius:99px;background:var(--inst-rule);margin-top:11px;overflow:hidden;position:relative}
.meter i{display:block;height:100%;background:var(--led);border-radius:99px}
.meter i.warn{background:#FFC65C}.meter i.bad{background:var(--led-red)}
.meter u{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--inst-text);opacity:.6}

.card{background:var(--surface);border:1px solid var(--line);border-radius:13px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{text-align:start;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:11px 14px;border-bottom:1px solid var(--line);background:var(--sunk)}
td{padding:12px 14px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#FBFAF7}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:13.5px}
.mono{font-family:var(--mono);font-size:12.5px;color:var(--muted)}

.pill{display:inline-block;font-size:11.5px;font-weight:500;padding:3px 9px;border-radius:99px;background:var(--sunk);color:var(--muted);white-space:nowrap}
.pill.ok{background:var(--brand-soft);color:var(--brand-deep)}
.pill.warn{background:var(--amber-soft);color:var(--amber)}
.pill.bad{background:var(--danger-soft);color:var(--danger)}

.btn{display:inline-flex;align-items:center;gap:6px;font-family:var(--sans);font-size:13.5px;font-weight:500;padding:8px 14px;border-radius:8px;border:1px solid var(--line2);background:var(--surface);color:var(--ink);cursor:pointer}
.btn:hover{border-color:var(--brand);color:var(--brand-deep)}
.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
.btn.primary:hover{background:var(--brand-deep);color:#fff}
.btn.danger{border-color:var(--danger);color:var(--danger)}
.btn.danger:hover{background:var(--danger);color:#fff}
.btn:disabled{opacity:.45;cursor:not-allowed}

.block{background:var(--danger-soft);border-inline-start:5px solid var(--danger);border-radius:9px;padding:13px 15px;margin:14px 0}
.block b{color:var(--danger);display:block;font-size:14.5px;font-weight:600}
.block p{margin-top:5px;font-size:14px}
.block code{font-family:var(--mono);font-size:11.5px;color:var(--muted);display:block;margin-top:8px}
.note{background:var(--amber-soft);border-inline-start:5px solid var(--amber);border-radius:9px;padding:13px 15px;margin:14px 0;font-size:14px}
.good{background:var(--brand-soft);border-inline-start:5px solid var(--brand);border-radius:9px;padding:13px 15px;margin:14px 0;font-size:14px}

.empty{border:1px dashed var(--line2);border-radius:13px;padding:34px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--ink);font-size:16px;font-weight:600;margin-bottom:5px}

form.inline{display:inline}
select,input[type=text],input[type=number]{font-family:var(--sans);font-size:14px;padding:8px 11px;border:1px solid var(--line);border-radius:8px;background:var(--sunk);color:var(--ink)}
select:focus,input:focus{outline:none;border-color:var(--brand)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.chain{font-family:var(--mono);font-size:11px;color:var(--muted);word-break:break-all}
`;

export function layout(opts: {
  title: string;
  active: string;
  body: string;
  counts?: { alerts: number; unmatched: number; payouts: number };
  crumbs?: Crumb[];
  lede?: string;
}): string {
  const c = opts.counts ?? { alerts: 0, unmatched: 0, payouts: 0 };
  const item = (href: string, key: string, label: string, count?: number) =>
    `<a href="${href}" class="${opts.active === key ? 'on' : ''}">${label}${
      count ? `<span class="count">${count}</span>` : ''
    }</a>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · ReHarvest Ops</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Alexandria:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="shell">
  <nav class="side">
    <div class="brand">
      <div class="mark"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><path d="M12 21V9"/><path d="M12 9C12 9 8 4 4 5c-1 4 4 6 8 4Z"/><path d="M12 11c0 0 3-5 7-4 1 4-3 6-7 4Z"/></svg></div>
      <div><b>ReHarvest</b><span>Ops console</span></div>
    </div>
    <div class="nav">
      ${item('/ops', 'dash', 'Today', c.alerts)}
      ${item('/ops/lots', 'lots', 'Lots')}
      ${item('/ops/orders', 'orders', 'Orders')}
      <div class="sep">Money</div>
      ${item('/ops/payments', 'payments', 'Unmatched', c.unmatched)}
      ${item('/ops/payouts', 'payouts', 'Payouts', c.payouts)}
      <div class="sep">Evidence</div>
      ${item('/ops/audit', 'audit', 'Audit log')}
    </div>
  </nav>
  <main class="main">
    ${opts.crumbs?.length ? `<div class="crumbs">${opts.crumbs.map((b) => (b.href ? `<a href="${b.href}">${esc(b.label)}</a>` : esc(b.label))).join(' › ')}</div>` : ''}
    <h1>${esc(opts.title)}</h1>
    ${opts.lede ? `<p class="lede">${esc(opts.lede)}</p>` : ''}
    ${opts.body}
  </main>
</div></body></html>`;
}

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

export function instrument(o: {
  caption: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: 'ok' | 'warn' | 'bad';
  meter?: { pct: number; ceilingPct?: number };
}): string {
  const tone = o.tone === 'warn' ? ' warn' : o.tone === 'bad' ? ' bad' : '';
  return `<div class="inst">
    <div class="cap">${esc(o.caption)}</div>
    <div class="val${tone}">${esc(o.value)}${o.unit ? ` <small>${esc(o.unit)}</small>` : ''}</div>
    ${o.meter ? `<div class="meter"><i class="${tone.trim()}" style="width:${Math.min(100, o.meter.pct)}%"></i>${
      o.meter.ceilingPct !== undefined ? `<u style="inset-inline-start:${o.meter.ceilingPct}%"></u>` : ''
    }</div>` : ''}
    ${o.sub ? `<div class="sub">${esc(o.sub)}</div>` : ''}
  </div>`;
}

export function table(headers: readonly string[], rows: readonly string[]): string {
  if (rows.length === 0) return '';
  return `<div class="card"><table><thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export function empty(title: string, body: string): string {
  return `<div class="empty"><b>${esc(title)}</b>${esc(body)}</div>`;
}

export function pill(label: string, tone: 'neutral' | 'ok' | 'warn' | 'bad' = 'neutral'): string {
  return `<span class="pill ${tone === 'neutral' ? '' : tone}">${esc(label)}</span>`;
}

export function blockCard(o: { message: string; correction: string; domainId: string; reasonCode: string }): string {
  return `<div class="block"><b>${esc(o.message)}</b><p>${esc(o.correction)}</p><code>${esc(o.domainId)} · ${esc(o.reasonCode)}</code></div>`;
}

/**
 * Escapes for HTML. Applied to every interpolated value without exception —
 * including ones that "cannot" contain markup, because a supplier's legal name
 * arrives from a form and the day someone registers as `<script>` is the day
 * this matters.
 */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Piastres to a display string. Integers only, never a float. */
export function egpStr(piastres: bigint): string {
  const neg = piastres < 0n;
  const a = neg ? -piastres : piastres;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** Grams to kilograms for display. */
export function kgStr(grams: bigint): string {
  const whole = (grams / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (grams % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function ago(iso: string | Date, now = Date.now()): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
