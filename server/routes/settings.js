// server/routes/settings.js — Paramètres (company, team, profile, security) + audit
import { companyPage, teamPage, profilePage, securityPage } from "../views/settings.js";
import {
  nowIso, uuid, cleanText, isValidEmail, isValidPhone, isValidUrl,
  verifyPassword, hashPassword,
} from "../security.js";
import { logAudit } from "../audit.js";
import { can, canManageMember, canAssignRole, isRoleAssignable, ROLES } from "../rbac.js";
import { checkLimit } from "../billing.js";
import { COUNTRIES, CURRENCY_BY_COUNTRY, INDUSTRIES, PLANS } from "../db.js";

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));
const CURRENCIES = new Set(["XOF", "XAF", "CDF", "EUR", "USD", "GBP", "CAD", "MAD", "DZD", "TND", "CHF"]);

function requireOrgFor(ctx) {
  if (!ctx.user) {
    if (ctx.json) return ctx.sendJSON(401, { error: "Connexion requise." });
    ctx.redirect("/login");
    return null;
  }
  if (!ctx.org || !ctx.member) {
    if (ctx.json) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
    ctx.redirect("/login");
    return null;
  }
  if (!ctx.org.onboarding_completed && !ctx.json) {
    ctx.redirect("/onboarding");
    return null;
  }
  return ctx.org;
}

/**
 * Multi-tenant : résout l'organisation demandée (paramètre optionnel
 * organization_id) et refuse tout accès d'un utilisateur non membre.
 * C'est LE contrôle côté serveur — le frontend n'est jamais fait confiance.
 */
function scopedOrg(ctx) {
  const requested = ctx.query.organization_id;
  if (requested) {
    const member = ctx.db
      .prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .get(String(requested), ctx.user.id);
    if (!member) return { org: null, member: null, forbidden: true };
    const org = ctx.db.prepare("SELECT * FROM organizations WHERE id = ?").get(String(requested));
    if (!org) return { org: null, member: null, forbidden: true };
    return { org, member, forbidden: false };
  }
  if (!ctx.org || !ctx.member) return { org: null, member: null, forbidden: true };
  return { org: ctx.org, member: ctx.member, forbidden: false };
}

function memberList(db, orgId) {
  return db
    .prepare(
      `SELECT om.*, u.first_name AS user_first, u.last_name AS user_last, u.email AS user_email
       FROM organization_members om
       LEFT JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = ?
       ORDER BY om.created_at ASC`
    )
    .all(orgId);
}

export async function handlePage(ctx) {
  const { path, method } = ctx;
  if (method !== "GET") return false;
  if (!path.startsWith("/settings")) return false;

  const org = requireOrgFor(ctx);
  if (!org) return;
  const { user, org: o, member, csrf, db } = ctx;
  const sub = db.prepare("SELECT * FROM subscriptions WHERE organization_id = ?").get(o.id);
  const plan = sub?.plan || "FREE";

  if (path === "/settings") {
    ctx.redirect("/settings/company");
    return;
  }
  if (path === "/settings/company") {
    return ctx.sendHTML(200, companyPage({ user, org: o, role: member.role, csrf, plan }));
  }
  if (path === "/settings/team") {
    const members = memberList(db, o.id).map((m) => ({ ...m, email: m.user_email || m.email }));
    return ctx.sendHTML(200, teamPage({ user, org: o, role: member.role, csrf, members }));
  }
  if (path === "/settings/profile") {
    return ctx.sendHTML(200, profilePage({ user, org: o, role: member.role, csrf }));
  }
  if (path === "/settings/security") {
    const sessions = db
      .prepare("SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC")
      .all(user.id, new Date().toISOString())
      .map((s) => ({ ...s, current: s.id === ctx.session.id }));
    return ctx.sendHTML(200, securityPage({ user, org: o, role: member.role, csrf, sessions }));
  }
  return false;
}

