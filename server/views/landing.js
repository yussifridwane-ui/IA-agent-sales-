// server/views/landing.js — page d'accueil (marketing)
// Positionnement : « Un commercial IA qui ne ment jamais » · pilote gratuit · 0 hallucination
import { esc } from "../security.js";
import { isPilotMode } from "../billing.js";

const TRUST = [
  { label: "Multi-tenant isolé", icon: "🔒" },
  { label: "Mots de passe hachés PBKDF2", icon: "🛡️" },
  { label: "0 hallucination — vérifié par 24 tests", icon: "✓" },
];

const MARQUEE = [
  "Connecté à votre catalogue réel",
  "Réponses 24 h/24",
  "Lead scoring explicable",
  "CRM & follow-ups inclus",
  "Isolation multi-tenant stricte",
];

const FEATURES = [
  { icon: "📦", title: "Catalogue réel uniquement", text: "Prix, stock et caractéristiques lus en base. Si l'info n'existe pas, l'agent le dit — jamais d'invention." },
  { icon: "🎯", title: "Lead scoring explicable", text: "Note sur 100 décomposée : intention 30, budget 25, urgence 20, engagement 15, adéquation 10." },
  { icon: "💬", title: "Qualification 24 h/24", text: "L'agent pose les questions manquantes, note le lead et crée le follow-up au bon moment." },
  { icon: "🤝", title: "Transfert humain", text: "Demande d'humain, plainte ou info hors catalogue → conversation gelée + tâche CRM automatique." },
  { icon: "📊", title: "CRM complet", text: "Leads, contacts, deals, tâches, conversations et follow-ups persistants après actualisation." },
  { icon: "🔬", title: "Suite de diagnostics", text: "Page intégrée qui vérifie isolation multi-tenant, anti-hallucination et hachage des mots de passe." },
];

const STEPS = [
  { n: "01", title: "Créez votre organisation", text: "Inscription en deux minutes : entreprise, secteur, devise. Aucune carte bancaire." },
  { n: "02", title: "Décrivez votre offre", text: "Nom, description, catégorie, prix et stock de chaque produit : c'est la seule source que l'agent pourra citer." },
  { n: "03", title: "L'agent répond et qualifie", text: "Il cite uniquement vos prix et stocks réels, pose les questions manquantes et calcule un score expliqué sur 100." },
  { n: "04", title: "Vous reprenez la main", text: "Le lead, la conversation, le deal et le follow-up sont déjà dans le CRM. Transfert humain si la demande n'est pas couverte." },
];

const FAQ = [
  { q: "L'agent peut-il inventer un produit ou un prix ?", a: "Non, et c'est vérifiable. Les réponses sont assemblées à partir des lignes lues dans votre table produits : si l'information n'existe pas, l'agent dit « Je n'ai pas cette information dans le catalogue » et propose de transférer à un conseiller. Un maximum de 3 produits est recommandé par réponse." },
  { q: "Comment fonctionne le lead scoring ?", a: "Chaque lead reçoit une note sur 100, décomposée en cinq critères : intention (30 pts), budget (25 pts), urgence (20 pts), engagement (15 pts) et adéquation avec votre offre (10 pts). La décomposition est stockée et affichée, donc le score est toujours explicable et reproductible." },
  { q: "Mes données sont-elles isolées des autres entreprises ?", a: "Oui. Toute donnée commerciale porte un identifiant d'organisation et chaque requête API est filtrée par celui de l'utilisateur authentifié. Une entreprise B ne peut ni lire ni modifier une ressource de A, même en forgeant un identifiant. La page Diagnostics teste explicitement cette tentative." },
  { q: "Comment sont protégés les mots de passe ?", a: "Par dérivation PBKDF2-SHA256 avec 210 000 itérations et un sel aléatoire unique par utilisateur. Aucun mot de passe n'est stocké en clair, et la comparaison se fait à temps constant pour résister aux attaques temporelles." },
  { q: "Que se passe-t-il si un prospect demande un humain ?", a: "L'agent arrête de répondre, passe la conversation en statut « transféré à un humain » et crée automatiquement une tâche dans le CRM pour qu'un membre de votre équipe reprenne la main avec tout l'historique du contexte." },
  { q: "Les données sont-elles conservées après actualisation ?", a: "Oui, elles sont écrites dans une base persistante : leads, conversations, scores, deals, tâches et follow-ups restent en place après actualisation, déconnexion, reconnexion ou redémarrage de l'application." },
  { q: "Faut-il une carte bancaire pour commencer ?", a: "Non. Le pilote est gratuit : toutes les fonctionnalités sont ouvertes, sans carte bancaire et sans limite d'usage pendant la phase de tests avec les commerçants." },
  { q: "L'abonnement est-il sans engagement ?", a: "Totalement. Vous pouvez changer de formule, la mettre en pause ou la résilier à tout moment depuis votre espace — sans frais ni justification. La facturation sera ajoutée après la phase de tests." },
];

