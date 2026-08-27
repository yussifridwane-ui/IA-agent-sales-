// server/views/settings.js — pages Paramètres (Company, Team, Profile, Security)
import { esc } from "../security.js";
import { appLayout } from "./app.js";
import { ROLE_LABELS, ROLES, can } from "../rbac.js";
import { COUNTRIES, CURRENCY_BY_COUNTRY, INDUSTRIES } from "../db.js";

const SETTINGS_TABS = [
  { label: "Company", href: "/settings/company" },
  { label: "Team", href: "/settings/team" },
  { label: "Profile", href: "/settings/profile" },
  { label: "Security", href: "/settings/security" },
];

function settingsShell({ user, org, role, path, csrf, title, content }) {
  return appLayout({
    title, user, org, role, path, csrf,
    content: `<nav class="settings-tabs">
      ${SETTINGS_TABS.map((t) => `<a class="tab${t.href === path ? " is-active" : ""}" href="${t.href}">${t.label}</a>`).join("")}
    </nav>
    ${content}`,
  });
}

/* ---------- Company ---------- */
export function companyPage({ user, org, role, csrf, plan, error = "" }) {
  const cOpts = COUNTRIES.map((c) => `<option value="${c.code}"${org.country === c.code ? " selected" : ""}>${esc(c.name)} (${c.code})</option>`).join("");
  const iOpts = INDUSTRIES.map((i) => `<option${org.industry === i ? " selected" : ""}>${esc(i)}</option>`).join("");
  const curOpts = ["XOF", "XAF", "CDF", "EUR", "USD", "GBP", "CAD", "MAD", "DZD", "TND", "CHF"].map((c) => `<option value="${c}"${org.currency === c ? " selected" : ""}>${c}</option>`).join("");
  return settingsShell({
    user, org, role, path: "/settings/company", csrf, title: "Paramètres — Company",
    content: `<div class="card form-card">
      <div class="card-head"><h3>Entreprise</h3><span class="plan-badge">Plan ${esc(plan || "FREE")}</span></div>
      ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
      <form method="POST" action="/api/settings/company" data-fetch class="form">
        <div class="field-2col">
          <div class="field"><label for="name">Nom</label><input id="name" name="name" value="${esc(org.name)}" required maxlength="80"/></div>
          <div class="field"><label for="logo_url">Logo (URL)</label><input id="logo_url" name="logo_url" type="url" value="${esc(org.logo_url || "")}" placeholder="https://…"/></div>
        </div>
        <div class="field-2col">
          <div class="field"><label for="country">Pays</label><select id="country" name="country">${cOpts}</select></div>
          <div class="field"><label for="industry">Secteur</label><select id="industry" name="industry">${iOpts}</select></div>
        </div>
        <div class="field"><label for="currency">Devise</label><select id="currency" name="currency">${curOpts}</select></div>
        <div class="form-row"><button type="submit" class="btn primary">Enregistrer</button></div>
      </form>
      <p class="field-hint">Slug de l'organisation : <code>${esc(org.slug)}</code></p>
    </div>`,
  });
}

