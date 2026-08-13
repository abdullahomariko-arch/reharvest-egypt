"use client";

import { FormEvent, useMemo, useState } from "react";
import diagnostics from "../diagnostics/monte-carlo-results.json";
import {
  calculateOrderEconomics,
  evaluateEconomicGuardrails,
  PILOT_GUARDRAILS,
} from "../lib/economics";

type Demand = {
  id: string; buyer: string; area: string; crop: string; grade: string;
  quantity: number; targetPrice: number; delivery: string; use: string;
  match: number; status: "Matched" | "Sourcing" | "Review";
};

const starterDemands: Demand[] = [
  { id: "DEM-1042", buyer: "Oven & Olive Kitchens", area: "New Cairo", crop: "Sauce tomatoes", grade: "Processing grade", quantity: 1200, targetPrice: 9.5, delivery: "Tomorrow · 7:00 AM", use: "Pizza & pasta sauce", match: 94, status: "Matched" },
  { id: "DEM-1041", buyer: "The Daily Press", area: "Maadi", crop: "Juice oranges", grade: "Juice grade", quantity: 800, targetPrice: 12, delivery: "12 Aug · 8:30 AM", use: "Cold-pressed juice", match: 81, status: "Review" },
  { id: "DEM-1038", buyer: "Table Nine Catering", area: "6th of October", crop: "Kitchen potatoes", grade: "Kitchen grade", quantity: 1500, targetPrice: 10.25, delivery: "13 Aug · 6:30 AM", use: "Central kitchen prep", match: 63, status: "Sourcing" },
];

const navItems = [["overview", "Overview", "home"], ["demand", "Demand board", "list"], ["matches", "Matches", "link"], ["orders", "Orders", "truck"], ["diagnostics", "Diagnostics", "shield"]] as const;

const viewCopy: Record<string, { title: string; description: string }> = {
  overview: { title: "Good evening, Omar.", description: "The tomato corridor has one decision waiting before tomorrow’s collection." },
  demand: { title: "Confirmed buyer demand.", description: "Buy only what a buyer has requested, at a price that protects the landed margin." },
  matches: { title: "Match usable produce.", description: "Compare verified supplier lots against quantity, grade, timing, and total landed cost." },
  orders: { title: "Protect every handoff.", description: "Track collection, quality acceptance, delivery, and payment without losing the audit trail." },
  diagnostics: { title: "Know the risk before collection.", description: "One hundred thousand stress scenarios translated into enforceable operating rules." },
};

const supplyMatches = [
  { id: "LOT-238", supplier: "El Wadi Farms", origin: "Badr, Beheira", crop: "Sauce tomatoes", quantity: 1400, demandKg: 1200, usable: 92, price: 4.75, buyerPrice: 9.5, transport: 1.8, match: 94, pickup: "Today · 5:30 PM" },
  { id: "LOT-233", supplier: "Nile Citrus Growers", origin: "Abu Rawash, Giza", crop: "Juice oranges", quantity: 950, demandKg: 800, usable: 89, price: 8.9, buyerPrice: 12, transport: 1.25, match: 81, pickup: "Tomorrow · 6:00 AM" },
  { id: "LOT-227", supplier: "Delta Harvest", origin: "Kafr El Zayat", crop: "Kitchen potatoes", quantity: 1800, demandKg: 1500, usable: 95, price: 7.6, buyerPrice: 10.25, transport: 1.3, match: 76, pickup: "12 Aug · 4:30 AM" },
];

const tomatoPilotEconomics = calculateOrderEconomics({
  deliveredKg: 1200,
  buyerPricePerKg: 9.5,
  supplierPricePerPurchasedKg: 4.75,
  sortingLossPct: 8,
  transportPerDeliveredKg: 1.8,
  handlingPerDeliveredKg: 0.35,
  inspectionPerDeliveredKg: 0.25,
  claimsReservePerDeliveredKg: 0.2,
});

