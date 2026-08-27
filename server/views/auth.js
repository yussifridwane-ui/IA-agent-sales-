// server/views/auth.js — pages d'authentification + onboarding
import { esc } from "../security.js";
import { COUNTRIES, CURRENCY_BY_COUNTRY, INDUSTRIES, GOALS } from "../db.js";

function authLayout({ title, content, note = "", csrf = "" }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="csrf-token" content="${esc(csrf)}"/>
<title>${esc(title)} · AI Sales Agent</title>
<link rel="stylesheet" href="/style.css"/>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9C%A8%3C/text%3E%3C/svg%3E"/>
<script>(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body class="auth-page">
<button class="icon-btn theme-btn fixed-theme" id="themeBtn" aria-label="Changer de thème"></button>
<div class="auth-card">
  <a class="brand auth-brand" href="/"><span class="brand-mark">✨</span><span class="brand-name">AI Sales Agent</span></a>
  <h1>${esc(title)}</h1>
  ${note ? `<p class="muted auth-note">${note}</p>` : ""}
  ${content}
</div>
<div id="toasts" aria-live="polite"></div>
<script src="/app.js"></script>
</body>
</html>`;
}

function field(label, control, hint = "", error = "") {
  // `control` : chaîne HTML (<input>, <select>…)
  // ou { html, id?, error?, hint? } pour rattacher erreur / for=
  let html = control;
  let id = null;
  let err = error;
  let h = hint;
  if (control && typeof control === "object") {
    html = control.html ?? "";
    id = control.id || null;
    if (control.error) err = control.error;
    if (control.hint) h = control.hint;
  }
  // Dérive l'id depuis name="…" / id="…" si absent
  if (!id && typeof html === "string") {
    const m = html.match(/\bid=["']([^"']+)["']/);
    if (m) id = m[1];
  }
  return `<div class="field">
    <label${id ? ` for="${esc(id)}"` : ""}>${label}</label>
    ${html}
    ${h ? `<span class="field-hint">${esc(h)}</span>` : ""}
    ${err ? `<span class="field-error">${esc(err)}</span>` : ""}
  </div>`;
}

const input = (id, { type = "text", value = "", placeholder = "", required = false, autocomplete = "" } = {}) =>
  `<input id="${id}" name="${id}" type="${type}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}"${required ? " required" : ""}${autocomplete ? ` autocomplete="${autocomplete}"` : ""}/>`;

export function loginPage({ error, email = "" } = {}) {
  return authLayout({
    title: "Se connecter",
    note: "Bienvenue ! Connectez-vous pour accéder à votre espace.",
    content: `
    ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
    <form method="POST" action="/api/login" data-fetch class="form" novalidate>
      ${field("E-mail", input("email", { type: "email", value: email, placeholder: "vous@entreprise.com", required: true, autocomplete: "email" }))}
      ${field("Mot de passe", input("password", { type: "password", placeholder: "••••••••", required: true, autocomplete: "current-password" }))}
      <div class="form-row">
        <a class="link" href="/forgot-password">Mot de passe oublié ?</a>
      </div>
      <button type="submit" class="btn primary block">Se connecter</button>
    </form>
    <p class="auth-switch muted">Pas encore de compte ? <a class="link" href="/register">Créer mon organisation</a></p>`,
  });
}

export function registerPage({ error = null, values = {} } = {}) {
  const e = (k) => (error && error.field === k ? error.message : "");
  const cOpts = COUNTRIES.map((c) => `<option value="${c.code}"${values.country === c.code ? " selected" : ""}>${esc(c.name)} (${c.code})</option>`).join("");
  const iOpts = INDUSTRIES.map((i) => `<option${values.industry === i ? " selected" : ""}>${esc(i)}</option>`).join("");
  return authLayout({
    title: "Créer votre organisation",
    note: "2 minutes suffisent. Aucune carte bancaire requise — pilote gratuit.",
    content: `
    ${error && error.field === "__form" ? `<div class="alert error">${esc(error.message)}</div>` : ""}
    <form method="POST" action="/api/register" data-fetch class="form" novalidate>
      <div class="field-2col">
        ${field("Prénom", input("first_name", { value: values.first_name, placeholder: "Aïcha", required: true, autocomplete: "given-name" }), "", e("first_name"))}
        ${field("Nom", input("last_name", { value: values.last_name, placeholder: "Kossou", required: true, autocomplete: "family-name" }), "", e("last_name"))}
      </div>
      ${field("E-mail", input("email", { type: "email", value: values.email, placeholder: "vous@entreprise.com", required: true, autocomplete: "email" }), "", e("email"))}
      ${field("Téléphone", input("phone", { type: "tel", value: values.phone, placeholder: "+228 90 00 00 00", autocomplete: "tel" }), "", e("phone"))}
      ${field("Mot de passe", input("password", { type: "password", placeholder: "8 caractères minimum", required: true, autocomplete: "new-password" }), "", e("password"))}
      ${field("Nom de l'entreprise", input("company", { value: values.company, placeholder: "Ex. : Kossou & Fils SARL", required: true, autocomplete: "organization" }), "", e("company"))}
      <div class="field-2col">
        ${field("Pays", `<select id="country" name="country" required>${cOpts}</select>`, "", e("country"))}
        ${field("Secteur", `<select id="industry" name="industry" required><option value="" disabled selected>Choisir…</option>${iOpts}</select>`, "", e("industry"))}
      </div>
      <button type="submit" class="btn primary block">Créer mon organisation</button>
      <p class="field-hint center">En vous inscrivant, vous acceptez nos conditions d'utilisation.</p>
    </form>
    <p class="auth-switch muted">Déjà un compte ? <a class="link" href="/login">Se connecter</a></p>`,
  });
}

export function forgotPage({ message = "", error = "" } = {}) {
  return authLayout({
    title: "Mot de passe oublié",
    note: "Indiquez votre e-mail : nous vous enverrons un lien de réinitialisation.",
    content: `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ""}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
    <form method="POST" action="/api/forgot-password" data-fetch class="form" novalidate>
      ${field("E-mail", input("email", { type: "email", placeholder: "vous@entreprise.com", required: true, autocomplete: "email" }))}
      <button type="submit" class="btn primary block">Envoyer le lien de réinitialisation</button>
    </form>
    <p class="auth-switch muted">Vous vous souvenez ? <a class="link" href="/login">Se connecter</a></p>`,
  });
}

export function resetPage({ token = "", message = "", error = "" } = {}) {
  return authLayout({
    title: "Réinitialiser le mot de passe",
    content: `
    ${message ? `<div class="alert success">${esc(message)}</div><a class="btn primary block" href="/login">Se connecter</a>` : `
    ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
    <form method="POST" action="/api/reset-password" data-fetch class="form" novalidate>
      <input type="hidden" name="token" value="${esc(token)}"/>
      ${field("Nouveau mot de passe", input("password", { type: "password", placeholder: "8 caractères minimum", required: true, autocomplete: "new-password" }))}
      ${field("Confirmer le mot de passe", input("password2", { type: "password", placeholder: "Répétez le mot de passe", required: true, autocomplete: "new-password" }))}
      <button type="submit" class="btn primary block">Réinitialiser</button>
    </form>`}
    <p class="auth-switch muted"><a class="link" href="/login">← Retour à la connexion</a></p>`,
  });
}

/* ---------- Onboarding (assistant 7 étapes) ---------- */
export const ONBOARDING_STEPS = [
  "Bienvenue",
  "Entreprise",
  "Secteur",
  "Pays",
  "Devise",
  "Objectif",
  "Terminer",
];

export function onboardingPage({ org, ob, error = "", csrf = "" }) {
  const step = Math.min(Math.max(ob.step, 0), 6); // index 0..6
  const pct = ((step + 1) / 7) * 100;
  const cOpts = COUNTRIES.map((c) => `<option value="${c.code}"${ob.country === c.code ? " selected" : ""}>${esc(c.name)} (${c.code})</option>`).join("");
  const iOpts = INDUSTRIES.map((i) => `<option${ob.industry === i ? " selected" : ""}>${esc(i)}</option>`).join("");
  const curDefault = ob.currency || CURRENCY_BY_COUNTRY[ob.country || org.country] || "XOF";
  const curOpts = ["XOF", "XAF", "CDF", "EUR", "USD", "GBP", "CAD", "MAD", "DZD", "TND", "CHF"].map((c) => `<option value="${c}"${curDefault === c ? " selected" : ""}>${c}</option>`).join("");
  const gOpts = GOALS.map((g) => `<label class="radio-card"><input type="radio" name="goal" value="${esc(g)}"${ob.goal === g ? " checked" : ""}/><span>${esc(g)}</span></label>`).join("");

  const bodies = [
    `<div class="ob-welcome">
       <span class="ob-logo">✨</span>
       <h3>Bienvenue dans AI Sales Agent</h3>
       <p class="muted">Votre commercial IA est presque prêt. Répondez à quelques questions (2 minutes) pour le configurer à votre image.</p>
     </div>`,
    `${field("Nom de l'entreprise", input("company_name", { value: org.name, required: true }))}`,
    `${field("Secteur d'activité", `<select id="industry" name="industry" required><option value="" disabled${ob.industry ? "" : " selected"}>Choisir…</option>${iOpts}</select>`)}`,
    `${field("Pays", `<select id="country" name="country" required><option value="" disabled${ob.country ? "" : " selected"}>Choisir…</option>${cOpts}</select>`, ob.country === "TG" ? "Togo détecté → devise par défaut : XOF" : "")}`,
    `${field("Devise", `<select id="currency" name="currency" required>${curOpts}</select>`, "Utilisée pour vos rapports et tarifs.")}`,
    `<div class="ob-goal-grid">${gOpts}</div>`,
    `<div class="ob-summary">
       <div class="ob-line"><span>Entreprise</span><b>${esc(org.name)}</b></div>
       <div class="ob-line"><span>Secteur</span><b>${esc(ob.industry || org.industry || "—")}</b></div>
       <div class="ob-line"><span>Pays</span><b>${esc(ob.country || org.country || "—")}</b></div>
       <div class="ob-line"><span>Devise</span><b>${esc(ob.currency || org.currency)}</b></div>
       <div class="ob-line"><span>Objectif</span><b>${esc(ob.goal || "—")}</b></div>
       <p class="muted">C'est tout ! Votre agent est configuré. Vous pourrez modifier ces informations à tout moment dans Paramètres.</p>
     </div>`,
  ];

  return authLayout({
    title: ONBOARDING_STEPS[step],
    csrf,
    content: `
    <div class="ob-progress" aria-label="Progression">
      <div class="ob-progress-fill" style="width:${pct}%"></div>
    </div>
    <div class="ob-step-label muted">Étape ${step + 1} / 7 — ${esc(ONBOARDING_STEPS[step])}</div>
    ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
    <form method="POST" action="/api/onboarding" data-fetch class="form">
      <input type="hidden" name="step" value="${step + 1}"/>
      ${bodies[step]}
      <div class="form-row ob-actions">
        ${step > 0 ? `<a class="btn ghost" href="/onboarding">← Retour</a>` : ""}
        <button type="submit" class="btn primary">${step === 6 ? "Terminer et accéder au dashboard" : "Continuer →"}</button>
      </div>
    </form>`,
  });
}
