// test/api.test.js — tests d'API complets (node:test)
// Couvre : landing, inscription, connexion, déconnexion, mot de passe oublié,
// organisation, onboarding, dashboard, settings, RBAC et isolation multi-tenant.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";

const PORT = 3901;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `data/test-${process.pid}.db`;

let server;
let serverOutput = "";

test.before(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { unlinkSync(f); } catch {}
  }
  server = spawn("node", ["server/index.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      APP_ENV: "test",
      RATE_LIMIT_LOGIN: "100",
      RATE_LIMIT_REGISTER: "100",
      RATE_LIMIT_FORGOT: "3",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverOutput += d));
  server.stderr.on("data", (d) => (serverOutput += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`serveur non démarré :\n${serverOutput}`)), 8000);
    server.stdout.on("data", (d) => {
      if (String(d).includes("démarré")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
});

test.after(() => {
  server?.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { unlinkSync(f); } catch {}
  }
});

/* ---------- helpers ---------- */
class User {
  constructor(name) {
    this.name = name;
    this.cookie = null;
    this.csrf = null;
    this.org = null;
  }
  headers(extra = {}) {
    return { ...extra, ...(this.cookie ? { cookie: this.cookie } : {}) };
  }
  setCookie(res) {
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
  }
  async post(path, body) {
    // Récupère le jeton CSRF si on a une session mais pas encore de token.
    if (this.cookie && !this.csrf) await this.me();
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
        ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
      }),
      body: JSON.stringify(body),
      redirect: "manual",
    });
    this.setCookie(r);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  }
  async get(path, asJson = true) {
    const r = await fetch(BASE + path, {
      headers: this.headers(asJson ? { "X-Requested-With": "fetch" } : {}),
      redirect: "manual",
    });
    this.setCookie(r);
    const text = await r.text();
    let j = { text };
    if (asJson) { try { j = JSON.parse(text); } catch { j = { text }; } }
    return { status: r.status, location: r.headers.get("location"), ...j };
  }
  async register(fields = {}) {
    return this.post("/api/register", {
      first_name: "Test", last_name: "User",
      email: `${this.name}@test.com`, phone: "+228 90 00 00 01",
      password: "password123", company: `Org ${this.name}`,
      country: "TG", industry: "Services",
      ...fields,
    });
  }
  async me() {
    const r = await this.get("/api/me");
    if (r.organization) this.org = r.organization;
    if (r.csrf) this.csrf = r.csrf;
    return r;
  }
  async completeOnboarding() {
    if (this.cookie && !this.csrf) await this.me();
    await this.post("/api/onboarding", { step: 1 });
    await this.post("/api/onboarding", { step: 2, company_name: `Org ${this.name} SA` });
    await this.post("/api/onboarding", { step: 3, industry: "Services" });
    await this.post("/api/onboarding", { step: 4, country: "TG" });
    await this.post("/api/onboarding", { step: 5, currency: "XOF" });
    await this.post("/api/onboarding", { step: 6, goal: "Générer des leads" });
    const done = await this.post("/api/onboarding", { step: 7 });
    assert.equal(done.status, 200);
    assert.equal(done.redirect, "/dashboard");
  }
}

/* ================================================================ 1. LANDING */
test("landing page : contenu et sections", async () => {
  const r = await fetch(BASE + "/");
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(
    text.includes("qui ne ment jamais") || text.includes("Votre commercial IA disponible 24h/24"),
    "slogan"
  );
  assert.ok(
    text.includes("Créer mon organisation") || text.includes("Commencer gratuitement"),
    "CTA register"
  );
  assert.ok(text.includes("Se connecter"), "CTA login");
  for (const id of ["fonctionnement", "tarifs", "faq"])
    assert.ok(text.includes(`id="${id}"`), `section ${id}`);
  assert.ok(text.includes("footer"), "footer");
  assert.ok(text.includes("catalogue") || text.includes("0 hallucination"), "anti-hallucination");
});

test("pages d'authentification HTML rendues sans erreur", async () => {
  for (const p of ["/login", "/register", "/forgot-password"]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    const text = await r.text();
    assert.ok(text.includes("AI Sales Agent"), p);
  }
  const r = await fetch(BASE + "/register");
  const t = await r.text();
  assert.ok(t.includes("Nom de l'entreprise") && t.includes("Togo"), "champs d'inscription rendus");
  const bad = await fetch(BASE + "/reset-password?token=fake").then((r) => r.text());
  assert.ok(bad.includes("invalide"), "token invalide : message d'erreur propre");
});

