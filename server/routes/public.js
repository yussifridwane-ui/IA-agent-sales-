// server/routes/public.js — landing, pages & API d'authentification, onboarding
import { randomBytes } from "node:crypto";
import { landingPage } from "../views/landing.js";
import { loginPage, registerPage, forgotPage, resetPage, onboardingPage } from "../views/auth.js";
import {
  uuid, nowIso, cleanText, isValidEmail, isValidPhone, isValidUrl,
  sha256, rateLimiter, hashPassword, verifyPassword, needsPasswordRehash,
} from "../security.js";
import { createSession, destroySession, resolveWorkspace } from "../auth.js";
import { logAudit } from "../audit.js";
import { COUNTRIES, CURRENCY_BY_COUNTRY, INDUSTRIES, GOALS, slugify, uniqueSlug, COUNTRY_TIMEZONES } from "../db.js";
import { permissionsOf } from "../rbac.js";
import { maybeGrantSuperAdmin } from "../billing.js";

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));

// Limites configurables par environnement (défauts de production)
const RL = {
  register: Number(process.env.RATE_LIMIT_REGISTER || 5),
  login: Number(process.env.RATE_LIMIT_LOGIN || 5),
  forgot: Number(process.env.RATE_LIMIT_FORGOT || 3),
};

function publicError(ctx, status, message, field = null) {
  if (ctx.json) ctx.sendJSON(status, { error: message, ...(field ? { field } : {}) });
  else throw Object.assign(new Error(message), { status, field });
}

function validateRegistration(body) {
  const v = {};
  const errors = [];
  v.first_name = cleanText(body.first_name, 50);
  v.last_name = cleanText(body.last_name, 50);
  v.email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  v.phone = cleanText(body.phone, 20);
  v.password = String(body.password || "");
  v.company = cleanText(body.company, 80);
  v.country = cleanText(body.country, 2).toUpperCase();
  v.industry = cleanText(body.industry, 40);

  if (!v.first_name) errors.push({ field: "first_name", message: "Le prénom est requis." });
  if (!v.last_name) errors.push({ field: "last_name", message: "Le nom est requis." });
  if (!isValidEmail(v.email)) errors.push({ field: "email", message: "Adresse e-mail invalide." });
  if (!isValidPhone(v.phone)) errors.push({ field: "phone", message: "Numéro de téléphone invalide." });
  if (v.password.length < 8 || v.password.length > 72)
    errors.push({ field: "password", message: "Le mot de passe doit contenir entre 8 et 72 caractères." });
  if (v.company.length < 2) errors.push({ field: "company", message: "Le nom de l'entreprise est requis (2 caractères min.)." });
  if (!COUNTRY_CODES.has(v.country)) errors.push({ field: "country", message: "Pays non reconnu." });
  if (!INDUSTRIES.includes(v.industry)) errors.push({ field: "industry", message: "Secteur non reconnu." });
  return { v, errors };
}

export async function handlePage(ctx) {
  const { path, method } = ctx;
  if (method !== "GET") return false;

  if (path === "/") {
    // Tarifs dynamiques depuis plan_definitions (configurables — spec §7)
    let plans = null;
    try {
      const { listPlanDefs } = await import("../billing.js");
      plans = listPlanDefs(ctx.db);
    } catch { /* repli sur la liste statique de la vue */ }
    return ctx.sendHTML(200, landingPage({ plans }));
  }
  if (path === "/login") {
    if (ctx.user) return ctx.redirect(onboardTarget(ctx));
    return ctx.sendHTML(200, loginPage());
  }
  if (path === "/register") {
    if (ctx.user) return ctx.redirect(onboardTarget(ctx));
    return ctx.sendHTML(200, registerPage());
  }
  if (path === "/forgot-password") {
    if (ctx.user) return ctx.redirect("/dashboard");
    return ctx.sendHTML(200, forgotPage());
  }
  if (path === "/reset-password") {
    const token = String(ctx.query.token || "");
    const row = token
      ? ctx.db.prepare("SELECT * FROM password_resets WHERE token_hash = ?").get(sha256(token))
      : null;
    const valid = row && !row.used_at && new Date(row.expires_at).getTime() > Date.now();
    if (valid) return ctx.sendHTML(200, resetPage({ token }));
    return ctx.sendHTML(200, resetPage({ error: "Ce lien de réinitialisation est invalide ou a expiré. Demandez un nouveau lien." }));
  }
  if (path === "/onboarding") {
    if (!ctx.user) return ctx.redirect("/login");
    if (!ctx.org) return ctx.redirect("/login");
    if (ctx.org.onboarding_completed) return ctx.redirect("/dashboard");
    const ob = ctx.db.prepare("SELECT * FROM onboarding WHERE organization_id = ?").get(ctx.org.id) || {
      step: 0, industry: null, country: null, currency: null, goal: null, completed: 0,
    };
    return ctx.sendHTML(200, onboardingPage({ org: ctx.org, ob, csrf: ctx.csrf }));
  }
  return false;
}