const TESTIMONIAL = {
  quote: "Ce qui m'a convaincue : l'agent m'a répondu « je n'ai pas cette information dans le catalogue » au lieu d'inventer une fiche technique. C'est exactement le comportement que j'attends d'un outil qui parle à mes clients.",
  name: "Sarah B.",
  role: "E-commerce électronique",
  company: "TechnoBoutique",
};

const PILOT_FEATURES = [
  "Agent commercial IA connecté à votre catalogue",
  "CRM complet : leads, contacts, deals, tâches",
  "Lead scoring explicable sur 100 points",
  "Conversations et follow-ups persistants",
  "Isolation multi-tenant stricte",
  "Suite de diagnostics intégrée",
];

function pricingCard(p) {
  return `<div class="price-card${p.highlight ? " highlight" : ""}">
    ${p.highlight ? '<span class="price-badge">Populaire</span>' : ""}
    <h3>${esc(p.name)}</h3>
    <div class="price-amount">${esc(p.price)}${p.per ? `<span class="price-per"> ${esc(p.per)}</span>` : ""}</div>
    <ul class="price-features">${p.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <a class="btn ${p.highlight ? "primary" : "ghost"} block" href="${p.href}">${esc(p.cta)}</a>
  </div>`;
}

function pilotPricing() {
  return `<div class="price-card highlight pilot-card">
    <span class="price-badge">Accès pilote</span>
    <h3>Accès pilote</h3>
    <div class="price-amount">0 €<span class="price-per"> / mois</span></div>
    <p class="muted" style="margin:8px 0 14px">Organisations et utilisateurs illimités, agent IA inclus.</p>
    <code class="pilot-flag">PILOT_MODE = TRUE</code>
    <ul class="price-features">${PILOT_FEATURES.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <a class="btn primary block" href="/register">Créer mon organisation</a>
    <p class="muted-sm" style="margin-top:14px;text-align:center">Aucun paiement, aucune carte bancaire, aucun engagement.<br/>La facturation sera ajoutée après la phase de tests avec les commerçants.</p>
  </div>`;
}

function pricingFromPlans(plans) {
  if (!Array.isArray(plans) || !plans.length) {
    return [
      { name: "Gratuit", price: "0", per: "pour toujours", features: ["1 agent IA", "100 conversations / mois", "1 utilisateur"], cta: "Commencer gratuitement", href: "/register", highlight: false },
      { name: "Starter", price: "25 000", per: "XOF / mois", features: ["1 agent IA", "1 000 conversations / mois", "3 utilisateurs"], cta: "Commencer gratuitement", href: "/register", highlight: false },
      { name: "Business", price: "60 000", per: "XOF / mois", features: ["3 agents IA", "Conversations illimitées", "10 utilisateurs"], cta: "Commencer gratuitement", href: "/register", highlight: true },
      { name: "Entreprise", price: "Sur devis", per: "", features: ["Agents illimités", "SLA dédié", "SSO"], cta: "Nous contacter", href: "/register", highlight: false },
    ];
  }
  return plans.map((p, i) => {
    const custom = p.code === "ENTERPRISE" || (Number(p.price_monthly) === 0 && p.code !== "FREE");
    const price = p.code === "FREE" ? "0" : custom ? "Sur devis" : String(Number(p.price_monthly));
    const per = p.code === "FREE" ? "pour toujours" : custom ? "" : `${p.currency || "USD"} / mois`;
    const features = Array.isArray(p.features) && p.features.length ? p.features : [
      `${p.limits?.leads < 0 ? "Illimité" : p.limits?.leads} leads`,
      `${p.limits?.ai_messages < 0 ? "Illimité" : p.limits?.ai_messages} messages IA / mois`,
    ];
    return {
      name: p.name, price, per, features,
      cta: custom ? "Nous contacter" : "Commencer gratuitement",
      href: "/register",
      highlight: plans.length >= 4 && i === 2,
    };
  });
}