/* ============================================== 2. INSCRIPTION + ORGANISATION */
const A = new User("a");
const B = new User("b");
const C = new User("c");

test("inscription : user + organization + OWNER + TRIAL (Phase 8)", async () => {
  const r = await A.register();
  assert.equal(r.status, 200);
  assert.equal(r.redirect, "/onboarding");
  assert.ok(A.cookie && A.cookie.startsWith("token="), "cookie de session posé");

  const me = await A.me();
  assert.equal(me.status, 200);
  assert.equal(me.user.email, "a@test.com");
  assert.equal(me.role, "OWNER");
  assert.equal(me.organization.country, "TG");
  assert.equal(me.organization.currency, "XOF", "Togo → XOF par défaut");
  // Phase 8 — nouvelle organisation = TRIAL (plan de trial STARTER par défaut,
  // configuré via TRIAL_PLAN). Plus de « FREE » implicite à l'inscription.
  assert.equal(me.organization.plan, "STARTER", "plan de trial (TRIAL_PLAN)");
  assert.equal(me.onboardingCompleted, false);
  assert.ok(me.permissions.includes("*"), "OWNER a toutes les permissions");

  const dup = await new User("a").post("/api/register", {
    first_name: "X", last_name: "Y", email: "a@test.com", password: "password123",
    company: "Dupli", country: "TG", industry: "Services",
  });
  assert.equal(dup.status, 409, "e-mail dupliqué refusé");

  const bad = await new User("bad").post("/api/register", {
    first_name: "", last_name: "Y", email: "pas-un-email", password: "court",
    company: "x", country: "XX", industry: "Inventé",
  });
  assert.equal(bad.status, 400, "validation des entrées");
});

test("inscription B et C (autres organisations)", async () => {
  assert.equal((await B.register()).status, 200);
  assert.equal((await C.register()).status, 200);
  await B.me();
  await C.me();
  assert.notEqual(A.org.id, B.org.id);
  assert.notEqual(A.org.id, C.org.id);
});

/* ============================================== 3. ROUTES PROTÉGÉES */
test("routes privées protégées : redirection /login", async () => {
  const anon = new User("anon");
  const dash = await anon.get("/dashboard", false);
  assert.equal(dash.status, 302);
  assert.equal(dash.location, "/login");
  const api = await anon.get("/api/me");
  assert.equal(api.status, 401);
});

/* ================================================================ 4. ONBOARDING */
test("onboarding incomplet : /dashboard redirige vers /onboarding", async () => {
  const dash = await A.get("/dashboard", false);
  assert.equal(dash.status, 302);
  assert.equal(dash.location, "/onboarding");
  const page = await A.get("/onboarding", false);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Bienvenue dans AI Sales Agent"), "étape 1");
});

test("onboarding : étapes séquentielles puis dashboard", async () => {
  const skip = await A.post("/api/onboarding", { step: 7 });
  assert.equal(skip.status, 400, "impossible de sauter les étapes");

  await A.completeOnboarding();
  const me = await A.me();
  assert.equal(me.onboardingCompleted, true);
  assert.equal(me.organization.name, "Org a SA");

  const dash = await A.get("/dashboard", false);
  assert.equal(dash.status, 200);
  assert.ok(dash.text.includes("Bonjour, Test"), "salutation par prénom");
  assert.ok(dash.text.includes("Total Leads") && dash.text.includes("Valeur pipeline"), "cartes du dashboard commercial");
  assert.ok(dash.text.includes("Taux de conversion"), "carte conversion");
});

