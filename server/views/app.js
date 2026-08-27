// server/views/app.js — layout applicatif (sidebar, topbar) + pages internes
import { esc } from "../security.js";
import { ROLE_LABELS } from "../rbac.js";

/* ---------- Icônes SVG (trait fin, cohérentes) ---------- */
const I = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 5.2L20 8l-4 4.1.9 5.9L12 15.4 7.1 18l.9-5.9L4 8l5.6-.8z"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 15.2c2.7.3 4.8 1.9 5.5 4.8"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
  contact: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4M8 4h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3.3 8.2L12 13l8.7-4.8M12 13v9"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h3l2.6 12h10.6l2.3-8.5H6.2"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H13L13 2z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><rect x="5" y="12" width="3.5" height="6" rx="1"/><rect x="10.5" y="7" width="3.5" height="11" rx="1"/><rect x="16" y="3.5" width="3.5" height="14.5" rx="1"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

export const NAV = [
  { label: "Dashboard", href: "/dashboard", icon: I.dashboard },
  {
    section: "Sales",
    items: [
      { label: "Leads", href: "/dashboard/leads", icon: I.target },
      { label: "Pipeline", href: "/dashboard/leads/kanban", icon: I.chart },
      { label: "Contacts", href: "/dashboard/contacts", icon: I.contact },
      { label: "Deals", href: "/dashboard/deals", icon: I.chart },
      { label: "Tâches", href: "/dashboard/tasks", icon: I.zap },
    ],
  },
  {
    section: "Commerce",
    items: [
      { label: "Products", href: "/dashboard/products", icon: I.box },
      { label: "Catégories", href: "/dashboard/products/categories", icon: I.box },
      { label: "Devis", href: "/dashboard/quotes", icon: I.file },
      { label: "Commandes", href: "/dashboard/orders", icon: I.cart },
    ],
  },
  {
    section: "AI",
    items: [
      { label: "Agent", href: "/dashboard/agent", icon: I.bot },
      { label: "Boîte de réception", href: "/dashboard/inbox", icon: I.inbox },
      { label: "Conversations", href: "/dashboard/conversations", icon: I.chat },
      { label: "Knowledge Base", href: "/dashboard/knowledge", icon: I.book },
    ],
  },
  {
    section: "Automation",
    items: [
      { label: "Automations", href: "/dashboard/automations", icon: I.zap },
      { label: "Séquences", href: "/dashboard/sequences", icon: I.chart },
      { label: "Campagnes", href: "/dashboard/campaigns", icon: I.target },
      { label: "Follow-ups", href: "/dashboard/followups", icon: I.chat },
      { label: "Canaux", href: "/dashboard/channels", icon: I.chat },
      { label: "Analytics", href: "/dashboard/automation/analytics", icon: I.chart },
    ],
  },
  { label: "Facturation", href: "/dashboard/billing", icon: I.card },
  { label: "Diagnostics", href: "/dashboard/diagnostics", icon: I.zap },
  { label: "Settings", href: "/settings", icon: I.gear },
];

function initials(user) {
  return `${(user.first_name[0] || "").toUpperCase()}${(user.last_name[0] || "").toUpperCase()}`;
}

export function brand({ compact = false } = {}) {
  return `<a class="brand" href="/dashboard"><span class="brand-mark">${I.logo}</span>${
    compact ? "" : '<span class="brand-name">AI Sales Agent</span>'
  }</a>`;
}

function navItems(path) {
  const p = path || "";
  const out = [];
  for (const entry of NAV) {
    if (entry.section) {
      out.push(`<div class="nav-section">${esc(entry.section)}</div>`);
      for (const it of entry.items) {
        const active = p === it.href ? " is-active" : "";
        out.push(`<a class="nav-link${active}" href="${it.href}"><span class="nav-ico">${it.icon}</span>${esc(it.label)}</a>`);
      }
    } else {
      const active = p === entry.href || (entry.href === "/settings" && p.startsWith("/settings")) ? " is-active" : "";
      out.push(`<a class="nav-link${active}" href="${entry.href}"><span class="nav-ico">${entry.icon}</span>${esc(entry.label)}</a>`);
    }
  }
  return out.join("\n");
}