export function landingPage({ plans } = {}) {
  const pilot = isPilotMode();
  const pricingBlock = pilot
    ? `<div class="pricing-grid pilot-grid">${pilotPricing()}</div>`
    : `<div class="pricing-grid">${pricingFromPlans(plans).map(pricingCard).join("")}</div>`;

  const marquee = [...MARQUEE, ...MARQUEE].map((t) => `<span class="marquee-item">${esc(t)}</span>`).join("");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="AI Sales Agent — Un commercial IA qui ne ment jamais. Réponses basées uniquement sur votre catalogue réel : prix, stock, caractéristiques. Lead scoring explicable, CRM inclus, 0 hallucination."/>
<title>AI Sales Agent — Agent commercial IA & CRM</title>
<link rel="stylesheet" href="/style.css"/>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9C%A8%3C/text%3E%3C/svg%3E"/>
<script>(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body class="landing">
<header class="nav">
  <div class="nav-inner">
    <a class="brand" href="/"><span class="brand-mark">✨</span><span class="brand-name">AI Sales Agent</span></a>
    <nav class="nav-links">
      <a href="#fonctionnement">Fonctionnement</a>
      <a href="#tarifs">Tarification</a>
      <a href="#faq">FAQ</a>
    </nav>
    <div class="nav-actions">
      <button class="icon-btn theme-btn" id="themeBtn" aria-label="Changer de thème"></button>
      <a class="btn ghost" href="/login">Se connecter</a>
      <a class="btn primary" href="/register">Créer mon organisation</a>
    </div>
  </div>
</header>

<main>
  <section class="hero">
    <div class="hero-inner">
      <span class="hero-badge">${pilot ? "Pilote gratuit — sans carte bancaire" : "✦ Essai gratuit · Omni-canal · Devis & commandes"}</span>
      <h1>Un commercial IA<br/><span class="grad">qui ne ment jamais</span></h1>
      <p class="hero-sub">L'agent répond à vos prospects 24 h/24 en s'appuyant uniquement sur votre catalogue réel : prix, stock et caractéristiques lus en base. Il qualifie, note et transmet au bon moment — jamais d'invention.</p>
      <div class="hero-cta">
        <a class="btn primary lg" href="/register">Créer mon organisation</a>
        <a class="btn ghost lg" href="#fonctionnement">Voir le fonctionnement</a>
      </div>
      <div class="trust-row">
        ${TRUST.map((t) => `<span class="trust-pill"><span aria-hidden="true">${t.icon}</span> ${esc(t.label)}</span>`).join("")}
      </div>
      <a class="scroll-hint" href="#fonctionnement">Défiler ↓</a>
    </div>
  </section>

  <div class="marquee" aria-hidden="true">
    <div class="marquee-track">${marquee}</div>
  </div>

  <section id="tarifs" class="section alt">
    <div class="section-head">
      <p class="section-kicker">Tarification</p>
      <h2>${pilot ? "Le pilote est gratuit" : "Tarifs simples et transparents"}</h2>
      <p class="muted">${pilot
        ? "Nous construisons le produit avec les commerçants. Toutes les fonctionnalités sont ouvertes, sans carte bancaire et sans limite d'usage pendant le pilote."
        : "Commencez gratuitement, évoluez quand vous grandissez."}</p>
    </div>
    ${pricingBlock}
  </section>

  <section id="fonctionnement" class="section">
    <div class="section-head">
      <p class="section-kicker">Comment ça marche</p>
      <h2>Du message du prospect au lead qualifié</h2>
    </div>
    <div class="steps-grid steps-4">
      ${STEPS.map((s) => `<div class="step-card"><span class="step-n">${s.n}</span><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>`).join("")}
    </div>
  </section>

  <section class="section alt">
    <div class="section-head">
      <h2>Tout ce qu'il faut pour vendre sans inventer</h2>
      <p class="muted">Une plateforme complète, pensée pour les équipes commerciales.</p>
    </div>
    <div class="feature-grid">
      ${FEATURES.map((f) => `<div class="card feature-card"><span class="feature-ico">${f.icon}</span><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div>`).join("")}
    </div>
  </section>

  <section class="section">
    <div class="section-head">
      <p class="section-kicker">Retours du pilote</p>
      <h2>La parole aux commerçants</h2>
    </div>
    <blockquote class="testimonial-card">
      <p>« ${esc(TESTIMONIAL.quote)} »</p>
      <footer>
        <span class="avatar-letter">${esc(TESTIMONIAL.name[0])}</span>
        <span>
          <strong>${esc(TESTIMONIAL.name)}</strong>
          <span class="muted">${esc(TESTIMONIAL.role)} · ${esc(TESTIMONIAL.company)}</span>
        </span>
      </footer>
    </blockquote>
  </section>

  <section id="faq" class="section alt">
    <div class="section-head">
      <p class="section-kicker">Questions fréquentes</p>
      <h2>Questions fréquentes</h2>
    </div>
    <div class="faq-list">
      ${FAQ.map((f) => `<details class="faq-item"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}
    </div>
  </section>

  <section class="cta-band">
    <h2>Le guide de l'agent commercial, offert</h2>
    <p class="muted">Recevez notre guide : comment rédiger un catalogue que l'agent exploite bien, cadrer son ton, et interpréter le lead scoring.</p>
    <form class="guide-form" method="post" action="/api/register" onsubmit="location.href='/register';return false;">
      <a class="btn primary lg" href="/register">Recevoir le guide</a>
    </form>
    <p class="muted-sm">Un e-mail par semaine maximum. Désinscription en un clic.</p>
  </section>
</main>

<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <span class="brand"><span class="brand-mark">✨</span><span class="brand-name">AI Sales Agent</span></span>
      <p class="muted">Un commercial IA qui ne ment jamais.</p>
    </div>
    <div class="footer-cols">
      <div><h4>Produit</h4><a href="#fonctionnement">Fonctionnement</a><a href="#tarifs">Tarification</a><a href="#faq">FAQ</a></div>
      <div><h4>Ressources</h4><a href="/login">Se connecter</a><a href="/register">Créer un compte</a><a href="/dashboard/diagnostics">Diagnostics</a></div>
      <div><h4>Légal</h4><a href="#">Confidentialité</a><a href="#">Conditions</a></div>
    </div>
  </div>
  <div class="footer-base muted">© 2026 AI Sales Agent — Lomé · Paris</div>
</footer>
<script src="/landing.js"></script>
</body>
</html>`;
}