/* ============================================== 5. DASHBOARD + PLACEHOLDERS */
test("dashboard complet + pages Phase 2 + placeholders Phase 3+", async () => {
  const dash = await A.get("/dashboard", false);
  assert.ok(dash.text.includes("Org a SA"), "nom d'entreprise affiché");
  // Anciens chemins Phase 1 → redirections vers les pages Phase 2
  for (const [from, to] of [["/sales/leads", "/dashboard/leads"], ["/sales/contacts", "/dashboard/contacts"], ["/sales/deals", "/dashboard/deals"], ["/commerce/products", "/dashboard/products"], ["/commerce/orders", "/dashboard/orders"]]) {
    const r = await A.get(from, false);
    assert.equal(r.status, 302, from);
    assert.equal(r.location, to, from);
  }
  // Pages Phase 2 fonctionnelles
  for (const p of ["/dashboard/leads", "/dashboard/contacts", "/dashboard/deals", "/dashboard/products", "/dashboard/leads/kanban", "/dashboard/tasks", "/dashboard/orders", "/dashboard/quotes"]) {
    const r = await A.get(p, false);
    assert.equal(r.status, 200, p);
  }
  // Chemins Phase 1 /ai/* → redirections vers les pages IA Phase 3
  for (const [from, to] of [["/ai/agent", "/dashboard/agent"], ["/ai/conversations", "/dashboard/conversations"], ["/ai/knowledge", "/dashboard/knowledge"]]) {
    const r = await A.get(from, false);
    assert.equal(r.status, 302, from);
    assert.equal(r.location, to, from);
  }
  // Vrais placeholders (phases suivantes)
  for (const p of ["/automation/automations", "/analytics"]) {
    const r = await A.get(p, false);
    assert.equal(r.status, 200, p);
    assert.ok(r.text.includes("sera disponible dans une prochaine phase"), p);
  }
});

/* ================================================================ 6. SETTINGS */
test("settings company : mise à jour + audit + validation", async () => {
  const r = await A.post("/api/settings/company", {
    name: "Org a International", logo_url: "", country: "TG", industry: "E-commerce", currency: "XOF",
  });
  assert.equal(r.status, 200);
  const me = await A.me();
  assert.equal(me.organization.name, "Org a International");
  assert.equal(me.organization.industry, "E-commerce");
  const page = await A.get("/settings/company", false);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Org a International"), "valeur persistée dans l'UI");
  const bad = await A.post("/api/settings/company", { name: "x", country: "TG", industry: "Services", currency: "XOF" });
  assert.equal(bad.status, 400, "validation serveur");
});

test("settings profile : mise à jour + e-mail unique", async () => {
  const r = await A.post("/api/settings/profile", {
    first_name: "Koffi", last_name: "Mensah", email: "a@test.com", phone: "+228 90 11 22 33",
  });
  assert.equal(r.status, 200);
  const me = await A.me();
  assert.equal(me.user.firstName, "Koffi");
  assert.equal(me.user.phone, "+228 90 11 22 33");
  const clash = await A.post("/api/settings/profile", {
    first_name: "K", last_name: "M", email: "b@test.com", phone: "",
  });
  assert.equal(clash.status, 409, "e-mail déjà pris refusé");
});

test("XSS : valeurs dynamiques échappées dans le HTML", async () => {
  const xss = new User("xss");
  await xss.register({ first_name: '<img src=x onerror=alert(1)>' });
  await xss.completeOnboarding();
  // Le nom d'entreprise est lui aussi testé (l'onboarding l'a écrasé).
  await xss.post("/api/settings/company", { name: 'Org <script>alert(1)</script>', country: "TG", industry: "Services", currency: "XOF" });
  const dash = await xss.get("/dashboard", false);
  assert.ok(!dash.text.includes("<script>alert(1)</script>"), "payload <script> échappé");
  assert.ok(!dash.text.includes("<img src=x"), "payload <img> échappé");
  assert.ok(dash.text.includes("&lt;img") || dash.text.includes("&lt;script"), "caractères échappés présents");
});

/* ================================================================ 7. TEAM + RBAC */
test("team : invitation d'un compte existant (membre actif)", async () => {
  const r = await A.post("/api/team/invites", { email: "b@test.com", role: "VIEWER" });
  assert.equal(r.status, 200);
  const team = await A.get(`/api/team?organization_id=${A.org.id}`);
  assert.equal(team.status, 200);
  const bMember = team.members.find((m) => m.email === "b@test.com");
  assert.ok(bMember, "B est membre de l'org A");
  assert.equal(bMember.role, "VIEWER");
  assert.equal(bMember.status, "active", "compte existant → actif immédiatement");
  const dup = await A.post("/api/team/invites", { email: "b@test.com", role: "VIEWER" });
  assert.equal(dup.status, 409, "doublon refusé");
});

test("team : invitation d'un e-mail inconnu (statut invited)", async () => {
  const r = await A.post("/api/team/invites", { email: "nouveau@future.com", role: "SALES_AGENT" });
  assert.equal(r.status, 200);
  const team = await A.get("/api/team");
  const inv = team.members.find((m) => m.email === "nouveau@future.com");
  assert.equal(inv.status, "invited");
});