const operatingRules = [
  "Collect a 30% buyer deposit before a supplier lot is reserved.",
  "Block any lot that is unverified or above 15% expected sorting loss.",
  "Require at least EGP 1.00/kg contribution and a 10% contribution margin.",
  "Reconfirm supplier quantity before dispatching a vehicle.",
  "Do not permit pickup until inspection, photographs, and loaded weight are recorded.",
  "Expire quotations and reservations automatically; never silently change confirmed terms.",
  "Require proof of delivery and buyer weight before acceptance.",
  "Block supplier settlement while a dispute or food-safety incident is open.",
];

const integrationRoadmap = [
  { phase: "Build first", name: "Cloudflare D1 + R2", use: "Orders, audit records, photographs, scale slips and traceability." },
  { phase: "Pilot next", name: "WhatsApp Business Platform", use: "Confirmed order summaries, driver alerts and acceptance requests." },
  { phase: "After contracts", name: "Paymob", use: "Deposits and payment status through a server-side payment adapter." },
  { phase: "After route density", name: "Google Routes", use: "Distance, traffic-aware ETA and multi-stop route optimization." },
  { phase: "Before scale", name: "Egyptian eInvoicing", use: "Tax-compliant invoice submission and document status." },
  { phase: "Before scale", name: "Sentry + product analytics", use: "Errors, slow workflows, release safety and operator usage." },
];

function lotDecision(lot: (typeof supplyMatches)[number]) {
  const sortingLossPct = 100 - lot.usable;
  const economics = calculateOrderEconomics({
    deliveredKg: lot.demandKg,
    buyerPricePerKg: lot.buyerPrice,
    supplierPricePerPurchasedKg: lot.price,
    sortingLossPct,
    transportPerDeliveredKg: lot.transport,
    handlingPerDeliveredKg: 0.35,
    inspectionPerDeliveredKg: 0.25,
    claimsReservePerDeliveredKg: 0.2,
  });
  return { economics, rules: evaluateEconomicGuardrails(economics, sortingLossPct) };
}

