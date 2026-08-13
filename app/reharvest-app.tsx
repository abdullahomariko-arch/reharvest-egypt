"use client";

import { FormEvent, useMemo, useState } from "react";

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

const navItems = [["overview", "Overview", "home"], ["demand", "Demand board", "list"], ["matches", "Matches", "link"], ["orders", "Orders", "truck"]] as const;

const viewCopy: Record<string, { title: string; description: string }> = {
  overview: { title: "Good evening, Omar.", description: "The tomato corridor has one decision waiting before tomorrow’s collection." },
  demand: { title: "Confirmed buyer demand.", description: "Buy only what a buyer has requested, at a price that protects the landed margin." },
  matches: { title: "Match usable produce.", description: "Compare verified supplier lots against quantity, grade, timing, and total landed cost." },
  orders: { title: "Protect every handoff.", description: "Track collection, quality acceptance, delivery, and payment without losing the audit trail." },
};

const supplyMatches = [
  { id: "LOT-238", supplier: "El Wadi Farms", origin: "Badr, Beheira", crop: "Sauce tomatoes", quantity: 1400, usable: 92, price: 6.8, match: 94, pickup: "Today · 5:30 PM" },
  { id: "LOT-233", supplier: "Nile Citrus Growers", origin: "Abu Rawash, Giza", crop: "Juice oranges", quantity: 950, usable: 89, price: 8.9, match: 81, pickup: "Tomorrow · 6:00 AM" },
  { id: "LOT-227", supplier: "Delta Harvest", origin: "Kafr El Zayat", crop: "Kitchen potatoes", quantity: 1800, usable: 95, price: 7.6, match: 76, pickup: "12 Aug · 4:30 AM" },
];

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
  const pipelineKg = useMemo(() => demands.reduce((sum, item) => sum + item.quantity, 0), [demands]);

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
      <header className="topbar"><div className="search-box"><Icon name="search" size={17} /><input aria-label="Search marketplace" placeholder="Search demand, supply, or partner" /><kbd>⌘ K</kbd></div><div className="top-actions"><span className="live-pill"><i /> Pilot live</span><button className="icon-button" aria-label="Notifications"><Icon name="bell" /></button><button className="primary-button" onClick={() => setDemandOpen(true)}><Icon name="plus" />Post demand</button></div></header>
      <div className={`content content-${activeView}`}>
        <section className="welcome-row"><div><span className="eyebrow">Monday · 10 August 2026</span><h1>{viewCopy[activeView].title}</h1><p>{viewCopy[activeView].description}</p></div><div className="weather-note"><span>34°</span><div><strong>Warm route</strong><small>Plan an early pickup</small></div></div></section>
        {notice && <div className="notice" role="status"><span><Icon name="check" size={16} /></span>{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice"><Icon name="close" size={15} /></button></div>}
        <section className="corridor-card"><div className="corridor-copy"><span className="eyebrow light">Today’s transaction corridor</span><h2>Sauce-grade tomatoes</h2><p>Verified lots from Beheira matched to kitchens in New Cairo. Collection closes at 2:00 PM.</p></div><div className="route-line" aria-label="Route from Beheira to New Cairo"><span><i /><small>Beheira</small></span><b><span>146 km</span></b><span><i /><small>New Cairo</small></span></div><button className="light-button">Open corridor <Icon name="arrow" size={16} /></button></section>
        <section className="metric-grid" aria-label="Pilot metrics"><article><div className="metric-icon green"><Icon name="link" /></div><div><span>Matched demand</span><strong>{pipelineKg.toLocaleString()} kg</strong><small><b>+12%</b> since Friday</small></div></article><article><div className="metric-icon orange"><Icon name="truck" /></div><div><span>Orders moving</span><strong>3</strong><small>2 deliveries tomorrow</small></div></article><article><div className="metric-icon red"><Icon name="calculator" /></div><div><span>Projected spread</span><strong>EGP 8.40/kg</strong><small>After route + sorting</small></div></article><article><div className="metric-icon olive"><Icon name="leaf" /></div><div><span>Produce redirected</span><strong>4.7 t</strong><small>Across current pilot</small></div></article></section>
        <section className="dashboard-grid"><div className="demand-panel panel"><div className="panel-header"><div><span className="eyebrow">Demand first</span><h2>Requests needing action</h2></div><button className="text-button" onClick={() => setActiveView("demand")}>View board <Icon name="arrow" size={15} /></button></div><div className="demand-list">{demands.slice(0, 3).map((demand) => <DemandRow key={demand.id} demand={demand} />)}</div></div>
          <aside className="control-panel panel"><div className="panel-header compact"><div><span className="eyebrow">Operator view</span><h2>Pilot control tower</h2></div></div><ol className="checkpoint-list"><li className="done"><span><Icon name="check" size={14} /></span><div><strong>Demand confirmed</strong><small>3 buyers · 3,500 kg</small></div></li><li className="done"><span><Icon name="check" size={14} /></span><div><strong>Supplier lot inspected</strong><small>Grade + photos logged</small></div></li><li className="current"><span>3</span><div><strong>Approve landed margin</strong><small>Decision due by 1:30 PM</small></div></li><li><span>4</span><div><strong>Release collection</strong><small>Driver waiting</small></div></li></ol><div className="economics-card"><div className="economics-head"><span>Order economics</span><strong>1,200 kg</strong></div><dl><div><dt>Buy price</dt><dd>EGP 6.80</dd></div><div><dt>Sorting + crates</dt><dd>EGP 0.55</dd></div><div><dt>Delivery</dt><dd>EGP 0.92</dd></div><div><dt>Loss allowance · 4%</dt><dd>EGP 0.29</dd></div><div className="total"><dt>Landed cost</dt><dd>EGP 8.56/kg</dd></div></dl><div className="margin-result"><span>Expected gross profit</span><strong>EGP 1,128</strong></div><button className="approve-button" onClick={() => setNotice("Margin approved. Collection can now be released.")}><Icon name="check" />Approve margin</button></div></aside>
        </section>
        {activeView === "demand" && <section className="view-page">
          <div className="view-toolbar panel"><div><span className="eyebrow">Buyer-led sourcing</span><h2>Demand board</h2><p>{demands.length} confirmed requests · {pipelineKg.toLocaleString()} kg in the active pipeline</p></div><div className="toolbar-actions"><button className="filter-chip active">All demand</button><button className="filter-chip">Needs match</button><button className="filter-chip">Matched</button><button className="primary-button" onClick={() => setDemandOpen(true)}><Icon name="plus" />New request</button></div></div>
          <div className="board-panel panel"><div className="board-head"><span>Request</span><span>Quantity & ceiling</span><span>Match quality</span><span>Action</span></div><div className="demand-list full-list">{demands.map((demand) => <DemandRow key={demand.id} demand={demand} />)}</div></div>
          <div className="pilot-rule"><Icon name="check" /><div><strong>The demand-first rule</strong><p>A request only enters sourcing after the buyer confirms crop, accepted use, delivery window, quantity, and maximum landed price.</p></div></div>
        </section>}
        {activeView === "matches" && <section className="view-page">
          <div className="view-toolbar panel"><div><span className="eyebrow">Verified supply only</span><h2>Recommended matches</h2><p>Three lots scored against confirmed demand, route, quality, and landed cost.</p></div><button className="secondary-button">Adjust match rules</button></div>
          <div className="match-grid">{supplyMatches.map((lot) => <article className="supply-card panel" key={lot.id}>
            <div className="supply-top"><div className={`produce-mark ${lot.crop.includes("tomato") ? "tomato" : lot.crop.includes("orange") ? "orange" : "potato"}`}><span /></div><div><span className="verified"><Icon name="check" size={12} /> Verified supplier</span><h3>{lot.supplier}</h3><p>{lot.origin}</p></div><div className="score-badge"><strong>{lot.match}%</strong><span>match</span></div></div>
            <div className="supply-crop"><span>{lot.crop}</span><strong>{lot.quantity.toLocaleString()} kg available</strong></div>
            <dl className="lot-facts"><div><dt>Usable yield</dt><dd>{lot.usable}%</dd></div><div><dt>Farm-gate price</dt><dd>EGP {lot.price.toFixed(2)}/kg</dd></div><div><dt>Pickup window</dt><dd>{lot.pickup}</dd></div></dl>
            <div className="landed-preview"><span>Estimated landed cost</span><strong>EGP {(lot.price + 1.76).toFixed(2)}/kg</strong></div>
            <button className="approve-button" disabled={acceptedLots.includes(lot.id)} onClick={() => acceptMatch(lot.id, lot.supplier)}>{acceptedLots.includes(lot.id) ? <><Icon name="check" />Lot reserved</> : <>Review & reserve <Icon name="arrow" /></>}</button>
          </article>)}</div>
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
      </div>
    </section>
    {isDemandOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDemandOpen(false)}><section className="demand-modal" role="dialog" aria-modal="true" aria-labelledby="demand-modal-title"><header><div><span className="eyebrow">Buyer request</span><h2 id="demand-modal-title">Post confirmed demand</h2><p>Only request quantities your buyer has agreed to test.</p></div><button className="icon-button" onClick={() => setDemandOpen(false)} aria-label="Close"><Icon name="close" /></button></header><form onSubmit={submitDemand}><label><span>Buyer business</span><input name="buyer" required placeholder="e.g. Oven & Olive Kitchens" /></label><div className="form-grid"><label><span>Produce needed</span><select name="crop" defaultValue="Sauce tomatoes"><option>Sauce tomatoes</option><option>Juice oranges</option><option>Kitchen potatoes</option><option>Smoothie mangoes</option></select></label><label><span>Delivery area</span><input name="area" required placeholder="New Cairo" /></label><label><span>Quantity (kg)</span><input name="quantity" required type="number" min="50" step="50" defaultValue="500" /></label><label><span>Maximum EGP / kg</span><input name="price" required type="number" min="1" step="0.25" defaultValue="10" /></label></div><label><span>Intended use</span><input name="use" required placeholder="Sauce, juice, central kitchen prep…" /></label><label><span>Delivery window</span><input name="delivery" required placeholder="Tomorrow · 7:00 AM" /></label><div className="quality-callout"><Icon name="check" /><p><strong>Managed pilot rule</strong><span>ReHarvest verifies grade, usable percentage, photos, and final landed price before confirming any order.</span></p></div><footer><button type="button" className="secondary-button" onClick={() => setDemandOpen(false)}>Cancel</button><button type="submit" className="primary-button">Publish demand <Icon name="arrow" /></button></footer></form></section></div>}
  </main>;
}