test("RBAC : VIEWER de l'org A ne peut pas l'administrer", async () => {
  const orgA = A.org.id;
  const inv = await B.post(`/api/team/invites?organization_id=${orgA}`, { email: "x@x.com", role: "VIEWER" });
  assert.equal(inv.status, 403, "team:invite refusé");
  const upd = await B.post(`/api/settings/company?organization_id=${orgA}`, {
    name: "Hacked", country: "TG", industry: "Services", currency: "XOF",
  });
  assert.equal(upd.status, 403, "org:update refusé");
  const audit = await B.get(`/api/audit?organization_id=${orgA}`);
  assert.equal(audit.status, 403, "audit:read refusé");
});

test("RBAC : changement de rôle par OWNER + refus croisés", async () => {
  const orgA = A.org.id;
  const team = await A.get(`/api/team?organization_id=${orgA}`);
  const bMember = team.members.find((m) => m.email === "b@test.com");

  const role = await A.post(`/api/team/members/${bMember.id}/role`, { role: "SALES_AGENT" });
  assert.equal(role.status, 200);
  const team2 = await A.get(`/api/team?organization_id=${orgA}`);
  assert.equal(team2.members.find((m) => m.id === bMember.id).role, "SALES_AGENT");

  const aMember = team2.members.find((m) => m.email === "a@test.com");
  const forbidden = await B.post(`/api/team/members/${aMember.id}/role?organization_id=${orgA}`, { role: "VIEWER" });
  assert.equal(forbidden.status, 403, "B ne peut pas gérer l'OWNER A");

  const ownerAssign = await A.post(`/api/team/members/${bMember.id}/role`, { role: "OWNER" });
  assert.equal(ownerAssign.status, 403, "le rôle OWNER n'est pas assignable");
});

test("RBAC : retrait de membre par OWNER + auto-protection", async () => {
  const orgA = A.org.id;
  const team = await A.get(`/api/team?organization_id=${orgA}`);
  const bMember = team.members.find((m) => m.email === "b@test.com");
  const r = await A.post(`/api/team/members/${bMember.id}/remove`);
  assert.equal(r.status, 200);
  const team2 = await A.get(`/api/team?organization_id=${orgA}`);
  assert.ok(!team2.members.find((m) => m.id === bMember.id), "membre retiré");
  const aMember = team2.members.find((m) => m.email === "a@test.com");
  const self = await A.post(`/api/team/members/${aMember.id}/remove`);
  assert.equal(self.status, 403, "on ne se retire pas soi-même (dernier OWNER)");
});

/* ============================================ 8. ISOLATION MULTI-TENANT (CRITIQUE) */
test("ISOLATION : chaque utilisateur est confiné à ses organisations", async () => {
  const teamC = await A.get(`/api/team?organization_id=${C.org.id}`);
  assert.equal(teamC.status, 403, "A → team de C refusé");
  const auditC = await A.get(`/api/audit?organization_id=${C.org.id}`);
  assert.equal(auditC.status, 403, "A → audit de C refusé");
  // B a été retiré de l'org A : plus aucun accès.
  const teamA = await B.get(`/api/team?organization_id=${A.org.id}`);
  assert.equal(teamA.status, 403, "ex-membre B → team de A refusé");
  const teamA2 = await C.get(`/api/team?organization_id=${A.org.id}`);
  assert.equal(teamA2.status, 403, "C → team de A refusé");

  const meA = await A.get("/api/team");
  assert.equal(meA.organization.id, A.org.id, "A ne voit que son org par défaut");
  const meC = await C.get("/api/team");
  assert.equal(meC.organization.id, C.org.id);
  assert.equal(meC.members.length, 1, "C n'a qu'un seul membre (lui-même)");

  const fake = await A.get(`/api/team?organization_id=00000000-0000-0000-0000-000000000000`);
  assert.equal(fake.status, 403, "id d'org falsifié refusé");
});

/* ================================================================ 9. AUDIT LOGS */
test("audit logs : événements critiques journalisés, sans secrets", async () => {
  const { status, logs } = await A.get("/api/audit?limit=100");
  assert.equal(status, 200);
  const actions = new Set(logs.map((l) => l.action));
  for (const a of ["LOGIN", "CREATE_ORGANIZATION", "UPDATE_ORGANIZATION", "ADD_MEMBER", "ROLE_CHANGE", "REMOVE_MEMBER"])
    assert.ok(actions.has(a), `action ${a} présente`);
  assert.ok(!JSON.stringify(logs).includes("password"), "aucun mot de passe journalisé");
});