function humanizeDiagnosticKey(key: string) {
  const label = key.replace(/([A-Z])/g, " $1").trim().toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9 21v-7h6v7"/></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
    truck: <><path d="M3 6h11v10H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>, pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    leaf: <><path d="M20 4C12 4 6 8 6 14c0 3 2 5 5 5 6 0 9-7 9-15Z"/><path d="M4 21c2-5 6-9 12-12"/></>, check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, calculator: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    shield: <><path d="M12 3 20 6v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function DemandRow({ demand }: { demand: Demand }) {
  return <article className="demand-row">
    <div className={`produce-mark ${demand.crop.includes("tomato") ? "tomato" : demand.crop.includes("orange") ? "orange" : "potato"}`}><span /></div>
    <div className="demand-main">
      <div className="demand-title-line"><h3>{demand.crop}</h3><span className={`status status-${demand.status.toLowerCase()}`}>{demand.status}</span></div>
      <p>{demand.buyer} · {demand.use}</p>
      <div className="row-meta"><span><Icon name="pin" size={14} />{demand.area}</span><span><Icon name="clock" size={14} />{demand.delivery}</span></div>
    </div>
    <div className="quantity-block"><strong>{demand.quantity.toLocaleString()} kg</strong><span>≤ EGP {demand.targetPrice.toFixed(2)} / kg</span></div>
    <div className="match-block" aria-label={`${demand.match}% match confidence`}><div className="match-ring" style={{ "--match": `${demand.match * 3.6}deg` } as React.CSSProperties}><span>{demand.match}%</span></div><small>confidence</small></div>
    <button className="icon-button row-arrow" aria-label={`Open ${demand.id}`}><Icon name="arrow" /></button>
  </article>;
}

export default function ReHarvestApp() {
  const [activeView, setActiveView] = useState("overview");
  const [demands, setDemands] = useState(starterDemands);
  const [isDemandOpen, setDemandOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [acceptedLots, setAcceptedLots] = useState<string[]>([]);
  const [demandFilter, setDemandFilter] = useState<"all" | "needs-match" | "matched">("all");
  const pipelineKg = useMemo(() => demands.reduce((sum, item) => sum + item.quantity, 0), [demands]);
  const visibleDemands = useMemo(() => demands.filter((demand) => {
    if (demandFilter === "matched") return demand.status === "Matched";
    if (demandFilter === "needs-match") return demand.status !== "Matched";
    return true;
  }), [demands, demandFilter]);

  function submitDemand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const next: Demand = { id: `DEM-${1043 + demands.length}`, buyer: String(data.get("buyer") || "Pilot buyer"), area: String(data.get("area") || "Cairo"), crop: String(data.get("crop") || "Sauce tomatoes"), grade: "Processing grade", quantity: Number(data.get("quantity") || 500), targetPrice: Number(data.get("price") || 10), delivery: String(data.get("delivery") || "Next available slot"), use: String(data.get("use") || "Food preparation"), match: 38, status: "Sourcing" };
    setDemands((current) => [next, ...current]); setDemandOpen(false); setNotice(`${next.id} is live. The operator can now verify suppliers.`); event.currentTarget.reset();
  }

  function acceptMatch(lotId: string, supplier: string) {
    setAcceptedLots((current) => current.includes(lotId) ? current : [...current, lotId]);
    setNotice(`${lotId} from ${supplier} is reserved. A pilot order has been opened.`);
    setActiveView("orders");
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#top" aria-label="ReHarvest home"><span className="brand-mark"><Icon name="leaf" size={20} /></span><span>ReHarvest</span></a>
      <nav className="side-nav" aria-label="Primary navigation">{navItems.map(([id, label, icon]) => <button key={id} className={activeView === id ? "active" : ""} onClick={() => setActiveView(id)}><Icon name={icon} /><span>{label}</span></button>)}</nav>
      <div className="pilot-card"><span className="eyebrow light">Pilot corridor</span><strong>Tomatoes → New Cairo</strong><p>One crop. Five buyers. Every cost tracked.</p><div className="pilot-progress"><span /></div><small>Week 1 of 4</small></div>
      <div className="profile-card"><span className="avatar">OA</span><div><strong>Omar</strong><span>Pilot operator</span></div><button className="profile-menu" aria-label="Profile menu">•••</button></div>
    </aside>
    <section className="workspace" id="top">
      <header className="topbar"><div className="search-box search-disabled"><Icon name="search" size={17} /><input aria-label="Search marketplace" placeholder="Search activates with live data" disabled /><kbd>Planned</kbd></div><div className="top-actions"><span className="live-pill"><i /> Pilot simulation</span><button className="icon-button" aria-label="Show notification status" onClick={() => setNotice("Notifications remain simulated until the WhatsApp integration is connected.")}><Icon name="bell" /></button><button className="primary-button" onClick={() => setDemandOpen(true)}><Icon name="plus" />Post demand</button></div></header>
      <div className={`content content-${activeView}`}>
        <section className="welcome-row"><div><span className="eyebrow">Pilot model · August 2026</span><h1>{viewCopy[activeView].title}</h1><p>{viewCopy[activeView].description}</p></div><div className="weather-note"><Icon name="clock" size={24} /><div><strong>Early pickup rule</strong><small>Weather data integration planned</small></div></div></section>
        {notice && <div className="notice" role="status"><span><Icon name="check" size={16} /></span>{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice"><Icon name="close" size={15} /></button></div>}
        <section className="corridor-card"><div className="corridor-copy"><span className="eyebrow light">Pilot transaction corridor</span><h2>Sauce-grade tomatoes</h2><p>Verified lots from Beheira matched to kitchens in New Cairo. Collection requires every control to pass.</p></div><div className="route-line" aria-label="Route from Beheira to New Cairo"><span><i /><small>Beheira</small></span><b><span>146 km</span></b><span><i /><small>New Cairo</small></span></div><button className="light-button" onClick={() => setActiveView("diagnostics")}>Open controls <Icon name="arrow" size={16} /></button></section>
        <section className="metric-grid" aria-label="Pilot metrics"><article><div className="metric-icon green"><Icon name="link" /></div><div><span>Matched demand</span><strong>{pipelineKg.toLocaleString()} kg</strong><small>Demo pipeline</small></div></article><article><div className="metric-icon orange"><Icon name="truck" /></div><div><span>Orders moving</span><strong>3</strong><small>Simulated handoffs</small></div></article><article><div className="metric-icon red"><Icon name="calculator" /></div><div><span>Contribution</span><strong>EGP {tomatoPilotEconomics.contributionPerDeliveredKg.toFixed(2)}/kg</strong><small>{tomatoPilotEconomics.contributionMarginPct.toFixed(1)}% after all variable costs</small></div></article><article><div className="metric-icon olive"><Icon name="leaf" /></div><div><span>Produce redirected</span><strong>4.7 t</strong><small>Demo pilot total</small></div></article></section>
        <section className="dashboard-grid"><div className="demand-panel panel"><div className="panel-header"><div><span className="eyebrow">Demand first</span><h2>Requests needing action</h2></div><button className="text-button" onClick={() => setActiveView("demand")}>View board <Icon name="arrow" size={15} /></button></div><div className="demand-list">{demands.slice(0, 3).map((demand) => <DemandRow key={demand.id} demand={demand} />)}</div></div>
          <aside className="control-panel panel"><div className="panel-header compact"><div><span className="eyebrow">Operator view</span><h2>Pilot control tower</h2></div></div><ol className="checkpoint-list"><li className="done"><span><Icon name="check" size={14} /></span><div><strong>Demand confirmed</strong><small>3 buyers · 3,500 kg</small></div></li><li className="done"><span><Icon name="check" size={14} /></span><div><strong>Supplier lot inspected</strong><small>Grade + photos logged</small></div></li><li className="current"><span>3</span><div><strong>Approve contribution</strong><small>Minimum EGP 1/kg and 10%</small></div></li><li><span>4</span><div><strong>Release collection</strong><small>Deposit and evidence required</small></div></li></ol><div className="economics-card"><div className="economics-head"><span>Transparent economics</span><strong>{tomatoPilotEconomics.deliveredKg.toLocaleString()} kg delivered</strong></div><dl><div><dt>Purchase {Math.round(tomatoPilotEconomics.purchasedKg).toLocaleString()} kg</dt><dd>EGP {Math.round(tomatoPilotEconomics.purchaseCost).toLocaleString()}</dd></div><div><dt>Transport</dt><dd>EGP {Math.round(tomatoPilotEconomics.transportCost).toLocaleString()}</dd></div><div><dt>Crates + handling</dt><dd>EGP {Math.round(tomatoPilotEconomics.handlingCost).toLocaleString()}</dd></div><div><dt>Inspection + loading</dt><dd>EGP {Math.round(tomatoPilotEconomics.inspectionCost).toLocaleString()}</dd></div><div><dt>Claims reserve</dt><dd>EGP {Math.round(tomatoPilotEconomics.claimsReserve).toLocaleString()}</dd></div><div className="total"><dt>Total variable cost</dt><dd>EGP {Math.round(tomatoPilotEconomics.totalVariableCost).toLocaleString()}</dd></div></dl><div className="margin-result"><span>Contribution after all listed costs</span><strong>EGP {Math.round(tomatoPilotEconomics.contribution).toLocaleString()} · {tomatoPilotEconomics.contributionMarginPct.toFixed(1)}%</strong></div><button className="approve-button" onClick={() => setNotice("Economics pass. Collection still requires the buyer deposit and operational evidence.")}><Icon name="check" />Approve contribution</button></div></aside>
        </section>
        {activeView === "demand" && <section className="view-page">
          <div className="view-toolbar panel"><div><span className="eyebrow">Buyer-led sourcing</span><h2>Demand board</h2><p>{demands.length} confirmed requests · {pipelineKg.toLocaleString()} kg in the active pipeline</p></div><div className="toolbar-actions"><button className={`filter-chip ${demandFilter === "all" ? "active" : ""}`} onClick={() => setDemandFilter("all")}>All demand</button><button className={`filter-chip ${demandFilter === "needs-match" ? "active" : ""}`} onClick={() => setDemandFilter("needs-match")}>Needs match</button><button className={`filter-chip ${demandFilter === "matched" ? "active" : ""}`} onClick={() => setDemandFilter("matched")}>Matched</button><button className="primary-button" onClick={() => setDemandOpen(true)}><Icon name="plus" />New request</button></div></div>
          <div className="board-panel panel"><div className="board-head"><span>Request</span><span>Quantity & ceiling</span><span>Match quality</span><span>Action</span></div><div className="demand-list full-list">{visibleDemands.map((demand) => <DemandRow key={demand.id} demand={demand} />)}</div></div>
          <div className="pilot-rule"><Icon name="check" /><div><strong>The demand-first rule</strong><p>A request only enters sourcing after the buyer confirms crop, accepted use, delivery window, quantity, and maximum landed price.</p></div></div>
        </section>}
        {activeView === "matches" && <section className="view-page">
          <div className="view-toolbar panel"><div><span className="eyebrow">Verified supply only</span><h2>Recommended matches</h2><p>Three lots scored against confirmed demand, route, quality, and complete landed cost.</p></div><button className="secondary-button" onClick={() => setActiveView("diagnostics")}>View operating rules</button></div>
          <div className="match-grid">{supplyMatches.map((lot) => { const decision = lotDecision(lot); return <article className="supply-card panel" key={lot.id}>
            <div className="supply-top"><div className={`produce-mark ${lot.crop.includes("tomato") ? "tomato" : lot.crop.includes("orange") ? "orange" : "potato"}`}><span /></div><div><span className="verified"><Icon name="check" size={12} /> Verified supplier</span><h3>{lot.supplier}</h3><p>{lot.origin}</p></div><div className="score-badge"><strong>{lot.match}%</strong><span>match</span></div></div>
            <div className="supply-crop"><span>{lot.crop}</span><strong>{lot.quantity.toLocaleString()} kg available</strong></div>
            <dl className="lot-facts"><div><dt>Usable yield</dt><dd>{lot.usable}%</dd></div><div><dt>Farm-gate price</dt><dd>EGP {lot.price.toFixed(2)}/kg</dd></div><div><dt>Pickup window</dt><dd>{lot.pickup}</dd></div></dl>
            <div className="landed-preview"><span>Complete landed cost</span><strong>EGP {decision.economics.landedCostPerDeliveredKg.toFixed(2)}/kg</strong></div>
            <div className={`margin-check ${decision.rules.approved ? "pass" : "block"}`}><span>{decision.rules.approved ? "Passes rules" : "Blocked"}</span><strong>{decision.economics.contributionPerDeliveredKg >= 0 ? "+" : ""}{decision.economics.contributionPerDeliveredKg.toFixed(2)} EGP/kg · {decision.economics.contributionMarginPct.toFixed(1)}%</strong></div>
            <button className="approve-button" disabled={acceptedLots.includes(lot.id) || !decision.rules.approved} onClick={() => acceptMatch(lot.id, lot.supplier)}>{acceptedLots.includes(lot.id) ? <><Icon name="check" />Lot reserved</> : !decision.rules.approved ? <>Below economic rule</> : <>Review & reserve <Icon name="arrow" /></>}</button>
          </article>; })}</div>
        </section>}
        {activeView === "orders" && <section className="view-page">
          <div className="view-toolbar panel"><div><span className="eyebrow">Transaction record</span><h2>Orders & handoffs</h2><p>Each order keeps quality, route, acceptance, and payment in one evidence trail.</p></div><div className="toolbar-actions"><button className="filter-chip active">Active</button><button className="filter-chip">Completed</button></div></div>
          <div className="orders-layout"><div className="orders-list panel">
            {acceptedLots.map((lotId) => { const lot = supplyMatches.find((item) => item.id === lotId)!; return <article className="order-row featured" key={lotId}><span className="order-state orange"><Icon name="clock" /></span><div><span className="eyebrow">New · RH-1254</span><h3>{lot.crop} · {lot.quantity.toLocaleString()} kg</h3><p>{lot.supplier} → matched buyer</p></div><div className="order-status"><strong>Supplier reserved</strong><span>Awaiting final call</span></div><button className="icon-button"><Icon name="arrow" /></button></article>; })}
            <article className="order-row"><span className="order-state green"><Icon name="truck" /></span><div><span className="eyebrow">RH-1251</span><h3>Sauce tomatoes · 1,200 kg</h3><p>El Wadi Farms → Oven & Olive Kitchens</p></div><div className="order-status"><strong>In transit</strong><span>ETA tomorrow · 6:45 AM</span></div><button className="icon-button"><Icon name="arrow" /></button></article>
            <article className="order-row"><span className="order-state blue"><Icon name="check" /></span><div><span className="eyebrow">RH-1248</span><h3>Juice oranges · 800 kg</h3><p>Nile Citrus Growers → The Daily Press</p></div><div className="order-status"><strong>Quality accepted</strong><span>Payment due 12 Aug</span></div><button className="icon-button"><Icon name="arrow" /></button></article>
            <article className="order-row"><span className="order-state olive"><Icon name="check" /></span><div><span className="eyebrow">RH-1243</span><h3>Kitchen potatoes · 1,500 kg</h3><p>Delta Harvest → Table Nine Catering</p></div><div className="order-status"><strong>Delivered</strong><span>4.2% sorting loss</span></div><button className="icon-button"><Icon name="arrow" /></button></article>
          </div><aside className="evidence-panel panel"><span className="eyebrow">Required evidence</span><h2>Close the loop</h2><ol><li className="done"><span><Icon name="check" size={13} /></span><div><strong>Supplier lot photos</strong><small>4 files logged</small></div></li><li className="done"><span><Icon name="check" size={13} /></span><div><strong>Loaded weight</strong><small>Scale slip logged</small></div></li><li className="current"><span>3</span><div><strong>Buyer acceptance</strong><small>Due after delivery</small></div></li><li><span>4</span><div><strong>Final loss & margin</strong><small>Close after payment</small></div></li></ol><button className="secondary-button">Open order evidence</button></aside></div>
        </section>}
        {activeView === "diagnostics" && <section className="view-page diagnostics-page">
          <div className="view-toolbar panel"><div><span className="eyebrow">Reproducible stress test</span><h2>{diagnostics.scenarioCount.toLocaleString()} operating possibilities</h2><p>Seed {diagnostics.seed} · assumptions are stress inputs, not market forecasts.</p></div><span className="diagnostic-badge"><Icon name="shield" size={16} /> Controls modelled</span></div>
          <div className="diagnostic-metrics">
            <article className="panel"><span>Loss-making outcomes</span><strong>{diagnostics.protected.probabilityOfLossPct.toFixed(2)}%</strong><small>With deposits and backup workflows</small></article>
            <article className="panel"><span>Median contribution</span><strong>EGP {diagnostics.protected.medianContributionPerKg.toFixed(2)}/kg</strong><small>{diagnostics.protected.medianContributionMarginPct.toFixed(2)}% median margin</small></article>
            <article className="panel"><span>5th-percentile downside</span><strong>EGP {diagnostics.protected.p05ContributionEgp.toLocaleString()}</strong><small>Bad but non-worst stress outcome</small></article>
            <article className="panel"><span>Controls improve downside</span><strong>EGP {diagnostics.controlImpact.p05ContributionImprovementEgp.toLocaleString()}</strong><small>Protected vs. unprotected P5</small></article>
          </div>
          <div className="diagnostic-grid">
            <section className="panel outcome-panel"><div className="panel-header"><div><span className="eyebrow">Outcome distribution</span><h2>What the 100,000 runs produced</h2></div></div>{Object.entries(diagnostics.protected.categories).map(([key, value]) => <div className="outcome-row" key={key}><span>{key === "severeLoss" ? "Severe loss" : key.charAt(0).toUpperCase() + key.slice(1)}</span><div><i style={{ width: `${value.pct}%` }} /></div><strong>{value.pct.toFixed(2)}%</strong></div>)}<p className="model-note">A 24.26% modelled loss rate does not predict that one in four real orders will fail. It shows the current baseline is fragile across the deliberately wide stress ranges and must be protected by real pilot data.</p></section>
            <section className="panel risk-impact-panel"><div className="panel-header"><div><span className="eyebrow">Average impact when triggered</span><h2>Largest financial shocks</h2></div></div>{Object.entries(diagnostics.eventImpactProtected).sort(([, a], [, b]) => a.estimatedImpactEgp - b.estimatedImpactEgp).slice(0, 5).map(([key, value]) => <div className="impact-row" key={key}><span>{humanizeDiagnosticKey(key)}</span><strong>EGP {Math.round(value.estimatedImpactEgp).toLocaleString()}</strong></div>)}</section>
          </div>
          <div className="diagnostic-grid rules-grid">
            <section className="panel rules-panel"><div className="panel-header"><div><span className="eyebrow">Hard operating gates</span><h2>Rules the system should enforce</h2></div></div><ol>{operatingRules.map((rule, index) => <li key={rule}><span>{index + 1}</span><p>{rule}</p></li>)}</ol></section>
            <section className="panel assumptions-panel"><div className="panel-header"><div><span className="eyebrow">Current pilot thresholds</span><h2>Automatic economic blocks</h2></div></div><dl><div><dt>Minimum contribution</dt><dd>EGP {PILOT_GUARDRAILS.minimumContributionPerKg.toFixed(2)}/kg</dd></div><div><dt>Minimum contribution margin</dt><dd>{PILOT_GUARDRAILS.minimumContributionMarginPct.toFixed(1)}%</dd></div><div><dt>Maximum sorting loss</dt><dd>{PILOT_GUARDRAILS.maximumSortingLossPct.toFixed(1)}%</dd></div><div><dt>Buyer deposit</dt><dd>30% before reservation</dd></div><div><dt>Baseline break-even</dt><dd>EGP {tomatoPilotEconomics.breakEvenBuyerPricePerKg.toFixed(2)}/kg</dd></div></dl><div className="danger-note"><Icon name="shield" /><p><strong>Never call unsafe produce “Grade B.”</strong><span>Cosmetic imperfection is acceptable; spoiled or unsafe produce is not.</span></p></div></section>
          </div>
          <section className="panel integrations-panel"><div className="panel-header"><div><span className="eyebrow">Integration roadmap</span><h2>What should connect to the website</h2></div></div><div className="integration-grid">{integrationRoadmap.map((item) => <article key={item.name}><span>{item.phase}</span><h3>{item.name}</h3><p>{item.use}</p></article>)}</div></section>
        </section>}
      </div>
    </section>
    {isDemandOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDemandOpen(false)}><section className="demand-modal" role="dialog" aria-modal="true" aria-labelledby="demand-modal-title"><header><div><span className="eyebrow">Buyer request</span><h2 id="demand-modal-title">Post confirmed demand</h2><p>Only request quantities your buyer has agreed to test.</p></div><button className="icon-button" onClick={() => setDemandOpen(false)} aria-label="Close"><Icon name="close" /></button></header><form onSubmit={submitDemand}><label><span>Buyer business</span><input name="buyer" required placeholder="e.g. Oven & Olive Kitchens" /></label><div className="form-grid"><label><span>Produce needed</span><select name="crop" defaultValue="Sauce tomatoes"><option>Sauce tomatoes</option><option>Juice oranges</option><option>Kitchen potatoes</option><option>Smoothie mangoes</option></select></label><label><span>Delivery area</span><input name="area" required placeholder="New Cairo" /></label><label><span>Quantity (kg)</span><input name="quantity" required type="number" min="50" step="50" defaultValue="500" /></label><label><span>Maximum EGP / kg</span><input name="price" required type="number" min="1" step="0.25" defaultValue="10" /></label></div><label><span>Intended use</span><input name="use" required placeholder="Sauce, juice, central kitchen prep…" /></label><label><span>Delivery window</span><input name="delivery" required placeholder="Tomorrow · 7:00 AM" /></label><div className="quality-callout"><Icon name="check" /><p><strong>Managed pilot rule</strong><span>ReHarvest verifies grade, usable percentage, photos, and final landed price before confirming any order.</span></p></div><footer><button type="button" className="secondary-button" onClick={() => setDemandOpen(false)}>Cancel</button><button type="submit" className="primary-button">Publish demand <Icon name="arrow" /></button></footer></form></section></div>}
  </main>;
}