export async function handleApi(ctx) {
  const { path, method, body, db, user, member } = ctx;
  if (!path.startsWith("/api/")) return false;
  if (!user) return ctx.sendJSON(401, { error: "Connexion requise." });

  /* ---------- COMPANY ---------- */
  // POST (form HTML) + PUT (clients JSON / fetch)
  if ((method === "POST" || method === "PUT") && path === "/api/settings/company") {
    const { org, member: m, forbidden } = scopedOrg(ctx);
    if (forbidden) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
    if (!can(m.role, "org:update")) return ctx.sendJSON(403, { error: "Permission insuffisante (org:update)." });
    const name = cleanText(body.name, 80);
    const logo_url = cleanText(body.logo_url, 500);
    const country = String(body.country || "").toUpperCase();
    const industry = cleanText(body.industry, 40);
    const currency = String(body.currency || "").toUpperCase();
    if (name.length < 2) return ctx.sendJSON(400, { error: "Nom de l'entreprise invalide." });
    if (!isValidUrl(logo_url)) return ctx.sendJSON(400, { error: "URL du logo invalide." });
    if (!COUNTRY_CODES.has(country)) return ctx.sendJSON(400, { error: "Pays non reconnu." });
    if (!INDUSTRIES.includes(industry)) return ctx.sendJSON(400, { error: "Secteur non reconnu." });
    if (!CURRENCIES.has(currency)) return ctx.sendJSON(400, { error: "Devise non reconnue." });
    const now = nowIso();
    db.prepare(
      "UPDATE organizations SET name = ?, logo_url = ?, country = ?, industry = ?, currency = ?, updated_at = ? WHERE id = ?"
    ).run(name, logo_url || null, country, industry, currency, now, org.id);
    logAudit(db, { organizationId: org.id, userId: user.id, action: "UPDATE_ORGANIZATION", resourceType: "organization", resourceId: org.id, metadata: { fields: ["name", "logo_url", "country", "industry", "currency"] } });
    return ctx.sendJSON(200, { message: "Entreprise mise à jour." });
  }

  /* ---------- PROFILE ---------- */
  if (method === "POST" && path === "/api/settings/profile") {
    const first_name = cleanText(body.first_name, 50);
    const last_name = cleanText(body.last_name, 50);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
    const phone = cleanText(body.phone, 20);
    if (!first_name || !last_name) return ctx.sendJSON(400, { error: "Prénom et nom sont requis." });
    if (!isValidEmail(email)) return ctx.sendJSON(400, { error: "Adresse e-mail invalide." });
    if (!isValidPhone(phone)) return ctx.sendJSON(400, { error: "Téléphone invalide." });
    const clash = db.prepare("SELECT 1 FROM users WHERE email = ? AND id != ?").get(email, user.id);
    if (clash) return ctx.sendJSON(409, { error: "Cet e-mail est déjà utilisé par un autre compte." });
    db.prepare("UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, updated_at = ? WHERE id = ?")
      .run(first_name, last_name, email, phone || null, nowIso(), user.id);
    return ctx.sendJSON(200, { message: "Profil mis à jour." });
  }

  /* ---------- SECURITY : mot de passe ---------- */
  if (method === "POST" && path === "/api/settings/security/password") {
    const current = String(body.current_password || "");
    const next = String(body.new_password || "");
    const confirm = String(body.confirm_password || "");
    if (!verifyPassword(current, user.password_hash))
      return ctx.sendJSON(401, { error: "Mot de passe actuel incorrect." });
    if (next.length < 8 || next.length > 72)
      return ctx.sendJSON(400, { error: "Le nouveau mot de passe doit contenir entre 8 et 72 caractères." });
    if (next !== confirm) return ctx.sendJSON(400, { error: "Les deux mots de passe ne correspondent pas." });
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hashPassword(next), nowIso(), user.id);
    const orgScope = scopedOrg(ctx);
    if (!orgScope.forbidden) {
      logAudit(db, { organizationId: orgScope.org.id, userId: user.id, action: "PASSWORD_CHANGE", resourceType: "user", resourceId: user.id });
    }
    return ctx.sendJSON(200, { message: "Mot de passe mis à jour." });
  }

  /* ---------- SECURITY : sessions ---------- */
  if (method === "GET" && path === "/api/settings/sessions") {
    const rows = db.prepare("SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC").all(user.id, new Date().toISOString());
    return ctx.sendJSON(200, {
      sessions: rows.map((s) => ({ id: s.id, user_agent: s.user_agent, ip: s.ip, created_at: s.created_at, expires_at: s.expires_at, current: s.id === ctx.session.id })),
    });
  }
  if (method === "POST" && path === "/api/settings/sessions/revoke-others") {
    const r = db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(user.id, ctx.session.id);
    const orgScope = scopedOrg(ctx);
    if (!orgScope.forbidden) logAudit(db, { organizationId: orgScope.org.id, userId: user.id, action: "SESSIONS_REVOKED", resourceType: "session", metadata: { revoked: r.changes } });
    return ctx.sendJSON(200, { message: `Sessions révoquées : ${r.changes}.` });
  }

  /* ---------- TEAM ---------- */
  if (method === "GET" && path === "/api/team") {
    const { org, member: m, forbidden } = scopedOrg(ctx);
    if (forbidden) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
    const rows = memberList(db, org.id).map((x) => ({
      id: x.id,
      user_id: x.user_id || null,
      name: x.user_first ? `${x.user_first} ${x.user_last}` : x.email,
      email: x.user_email || x.email,
      role: x.role,
      status: x.status,
      created_at: x.created_at,
    }));
    return ctx.sendJSON(200, { organization: { id: org.id, name: org.name }, role: m.role, members: rows });
  }

  if (method === "POST" && path === "/api/team/invites") {
    const { org, member: m, forbidden } = scopedOrg(ctx);
    if (forbidden) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
    if (!can(m.role, "team:invite")) return ctx.sendJSON(403, { error: "Permission insuffisante (team:invite)." });
    // Phase 8 — limite du plan (utilisateurs actifs + invitation)
    const limUser = checkLimit(ctx.db, org.id, "users");
    if (!limUser.ok) return ctx.sendJSON(403, { error: limUser.error, plan: limUser.plan, limit: limUser.limit, used: limUser.used });
    const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
    const role = String(body.role || "").toUpperCase();
    if (!isValidEmail(email)) return ctx.sendJSON(400, { error: "Adresse e-mail invalide." });
    if (!ROLES.includes(role) || !isRoleAssignable(role)) return ctx.sendJSON(400, { error: "Rôle non assignable (OWNER exclu)." });
    if (!canAssignRole(m.role, role)) return ctx.sendJSON(403, { error: "Vous ne pouvez pas attribuer ce rôle." });

    const now = nowIso();
    const existingUser = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (existingUser) {
      const already = db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(org.id, existingUser.id);
      if (already) return ctx.sendJSON(409, { error: "Cet utilisateur est déjà membre de l'organisation." });
      db.prepare("INSERT INTO organization_members (id, organization_id, user_id, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
        .run(uuid(), org.id, existingUser.id, role, now);
      logAudit(db, { organizationId: org.id, userId: user.id, action: "ADD_MEMBER", resourceType: "member", resourceId: existingUser.id, metadata: { email, role, invited: false } });
      return ctx.sendJSON(200, { message: `Compte existant : ${email} a été ajouté en ${role}.` });
    }
    const pending = db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND email = ? AND status = 'invited'").get(org.id, email);
    if (pending) return ctx.sendJSON(409, { error: "Une invitation est déjà en attente pour cet e-mail." });
    db.prepare("INSERT INTO organization_members (id, organization_id, user_id, email, role, status, created_at) VALUES (?, ?, NULL, ?, ?, 'invited', ?)")
      .run(uuid(), org.id, email, role, now);
    logAudit(db, { organizationId: org.id, userId: user.id, action: "ADD_MEMBER", resourceType: "member", metadata: { email, role, invited: true } });
    return ctx.sendJSON(200, { message: `Invitation enregistrée pour ${email} (rôle ${role}). L'utilisateur sera relié automatiquement à l'inscription.` });
  }

  /* ---------- TEAM : rôle & retrait ---------- */
  const memberAction = path.match(/^\/api\/team\/members\/([a-f0-9-]+)\/(role|remove)$/);
  if (method === "POST" && memberAction) {
    const memberId = memberAction[1];
    const action = memberAction[2];
    const { org, member: m, forbidden } = scopedOrg(ctx);
    if (forbidden) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
    const target = db.prepare("SELECT * FROM organization_members WHERE id = ? AND organization_id = ?").get(memberId, org.id);
    if (!target) return ctx.sendJSON(404, { error: "Membre introuvable." });
    if (!target.user_id) return ctx.sendJSON(400, { error: "Ce membre n'est pas encore connecté (invitation en attente)." });
    if (!canManageMember(m.role, target.role, user.id, target.user_id))
      return ctx.sendJSON(403, { error: "Vous ne pouvez pas gérer ce membre." });

    if (action === "role") {
      if (!can(m.role, "role:change")) return ctx.sendJSON(403, { error: "Permission insuffisante (role:change)." });
      const newRole = String(body.role || "").toUpperCase();
      if (!ROLES.includes(newRole)) return ctx.sendJSON(400, { error: "Rôle invalide." });
      if (!isRoleAssignable(newRole)) return ctx.sendJSON(403, { error: "Le rôle OWNER n'est pas assignable." });
      if (!canAssignRole(m.role, newRole)) return ctx.sendJSON(403, { error: "Vous ne pouvez pas attribuer ce rôle." });
      if (newRole === target.role) return ctx.sendJSON(400, { error: "Ce membre a déjà ce rôle." });
      db.prepare("UPDATE organization_members SET role = ? WHERE id = ?").run(newRole, memberId);
      logAudit(db, { organizationId: org.id, userId: user.id, action: "ROLE_CHANGE", resourceType: "member", resourceId: memberId, metadata: { from: target.role, to: newRole, target: target.user_id } });
      return ctx.sendJSON(200, { message: `Rôle mis à jour : ${newRole}.` });
    }

    if (action === "remove") {
      if (!can(m.role, "team:remove")) return ctx.sendJSON(403, { error: "Permission insuffisante (team:remove)." });
      if (target.role === "OWNER") {
        const owners = db.prepare("SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND role = 'OWNER' AND status = 'active'").get(org.id).n;
        if (owners <= 1) return ctx.sendJSON(400, { error: "Impossible de retirer le dernier OWNER." });
      }
      db.prepare("DELETE FROM organization_members WHERE id = ?").run(memberId);
      logAudit(db, { organizationId: org.id, userId: user.id, action: "REMOVE_MEMBER", resourceType: "member", resourceId: memberId, metadata: { role: target.role, target: target.user_id } });
      return ctx.sendJSON(200, { message: "Membre retiré." });
    }
  }

  /* ---------- AUDIT ---------- */
  if (method === "GET" && path === "/api/audit") {
    const { org, member: m, forbidden } = scopedOrg(ctx);
    if (forbidden) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
    if (!can(m.role, "audit:read")) return ctx.sendJSON(403, { error: "Permission insuffisante (audit:read)." });
    const limit = Math.min(Math.max(parseInt(ctx.query.limit || "50", 10) || 50, 1), 100);
    const rows = db.prepare("SELECT * FROM audit_logs WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?").all(org.id, limit);
    return ctx.sendJSON(200, {
      organization: { id: org.id, name: org.name },
      logs: rows.map((r) => ({
        id: r.id, organizationId: r.organization_id, action: r.action,
        resourceType: r.resource_type, resourceId: r.resource_id,
        userId: r.user_id,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        createdAt: r.created_at,
      })),
    });
  }

  return false;
}