/* ============================================== 10. MOT DE PASSE OUBLIÉ / RESET */
test("mot de passe oublié : réinitialisation complète (usage unique)", async () => {
  const forgot = await B.post("/api/forgot-password", { email: "b@test.com" });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.resetUrl, "lien fourni en mode test");
  const token = new URL(forgot.resetUrl).searchParams.get("token");

  const page = await fetch(`${BASE}/reset-password?token=${token}`).then((r) => r.text());
  assert.ok(page.includes("Réinitialiser le mot de passe"), "page de reset rendue");

  const mismatch = await fetch(BASE + "/api/reset-password", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ token, password: "nouveau123", password2: "autre1234" }),
  }).then((r) => r.status);
  assert.equal(mismatch, 400, "mots de passe non identiques refusés");

  const reset = await fetch(BASE + "/api/reset-password", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ token, password: "nouveau123", password2: "nouveau123" }),
  }).then((r) => r.status);
  assert.equal(reset, 200, "reset accepté");

  const loginBody = (email, password) => fetch(BASE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.status);

  assert.equal(await loginBody("b@test.com", "password123"), 401, "ancien mot de passe invalidé");
  assert.equal(await loginBody("b@test.com", "nouveau123"), 200, "nouveau mot de passe accepté");

  const reuse = await fetch(BASE + "/api/reset-password", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ token, password: "encore1234", password2: "encore1234" }),
  }).then((r) => r.status);
  assert.equal(reuse, 400, "token à usage unique");

  const unknown = await fetch(BASE + "/api/forgot-password", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ email: "inconnu@nullepart.com" }),
  }).then((r) => r.json());
  assert.ok(unknown.message, "réponse générique (pas de fuite d'existence)");
  assert.equal(unknown.resetUrl, undefined, "aucun lien pour un compte inexistant");
});

test("rate limiting : trop de demandes de reset → 429", async () => {
  let status = 200;
  for (let i = 0; i < 12 && status !== 429; i++) {
    status = await fetch(BASE + "/api/forgot-password", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ email: `rl${i}@test.com` }),
    }).then((r) => r.status);
  }
  assert.equal(status, 429, "limiteur de tentatives déclenché");
});

/* ================================================================ 11. SESSIONS / SÉCURITÉ */
test("sessions : liste + session courante identifiée", async () => {
  const { sessions } = await A.get("/api/settings/sessions");
  assert.ok(sessions.length >= 1, "au moins la session courante");
  assert.ok(sessions.some((s) => s.current), "session courante marquée");
  const r = await A.post("/api/settings/sessions/revoke-others", {});
  assert.equal(r.status, 200);
});

test("CSRF : POST authentifié sans token refusé", async () => {
  const r = await fetch(BASE + "/api/settings/profile", {
    method: "POST",
    headers: { cookie: A.cookie, "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ first_name: "Hack", last_name: "X", email: "a@test.com" }),
  }).then((r) => r.status);
  assert.equal(r, 403, "absence de jeton CSRF → 403");
});

test("mot de passe : changement avec vérification du courant", async () => {
  const bad = await A.post("/api/settings/security/password", {
    current_password: "falsif", new_password: "nouveau999", confirm_password: "nouveau999",
  });
  assert.equal(bad.status, 401, "mot de passe courant incorrect");
  const ok = await A.post("/api/settings/security/password", {
    current_password: "password123", new_password: "nouveau999", confirm_password: "nouveau999",
  });
  assert.equal(ok.status, 200);
  const relog = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify({ email: "a@test.com", password: "nouveau999" }),
  }).then((r) => r.status);
  assert.equal(relog, 200, "connexion avec le nouveau mot de passe");
  const audit = await A.get("/api/audit?limit=10");
  assert.ok(audit.logs.some((l) => l.action === "PASSWORD_CHANGE"), "PASSWORD_CHANGE journalisé");
});

/* ================================================================ 12. DÉCONNEXION */
test("déconnexion : session détruite + audit LOGOUT/LOGIN", async () => {
  const r = await A.post("/api/logout", {});
  assert.equal(r.status, 200);
  assert.equal(r.redirect, "/");
  const me = await A.get("/api/me");
  assert.equal(me.status, 401, "session plus valide après logout");

  const login = await A.post("/api/login", { email: "a@test.com", password: "nouveau999" });
  assert.equal(login.status, 200);
  const audit = await A.get("/api/audit?limit=10");
  assert.ok(audit.logs.some((l) => l.action === "LOGOUT"), "LOGOUT journalisé");
  assert.ok(audit.logs.some((l) => l.action === "LOGIN"), "LOGIN journalisé");
});