/* ---------- Team ---------- */
export function teamPage({ user, org, role, csrf, members, error = "", flash = "" }) {
  const canInvite = can(role, "team:invite");
  const roleOpts = ROLES.filter((r) => r !== "OWNER")
    .map((r) => `<option value="${r}">${esc(ROLE_LABELS[r])}</option>`)
    .join("");
  return settingsShell({
    user, org, role, path: "/settings/team", csrf, title: "Paramètres — Team",
    content: `
    ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
    ${flash ? `<div class="alert success">${esc(flash)}</div>` : ""}
    <div class="card form-card">
      <div class="card-head"><h3>Inviter un membre</h3><span class="muted muted-sm">L'invitation est immédiate si l'e-mail existe déjà.</span></div>
      ${canInvite ? `
      <form method="POST" action="/api/team/invites" data-fetch class="form form-inline">
        <input type="email" name="email" placeholder="nom@entreprise.com" required aria-label="E-mail à inviter"/>
        <select name="role" aria-label="Rôle">${roleOpts}</select>
        <button type="submit" class="btn primary">Inviter</button>
      </form>` : `<p class="muted">Votre rôle (${esc(ROLE_LABELS[role])}) ne permet pas d'inviter des membres.</p>`}
    </div>
    <div class="card form-card">
      <div class="card-head"><h3>Membres</h3><span class="muted muted-sm">${members.length} membre(s)</span></div>
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>Statut</th><th>Date d'ajout</th><th class="right">Actions</th></tr></thead>
        <tbody>
        ${members
          .map((m) => {
            const name = m.user_first ? `${m.user_first} ${m.user_last}` : m.email;
            // Le bouton « Retirer » n'apparaît que si le rôle de l'acteur le permet
            // (permission team:remove + rang supérieur au membre, ou OWNER).
            const canManage = can(role, "team:remove") && m.user_id && m.user_id !== user.id && (role === "OWNER" || roleRankOk(role, m.role));
            return `<tr>
              <td class="strong">${esc(name)}${m.user_id === user.id ? ' <span class="tag">vous</span>' : ""}</td>
              <td>${esc(m.email || "—")}</td>
              <td>${m.user_id ? roleCell(m, role) : `<span class="role-badge">${esc(ROLE_LABELS[m.role])}</span>`}</td>
              <td>${m.status === "invited" ? '<span class="tag warn">invité</span>' : '<span class="tag ok">actif</span>'}</td>
              <td class="muted-sm">${esc(new Date(m.created_at).toLocaleDateString("fr-FR"))}</td>
              <td class="right">${
                m.user_id && canManage
                  ? `<button class="btn small danger" data-confirm="Retirer ce membre ?" data-fetch-action="/api/team/members/${m.id}/remove" data-method="POST">Retirer</button>`
                  : ""
              }</td>
            </tr>`;
          })
          .join("")}
        </tbody>
      </table>
      </div>
      <p class="field-hint">Rôles : OWNER (tout) · ADMIN (entreprise + équipe) · MANAGER (commercial) · SALES_AGENT (fonctions commerciales) · VIEWER (lecture seule).</p>
    </div>`,
  });
}

function roleRankOk(actorRole, targetRole) {
  const RANK = { OWNER: 5, ADMIN: 4, MANAGER: 3, SALES_AGENT: 2, VIEWER: 1 };
  return RANK[actorRole] > RANK[targetRole];
}

function roleCell(m, actorRole) {
  // Un rôle n'est modifiable que s'il est strictement inférieur au rang de l'acteur.
  const changeable = roleRankOk(actorRole, m.role);
  if (!changeable) return `<span class="role-badge">${esc(ROLE_LABELS[m.role])}</span>`;
  const opts = ROLES.filter((r) => r !== "OWNER" && r !== m.role && roleRankOk(actorRole, r))
    .map((r) => `<option value="${r}">${esc(ROLE_LABELS[r])}</option>`)
    .join("");
  return `<form method="POST" action="/api/team/members/${m.id}/role" data-fetch class="form-inline" style="display:inline">
    <select name="role" class="role-select" aria-label="Changer le rôle"><option value="${m.role}" selected hidden>${esc(ROLE_LABELS[m.role])}</option>${opts}</select>
    <button type="submit" class="btn small ghost" title="Appliquer le rôle">OK</button>
  </form>`;
}

/* ---------- Profile ---------- */
export function profilePage({ user, org, role, csrf, error = "" }) {
  return settingsShell({
    user, org, role, path: "/settings/profile", csrf, title: "Paramètres — Profile",
    content: `<div class="card form-card">
      <div class="card-head"><h3>Mon profil</h3></div>
      ${error ? `<div class="alert error">${esc(error)}</div>` : ""}
      <form method="POST" action="/api/settings/profile" data-fetch class="form">
        <div class="field-2col">
          <div class="field"><label for="first_name">Prénom</label><input id="first_name" name="first_name" value="${esc(user.first_name)}" required maxlength="50"/></div>
          <div class="field"><label for="last_name">Nom</label><input id="last_name" name="last_name" value="${esc(user.last_name)}" required maxlength="50"/></div>
        </div>
        <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" value="${esc(user.email)}" required/></div>
        <div class="field"><label for="phone">Téléphone</label><input id="phone" name="phone" type="tel" value="${esc(user.phone || "")}"/></div>
        <div class="form-row"><button type="submit" class="btn primary">Enregistrer</button></div>
      </form>
    </div>`,
  });
}

/* ---------- Security ---------- */
export function securityPage({ user, org, role, csrf, sessions, flash = "" }) {
  return settingsShell({
    user, org, role, path: "/settings/security", csrf, title: "Paramètres — Security",
    content: `
    ${flash ? `<div class="alert success">${esc(flash)}</div>` : ""}
    <div class="card form-card">
      <div class="card-head"><h3>Changer le mot de passe</h3></div>
      <form method="POST" action="/api/settings/security/password" data-fetch class="form">
        <div class="field"><label for="current_password">Mot de passe actuel</label><input id="current_password" name="current_password" type="password" required autocomplete="current-password"/></div>
        <div class="field-2col">
          <div class="field"><label for="new_password">Nouveau mot de passe</label><input id="new_password" name="new_password" type="password" required minlength="8" autocomplete="new-password"/></div>
          <div class="field"><label for="confirm_password">Confirmer</label><input id="confirm_password" name="confirm_password" type="password" required autocomplete="new-password"/></div>
        </div>
        <div class="form-row"><button type="submit" class="btn primary">Mettre à jour</button></div>
      </form>
    </div>
    <div class="card form-card">
      <div class="card-head"><h3>Sessions actives</h3><span class="muted muted-sm">${sessions.length} session(s)</span></div>
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Appareil</th><th>IP</th><th>Depuis</th><th>Expire</th><th class="right"></th></tr></thead>
        <tbody>
        ${sessions
          .map((s) => {
            const ua = s.user_agent || "Navigateur inconnu";
            const isCurrent = s.current;
            return `<tr>
              <td class="strong">${esc(ua)}${isCurrent ? ' <span class="tag ok">actuelle</span>' : ""}</td>
              <td class="muted-sm">${esc(s.ip || "—")}</td>
              <td class="muted-sm">${esc(new Date(s.created_at).toLocaleString("fr-FR"))}</td>
              <td class="muted-sm">${esc(new Date(s.expires_at).toLocaleDateString("fr-FR"))}</td>
              <td class="right"></td>
            </tr>`;
          })
          .join("")}
        </tbody>
      </table>
      </div>
      <div class="form-row">
        <form method="POST" action="/api/settings/sessions/revoke-others" data-fetch><button type="submit" class="btn ghost">Révoquer les autres sessions</button></form>
        <form method="POST" action="/api/logout" data-fetch><button type="submit" class="btn danger">Se déconnecter</button></form>
      </div>
    </div>`,
  });
}