export function appLayout({ title, user, org, role, path, csrf, content }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="csrf-token" content="${esc(csrf)}"/>
<meta name="description" content="AI Sales Agent — votre commercial IA disponible 24h/24."/>
<title>${esc(title)} · AI Sales Agent</title>
<link rel="stylesheet" href="/style.css"/>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9C%A8%3C/text%3E%3C/svg%3E"/>
<script>(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body>
<div class="app-shell">
  <aside class="sidebar" id="sidebar" aria-label="Navigation principale">
    ${brand()}
    <nav class="sidebar-nav">${navItems(path)}</nav>
    <div class="sidebar-foot">
      <div class="user-chip">
        <span class="avatar">${esc(initials(user))}</span>
        <span class="user-meta">
          <span class="user-name">${esc(user.first_name)} ${esc(user.last_name)}</span>
          <span class="user-role">${esc(ROLE_LABELS[role] || role)}</span>
        </span>
      </div>
      <form method="POST" action="/api/logout" class="logout-form" data-fetch>
        <input type="hidden" name="_csrf" value="${esc(csrf)}"/>
        <button type="submit" class="icon-btn" title="Se déconnecter" aria-label="Se déconnecter">${I.logout}</button>
      </form>
    </div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <div class="main-col">
    <header class="topbar">
      <button class="icon-btn menu-btn" id="menuBtn" aria-label="Ouvrir le menu">${I.menu}</button>
      <h1 class="topbar-title">${esc(title)}</h1>
      <div class="topbar-actions">
        <button class="icon-btn notif-btn" id="notifBell" aria-label="Notifications" title="Notifications">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
          <span class="notif-count" id="notifCount" style="display:none">0</span>
        </button>
        <button class="icon-btn theme-btn" id="themeBtn" aria-label="Changer de thème"></button>
        <span class="org-chip" title="Organisation active">${esc(org.name)}</span>
      </div>
    </header>
    <main class="main" id="main">${content}</main>
  </div>
</div>
<div id="toasts" aria-live="polite"></div>
<script src="/app.js"></script>
<script src="/crm.js"></script>
<script src="/ai.js"></script>
<script src="/automation.js"></script>
</body>
</html>`;
}

/* ---------- Dashboard ---------- */
export function dashboardPage({ user, org, plan, role, csrf }) {
  const stats = [
    { label: "Leads", value: "0", icon: I.target },
    { label: "Conversations", value: "0", icon: I.chat },
    { label: "Ventes", value: "0", icon: I.cart },
    { label: "Taux de conversion", value: "—", icon: I.chart },
  ];
  return appLayout({
    title: "Dashboard",
    user, org, role, path: "/dashboard", csrf,
    content: `<section class="page-head">
      <div>
        <h2>Bonjour, ${esc(user.first_name)} 👋</h2>
        <p class="muted">Entreprise : <strong>${esc(org.name)}</strong> · Plan ${esc(plan || "FREE")}</p>
      </div>
    </section>
    <div class="stat-grid">
      ${stats.map((s) => `<div class="card stat-card">
        <span class="stat-ico">${s.icon}</span>
        <div><span class="stat-value">${s.value}</span><span class="stat-label">${s.label}</span></div>
      </div>`).join("")}
    </div>
    <div class="card empty-state">
      <span class="empty-ico">${I.inbox}</span>
      <h3>Votre activité commerciale apparaîtra ici.</h3>
      <p class="muted">Les leads, conversations et ventes collectés par votre agent IA seront visualisés en temps réel dans cette phase.</p>
      <div class="empty-actions">
        <a class="btn primary" href="/ai/agent">Configurer l'agent</a>
        <a class="btn ghost" href="/demo/chat">Voir la démo de conversation</a>
      </div>
    </div>`,
  });
}

/* ---------- Pages placeholder (phases suivantes) ---------- */
const PLACEHOLDERS = {
  "/sales/leads": "Leads",
  "/sales/contacts": "Contacts",
  "/sales/deals": "Deals",
  "/ai/agent": "Agent IA",
  "/ai/conversations": "Conversations",
  "/ai/knowledge": "Knowledge Base",
  "/commerce/products": "Products",
  "/commerce/orders": "Orders",
  "/automation/automations": "Automations",
  "/analytics": "Analytics",
};

export function placeholderPage({ user, org, path, role, csrf }) {
  const title = PLACEHOLDERS[path] || "Page";
  return appLayout({
    title, user, org, role, path, csrf,
    content: `<div class="card placeholder-card">
      <span class="empty-ico">${I.zap}</span>
      <h3>Cette fonctionnalité sera disponible dans une prochaine phase.</h3>
      <p class="muted">La Phase 1 couvre les fondations du SaaS : authentification, organisation, multi-tenancy, rôles et paramètres. Les modules commerciaux arrivent ensuite.</p>
      <a class="btn primary" href="/dashboard">← Retour au dashboard</a>
    </div>`,
  });
}

export { I };