export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;
  if (!path.startsWith("/api/")) return false;

  /* ---------- Santé & catalogue ---------- */
  if (method === "GET" && path === "/api/health")
    return ctx.sendJSON(200, { ok: true, service: "ai-sales-agent", phase: 7, time: new Date().toISOString() });
  // /api/plans est servi par billingRoutes (dynamique, plan_definitions — spec §7)

  /* ---------- INSCRIPTION ---------- */
  if (method === "POST" && path === "/api/register") {
    if (!rateLimiter(ctx.ip + ":register", RL.register, 15 * 60 * 1000))
      return publicError(ctx, 429, "Trop de tentatives. Réessayez dans quelques minutes.");
    const { v, errors } = validateRegistration(body);
    if (errors.length) {
      const e = errors[0];
      if (ctx.json) return ctx.sendJSON(400, { error: e.message, field: e.field, errors });
      return ctx.sendHTML(400, registerPage({ error: { field: e.field, message: e.message }, values: v }));
    }
    const existing = db.prepare("SELECT 1 FROM users WHERE email = ?").get(v.email);
    if (existing) {
      if (ctx.json) return ctx.sendJSON(409, { error: "Un compte existe déjà avec cet e-mail.", field: "email" });
      return ctx.sendHTML(409, registerPage({ error: { field: "email", message: "Un compte existe déjà avec cet e-mail." }, values: v }));
    }

    const now = nowIso();
    const userId = uuid();
    const orgId = uuid();
    const currency = CURRENCY_BY_COUNTRY[v.country] || "XOF";
    const slug = uniqueSlug(slugify(v.company));

    db.prepare(
      `INSERT INTO users (id, first_name, last_name, email, phone, password_hash, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(userId, v.first_name, v.last_name, v.email, v.phone || null, hashPassword(v.password), now, now);
    // Phase 8 — super-admin (spec §25) : e-mail dans SUPER_ADMIN_EMAILS
    maybeGrantSuperAdmin(db, userId, v.email);

    db.prepare(
      `INSERT INTO organizations (id, name, slug, country, industry, currency, logo_url, goal, onboarding_completed, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`
    ).run(orgId, v.company, slug, v.country, v.industry, currency, COUNTRY_TIMEZONES[v.country] || "Africa/Lome", now, now);

    db.prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status, created_at)
       VALUES (?, ?, ?, 'OWNER', 'active', ?)`
    ).run(uuid(), orgId, userId, now);

    db.prepare(
      `INSERT INTO onboarding (organization_id, step, industry, country, currency, completed, updated_at)
       VALUES (?, 0, ?, ?, ?, 0, ?)`
    ).run(orgId, v.industry, v.country, currency, now);

    // Phase 8 — TRIAL (spec §8) : la nouvelle organisation démarre en trial
    // (plan + durée configurables via TRIAL_PLAN / TRIAL_DAYS). Le trial n'est
    // JAMAIS « payant » : il expire à trial_ends_at (→ expired → plan FREE).
    const trialPlan = String(process.env.TRIAL_PLAN || "STARTER").toUpperCase();
    const trialDays = Math.max(0, Number(process.env.TRIAL_DAYS || 14) || 0);
    const trialEnds = new Date(Date.now() + trialDays * 86400e3).toISOString();
    db.prepare(
      `INSERT INTO subscriptions (id, organization_id, plan, status, current_period_start, trial_days, trial_ends_at, created_at, updated_at)
       VALUES (?, ?, ?, 'trial', ?, ?, ?, ?, ?)`
    ).run(uuid(), orgId, trialPlan, now, trialDays, trialEnds, now, now);

    logAudit(db, { organizationId: orgId, userId, action: "CREATE_ORGANIZATION", resourceType: "organization", resourceId: orgId });
    logAudit(db, { organizationId: orgId, userId, action: "LOGIN", resourceType: "session" });

    createSession(db, ctx.req, ctx.res, { userId, workspaceId: orgId });
    if (ctx.json) return ctx.sendJSON(200, { redirect: "/onboarding" });
    ctx.res.writeHead(302, { Location: "/onboarding" });
    return ctx.res.end();
  }

  /* ---------- CONNEXION ---------- */
  if (method === "POST" && path === "/api/login") {
    if (!rateLimiter(ctx.ip + ":login", RL.login, 15 * 60 * 1000))
      return publicError(ctx, 429, "Trop de tentatives de connexion. Réessayez dans 15 minutes.");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = email ? db.prepare("SELECT * FROM users WHERE email = ?").get(email) : null;
    if (!user || !verifyPassword(password, user.password_hash)) {
      if (ctx.json) return ctx.sendJSON(401, { error: "E-mail ou mot de passe incorrect." });
      return ctx.sendHTML(401, loginPage({ error: "E-mail ou mot de passe incorrect.", email }));
    }
    // Migration transparente scrypt → PBKDF2-SHA256 au login réussi
    if (needsPasswordRehash(user.password_hash)) {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(hashPassword(password), nowIso(), user.id);
    }
    const workspace = resolveWorkspace(db, user.id);
    if (!workspace) return publicError(ctx, 400, "Aucune organisation associée à ce compte.");
    const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(workspace);
    logAudit(db, { organizationId: workspace, userId: user.id, action: "LOGIN", resourceType: "session" });
    createSession(db, ctx.req, ctx.res, { userId: user.id, workspaceId: workspace });
    if (ctx.json) return ctx.sendJSON(200, { redirect: org.onboarding_completed ? "/dashboard" : "/onboarding" });
    ctx.res.writeHead(302, { Location: org.onboarding_completed ? "/dashboard" : "/onboarding" });
    return ctx.res.end();
  }

  /* ---------- DÉCONNEXION ---------- */
  if (method === "POST" && path === "/api/logout") {
    if (ctx.user && ctx.member) {
      logAudit(db, { organizationId: ctx.member.organization_id, userId: ctx.user.id, action: "LOGOUT", resourceType: "session" });
    }
    destroySession(db, ctx.res, ctx.session?.id);
    if (ctx.json) return ctx.sendJSON(200, { redirect: "/" });
    ctx.res.writeHead(302, { Location: "/" });
    return ctx.res.end();
  }

  /* ---------- MOT DE PASSE OUBLIÉ ---------- */
  if (method === "POST" && path === "/api/forgot-password") {
    if (!rateLimiter(ctx.ip + ":forgot", RL.forgot, 60 * 60 * 1000))
      return publicError(ctx, 429, "Trop de demandes. Réessayez dans une heure.");
    const email = String(body.email || "").trim().toLowerCase();
    const user = email ? db.prepare("SELECT * FROM users WHERE email = ?").get(email) : null;
    let resetUrl = null;
    if (user && isValidEmail(email)) {
      const token = randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").run(user.id);
      db.prepare(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(uuid(), user.id, sha256(token), expires, nowIso());
      const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
      resetUrl = `${base}/reset-password?token=${token}`;
      // En production, un e-mail est envoyé via le provider configuré.
      console.log(`[reset-password] Lien généré pour ${email} (à envoyer par e-mail) : ${resetUrl}`);
    }
    const message = "Si un compte existe avec cette adresse, un lien de réinitialisation a été envoyé.";
    if (ctx.json) {
      const out = { message };
      if (process.env.APP_ENV === "test" && resetUrl) out.resetUrl = resetUrl; // mode test uniquement
      return ctx.sendJSON(200, out);
    }
    return ctx.sendHTML(200, forgotPage({ message }));
  }

  /* ---------- RÉINITIALISATION ---------- */
  if (method === "POST" && path === "/api/reset-password") {
    const token = String(body.token || "");
    const row = token ? db.prepare("SELECT * FROM password_resets WHERE token_hash = ?").get(sha256(token)) : null;
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now())
      return publicError(ctx, 400, "Ce lien est invalide ou a expiré.");
    const pw = String(body.password || "");
    if (pw.length < 8 || pw.length > 72) return publicError(ctx, 400, "Le mot de passe doit contenir entre 8 et 72 caractères.");
    if (pw !== String(body.password2 || "")) return publicError(ctx, 400, "Les deux mots de passe ne correspondent pas.");

    const now = nowIso();
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hashPassword(pw), now, row.user_id);
    db.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(now, row.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
    const firstOrg = db.prepare("SELECT organization_id FROM organization_members WHERE user_id = ? LIMIT 1").get(row.user_id);
    if (firstOrg) logAudit(db, { organizationId: firstOrg.organization_id, userId: row.user_id, action: "PASSWORD_CHANGE", resourceType: "user", resourceId: row.user_id });

    if (ctx.json) return ctx.sendJSON(200, { redirect: "/login" });
    ctx.res.writeHead(302, { Location: "/login" });
    return ctx.res.end();
  }

  /* ---------- ONBOARDING ---------- */
  if (method === "POST" && path === "/api/onboarding") {
    if (!ctx.user) return publicError(ctx, 401, "Connexion requise.");
    if (!ctx.org) return publicError(ctx, 403, "Organisation introuvable.");
    const ob = db.prepare("SELECT * FROM onboarding WHERE organization_id = ?").get(ctx.org.id);
    if (!ob) return publicError(ctx, 404, "Onboarding introuvable.");
    const step = Number(body.step);
    if (!Number.isInteger(step) || step < 1 || step > 7) return publicError(ctx, 400, "Étape invalide.");
    if (ob.completed) return publicError(ctx, 400, "Onboarding déjà terminé.");
    if (step !== ob.step + 1) return publicError(ctx, 400, "Étapes dans l'ordre : commencez par l'étape précédente.");
    ob.step = step;

    const now = nowIso();
    if (step === 1) {
      // étape « Bienvenue » : aucune donnée
    } else if (step === 2) {
      const name = cleanText(body.company_name, 80);
      if (name.length < 2) return publicError(ctx, 400, "Le nom de l'entreprise est requis.");
      db.prepare("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?").run(name, now, ctx.org.id);
      logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "UPDATE_ORGANIZATION", resourceType: "organization", resourceId: ctx.org.id, metadata: { field: "name" } });
    } else if (step === 3) {
      if (!INDUSTRIES.includes(String(body.industry || ""))) return publicError(ctx, 400, "Secteur non reconnu.");
      ob.industry = body.industry;
      db.prepare("UPDATE organizations SET industry = ?, updated_at = ? WHERE id = ?").run(ob.industry, now, ctx.org.id);
    } else if (step === 4) {
      if (!COUNTRY_CODES.has(String(body.country || "").toUpperCase())) return publicError(ctx, 400, "Pays non reconnu.");
      ob.country = body.country.toUpperCase();
      db.prepare("UPDATE organizations SET country = ?, updated_at = ? WHERE id = ?").run(ob.country, now, ctx.org.id);
    } else if (step === 5) {
      const cur = cleanText(body.currency, 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) return publicError(ctx, 400, "Devise invalide.");
      ob.currency = cur;
      db.prepare("UPDATE organizations SET currency = ?, updated_at = ? WHERE id = ?").run(cur, now, ctx.org.id);
    } else if (step === 6) {
      if (!GOALS.includes(String(body.goal || ""))) return publicError(ctx, 400, "Objectif non reconnu.");
      ob.goal = body.goal;
      db.prepare("UPDATE organizations SET goal = ?, updated_at = ? WHERE id = ?").run(ob.goal, now, ctx.org.id);
    } else if (step === 7) {
      ob.completed = 1;
      db.prepare("UPDATE organizations SET onboarding_completed = 1, updated_at = ? WHERE id = ?").run(now, ctx.org.id);
      logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "UPDATE_ORGANIZATION", resourceType: "organization", resourceId: ctx.org.id, metadata: { field: "onboarding_completed" } });
    }
    db.prepare(
      `UPDATE onboarding SET step = ?, industry = ?, country = ?, currency = ?, goal = ?, completed = ?, updated_at = ?
       WHERE organization_id = ?`
    ).run(ob.step, ob.industry, ob.country, ob.currency, ob.goal, ob.completed, now, ctx.org.id);

    if (ctx.json) return ctx.sendJSON(200, { redirect: ob.completed ? "/dashboard" : "/onboarding" });
    ctx.res.writeHead(302, { Location: ob.completed ? "/dashboard" : "/onboarding" });
    return ctx.res.end();
  }

  /* ---------- ME ---------- */
  if (method === "GET" && path === "/api/me") {
    if (!ctx.user) return ctx.sendJSON(401, { error: "Non connecté." });
    if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
    const sub = db.prepare("SELECT * FROM subscriptions WHERE organization_id = ?").get(ctx.org.id);
    return ctx.sendJSON(200, {
      user: {
        id: ctx.user.id,
        firstName: ctx.user.first_name,
        lastName: ctx.user.last_name,
        email: ctx.user.email,
        phone: ctx.user.phone,
      },
      organization: {
        id: ctx.org.id,
        name: ctx.org.name,
        slug: ctx.org.slug,
        country: ctx.org.country,
        industry: ctx.org.industry,
        currency: ctx.org.currency,
        plan: sub?.plan || "FREE",
      },
      role: ctx.member.role,
      permissions: permissionsOf(ctx.member.role),
      onboardingCompleted: Boolean(ctx.org.onboarding_completed),
      // Exclusivement en mode test : permet aux tests automatisés d'envoyer
      // les requêtes POST protégées par CSRF. Jamais en production.
      ...(process.env.APP_ENV === "test" ? { csrf: ctx.csrf } : {}),
    });
  }

  return false;
}

function onboardTarget(ctx) {
  return ctx.org && ctx.org.onboarding_completed ? "/dashboard" : "/onboarding";
}
