// test/billing.test.js — Phase 8 : SaaS (plans, trial, limites, facturation)
// RÈGLE ABSOLUE testée : un plan payant n'est activé qu'APRÈS confirmation
// réelle d'un paiement (webhook fournisseur). Sans configuration →
// CONFIGURATION_REQUIRED honnête ; rien n'est simulé en production.
// Port 3913, base dédiée, super-admin via SUPER_ADMIN_EMAILS.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = 3913;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `data/test-billing-${process.pid}.db`;
const PAY_WS = "ws-billing-test-secret";
const SA_EMAIL = "superadm@t8.test"; // doit correspondre à l'e-mail de l'utilisateur SA (superadm@t8.test)

let server;
let out = "";

const BASE_ENV = () => ({
  ...process.env,
  DB_PATH: DB,
  APP_ENV: "test",
  SESSION_SECRET: "test-secret-32-octets-minimum-00",
  RATE_LIMIT_LOGIN: "100",
  RATE_LIMIT_REGISTER: "100",
  RATE_LIMIT_AI_PER_MIN: "500",
  AUTOMATION_TICK_MS: "3600000",
  PAYMENT_TEST_WEBHOOK_SECRET: PAY_WS,
  SUPER_ADMIN_EMAILS: SA_EMAIL,
});

function waitForReady(proc, port, log) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`serveur ${port} non démarré :\n${log()}`)), 8000);
    proc.stdout.on("data", (d) => String(d).includes("démarré") && (clearTimeout(t), resolve()));
  });
}

async function spawnServer(port, extraEnv = {}) {
  const proc = spawn("node", ["server/index.js"], {
    env: { ...BASE_ENV(), PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  return waitForReady(proc, port, () => out).then(() => proc);
}

test.before(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { unlinkSync(f); } catch {} }
  server = await spawnServer(PORT);
});

test.after(() => {
  if (process.env.DUMP_SERVER_LOG) { try { process.stdout.write("\n===SERVERLOG===\n" + out + "\n===ENDSERVERLOG===\n"); } catch {} }
  server?.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { unlinkSync(f); } catch {} }
});

/* ---------- helpers ---------- */
class User {
  constructor(name) { this.name = name; this.cookie = null; this.csrf = null; this.orgId = null; this.userId = null; }
  headers(extra = {}) { return { ...extra, ...(this.cookie ? { cookie: this.cookie } : {}) }; }
  async post(path, body, { method = "POST" } = {}) {
    if (this.cookie && !this.csrf) await this.me();
    const r = await fetch(BASE + path, {
      method,
      headers: this.headers({ "Content-Type": "application/json", "X-Requested-With": "fetch", ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}) }),
      body: JSON.stringify({ ...body, ...(this.csrf ? { _csrf: this.csrf } : {}) }),
    });
    if (r.headers.get("set-cookie")) this.cookie = r.headers.get("set-cookie").split(";")[0];
    const j = await r.json().catch(() => ({}));
    if (j.csrf) this.csrf = j.csrf;
    return { status: r.status, http_status: r.status, ...j };
  }
  async get(path) {
    const r = await fetch(BASE + path, { headers: this.headers({ "X-Requested-With": "fetch" }) });
    if (r.headers.get("set-cookie")) this.cookie = r.headers.get("set-cookie").split(";")[0];
    const text = await r.text();
    let j = { text };
    try { j = JSON.parse(text); } catch {}
    if (j.csrf) this.csrf = j.csrf;
    return { status: r.status, http_status: r.status, ...j };
  }
  async setup() {
    const reg = await this.post("/api/register", {
      first_name: "User", last_name: this.name, email: `${this.name}@t8.test`,
      password: "password123", company: `Org ${this.name}`, country: "TG", industry: "E-commerce",
    });
    assert.equal(reg.status, 200, "inscription");
    await this.me();
    for (const b of [{ step: 1 }, { step: 2, company_name: `Org ${this.name}` }, { step: 3, industry: "E-commerce" }, { step: 4, country: "TG" }, { step: 5, currency: "XOF" }, { step: 6, goal: "Générer des leads" }, { step: 7 }]) {
      const r = await this.post("/api/onboarding", b);
      assert.equal(r.status, 200, `onboarding step ${b.step}`);
    }
    return this;
  }
  async me() {
    const r = await this.get("/api/me");
    if (r.csrf) this.csrf = r.csrf;
    if (r.organization) this.orgId = r.organization.id;
    if (r.user) this.userId = r.user.id;
    return r;
  }
}

function rawDb() { return new DatabaseSync(DB); }
/** Change le plan d'une org (fixture de test). Remet une cohérente période :
 *  active non-trial → période de 30 j future ; trial → trial_ends_at future. */
function setPlan(orgId, { plan = "FREE", status = "active", trialDays = null } = {}) {
  const d = rawDb();
  const nowIso = new Date().toISOString();
  const isTrial = status === "trial";
  const trialEnds = isTrial ? new Date(Date.now() + (trialDays ?? 14) * 86400e3).toISOString() : null;
  const periodEnd = isTrial ? null : new Date(Date.now() + 30 * 86400e3).toISOString();
  const id = `test-sub-${plan}-${orgId.slice(0, 8)}`;
  d.prepare(
    `INSERT INTO subscriptions (id, organization_id, plan, status, current_period_start, current_period_end, trial_days, trial_ends_at, cancelled_at, pending_plan, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET plan=excluded.plan, status=excluded.status,
       current_period_start=excluded.current_period_start, current_period_end=excluded.current_period_end,
       trial_days=excluded.trial_days, trial_ends_at=excluded.trial_ends_at,
       cancelled_at=NULL, pending_plan=NULL, updated_at=excluded.updated_at`
  ).run(id, orgId, plan, status, nowIso, periodEnd, isTrial ? (trialDays ?? 14) : null, trialEnds, nowIso, nowIso);
  d.close();
}
/** Décale la fin de période/trial dans le passé (pour tester l'expiration). */
function expireNow(orgId) {
  const d = rawDb();
  d.prepare("UPDATE subscriptions SET current_period_end = ?, trial_ends_at = ? WHERE organization_id = ?")
    .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", orgId);
  d.close();
}
async function payWebhook(tx, secret = PAY_WS) {
  const raw = JSON.stringify({ transaction_id: tx });
  const sig = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const r = await fetch(`${BASE}/api/webhooks/payments/TEST`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Provider-Signature": `sha256=${sig}` }, body: raw,
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

const A = new User("billa");
const SA = new User("superadm");

let invoiceId = null, invoiceTx = null;

/* ================================================================ TRIAL */
test("1. Inscription → TRIAL (plan STARTER, 14 jours, limites)", async () => {
  await A.setup();
  const bill = await A.get("/api/billing");
  assert.equal(bill.http_status, 200);
  assert.equal(bill.status, "trial", "statut trial");
  assert.equal(bill.plan, "STARTER", "plan de trial");
  assert.equal(bill.trial.days_left, 14, "14 jours restants");
  assert.ok(bill.trial.ends_at > new Date().toISOString(), "échéance future");
  // Limites du plan (utilisé/limite/restant)
  assert.equal(bill.usage.leads.limit, 1000, "limite leads STARTER");
  assert.equal(bill.usage.ai_messages.limit, 500, "limite IA STARTER");
  assert.equal(bill.usage.channels.limit, 2, "limite canaux STARTER");
  assert.ok(bill.usage.users.remaining <= 5, "reste ≤ 5 utilisateurs");
  assert.equal(bill.usage.leads.unlimited, false);
  assert.ok(bill.usage.leads.pct >= 0 && bill.usage.leads.pct <= 100, "pourcentage borné");
});

test("2. Plans publics dynamiques (plan_definitions) + landing", async () => {
  const plans = await A.get("/api/plans");
  assert.equal(plans.http_status, 200);
  assert.equal(plans.plans.length, 5, "5 plans");
  const pro = plans.plans.find((p) => p.code === "PRO");
  assert.equal(pro.price_monthly, 79);
  assert.equal(pro.limits.ai_messages, 20000);
  assert.ok(pro.features.length >= 3, "features d'affichage");
  // Landing : tarifs dynamiques (plus de XOF statiques)
  const land = await fetch(BASE + "/").then((r) => r.text());
  assert.ok(land.includes("Sur devis"), "plan Entreprise = Sur devis");
  assert.ok(land.includes("79"), "prix PRO dynamique");
  assert.ok(!land.includes("25 000"), "tarifs XOF statiques retirés");
});

/* ================================================================ LIMITES */
test("3. Limite utilisateurs : invitées jusqu'au plafond, puis 403 honnête", async () => {
  setPlan(A.orgId, { plan: "FREE" });
  const i1 = await A.post("/api/team/invites", { email: "u1@t8.test", role: "SALES_AGENT" });
  assert.equal(i1.http_status, 200, "invitation 1 (2/3)");
  const i2 = await A.post("/api/team/invites", { email: "u2@t8.test", role: "SALES_AGENT" });
  assert.equal(i2.http_status, 200, "invitation 2 (3/3)");
  const i3 = await A.post("/api/team/invites", { email: "u3@t8.test", role: "SALES_AGENT" });
  assert.equal(i3.http_status, 403, "3ᵉ invitation refusée (3/3)");
  assert.match(i3.error || "", /Limite du plan FREE/i, "raison lisible");
  assert.equal(i3.limit, 3);
  assert.equal(i3.used, 3);
});

test("4. Super-admin : prix/limites configurables (spec §7) + quota IA depuis plan", async () => {
  await SA.setup();
  // Non-super-admin refusé
  const denied = await A.post("/api/plans/PRO", { price_monthly: 1 }, { method: "PUT" });
  assert.equal(denied.http_status, 403, "non super-admin → 403");
  // Super-admin : création d'un plan custom à petites limites (pour tester les plafonds)
  const d = rawDb();
  d.prepare(
    `INSERT INTO plan_definitions (code, name, price_monthly, price_annual, currency, limits, features, active, sort_order, updated_at)
     VALUES ('MINI', 'Mini Test', 5, 0, 'USD', ?, ?, 1, 99, ?)`
  ).run(JSON.stringify({ users: 2, leads: 3, ai_messages: 3, conversations: 5, automations: 1, channels: 1, kb_documents: 2, storage_mb: 10 }),
    JSON.stringify(["Plan de test"]), new Date().toISOString());
  d.close();
  const plans = await A.get("/api/plans");
  assert.ok(plans.plans.some((p) => p.code === "MINI"), "plan custom visible");
  // Édition du prix
  const up = await SA.post("/api/plans/PRO", { price_monthly: 89, limits: { ai_messages: 15000 } }, { method: "PUT" });
  assert.equal(up.http_status, 200, JSON.stringify(up));
  assert.equal(up.plan.price_monthly, 89);
  assert.equal(up.plan.limits.ai_messages, 15000);
  const plans2 = await A.get("/api/plans");
  assert.equal(plans2.plans.find((p) => p.code === "PRO").price_monthly, 89, "prix mis à jour (persisté)");
  // Validation des valeurs
  const bad = await SA.post("/api/plans/PRO", { price_monthly: -5 }, { method: "PUT" });
  assert.equal(bad.http_status, 400, "prix négatif refusé");
  // Quota IA depuis le plan : MINI (3 messages/mois)
  setPlan(A.orgId, { plan: "MINI" });
  const usage = await A.get("/api/ai/usage");
  assert.equal(usage.quota, 3, "quota = limite du plan MINI (3)");
  const p = await A.post("/api/products", { name: "Produit Mini", sku: "MINI-1", price: "10000", stock_quantity: 5 });
  assert.equal(p.http_status, 201);
  for (let i = 0; i < 3; i++) {
    const c = await A.post("/api/ai/chat", { message: "Bonjour, avez-vous le Produit Mini ?" });
    assert.equal(c.http_status, 200, `message ${i + 1} ok`);
    assert.ok(!c.metadata?.blocked, `message ${i + 1} non bloqué`);
  }
  const blocked = await A.post("/api/ai/chat", { message: "Et encore un ?" });
  assert.equal(blocked.metadata?.blocked, "quota", "4ᵉ message bloqué (quota)");
  assert.match(blocked.reply || "", /quota IA/i, "message de quota honnête");
});

test("5. Limite leads : 403 honnête au-delà du plan", async () => {
  setPlan(A.orgId, { plan: "MINI" }); // 3 leads max
  for (const n of ["L1", "L2", "L3"]) {
    const l = await A.post("/api/leads", { name: n, source: "MANUAL" });
    assert.equal(l.http_status, 201, `lead ${n} créé`);
  }
  const l4 = await A.post("/api/leads", { name: "L4", source: "MANUAL" });
  assert.equal(l4.http_status, 403, "4ᵉ lead refusé (3/3)");
  assert.match(l4.error || "", /Leads/i, "raison lisible (Leads)");
  // Les autres limites existent aussi (canal : 1 max sur MINI)
  setPlan(A.orgId, { plan: "FREE" }); // 1 canal
  const c1 = await A.post("/api/channels/WHATSAPP", { phone_number_id: "999000", access_token: "EAAG-mini", verify_token: "vt", webhook_secret: "ws-mini" });
  assert.equal(c1.http_status, 200, "1ᵉ canal ok (FREE=1)");
  const c2 = await A.post("/api/channels/SMS", { provider: "TWILIO", account_sid: "AC", auth_token: "tok", from_number: "+15550001" });
  assert.equal(c2.http_status, 403, "2ᵉ canal refusé (FREE=1)");
  assert.match(c2.error || "", /Canaux/i, "raison lisible (Canaux)");
});

/* ================================================================ FACTURATION */
test("6. Upgrade fournisseur réel non configuré → CONFIGURATION_REQUIRED (rien n'est créé)", async () => {
  setPlan(A.orgId, { plan: "FREE" });
  const r = await A.post("/api/billing/upgrade", { plan: "PRO", provider: "CARD" });
  assert.equal(r.http_status, 409, "409 CONFIGURATION_REQUIRED");
  assert.equal(r.status, "CONFIGURATION_REQUIRED");
  assert.ok(Array.isArray(r.needs) && r.needs.length, "liste de ce qui manque");
  const bill = await A.get("/api/billing");
  assert.equal(bill.invoices.length, 0, "aucune facture créée (jamais simulée)");
  const pays = await A.get("/api/payments");
  assert.equal(pays.payments.length, 0, "aucun paiement factice");
  // Provider inconnu / test hors test
  const unk = await A.post("/api/billing/upgrade", { plan: "PRO", provider: "KESKINSA" });
  assert.equal(unk.http_status, 400, "fournisseur inconnu → 400");
});

test("7. Upgrade (double de test) : PENDING → confirmation fournisseur → plan activé", async () => {
  const r = await A.post("/api/billing/upgrade", { plan: "PRO", provider: "TEST" });
  assert.equal(r.http_status, 200, JSON.stringify(r));
  assert.equal(r.status, "PENDING");
  assert.match(r.invoice.number, /^INV-\d{4}-\d{4}$/, "numéro de facture");
  assert.equal(r.invoice.status, "OPEN");
  invoiceId = r.invoice.id;
  invoiceTx = r.payment.provider_transaction_id;
  assert.match(invoiceTx, /^TEST-/);
  // Plan PAS activé avant confirmation (règle absolue)
  const before = await A.get("/api/billing");
  assert.notEqual(before.effective_plan, "PRO", "plan inchangé avant confirmation");
  assert.equal(before.invoices[0].status, "OPEN");
  // Webhook signature invalide → 401
  const raw = JSON.stringify({ transaction_id: invoiceTx });
  const bad = await fetch(`${BASE}/api/webhooks/payments/TEST`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Provider-Signature": `sha256=${"ab".repeat(32)}` }, body: raw,
  });
  assert.equal(bad.status, 401, "signature invalide → 401");
  // Webhook signé → confirmé → facture PAID + plan PRO actif
  const wh = await payWebhook(invoiceTx);
  assert.equal(wh.status, 200, JSON.stringify(wh));
  assert.match(wh.message, /confirm/i);
  const after = await A.get("/api/billing");
  assert.equal(after.effective_plan, "PRO", "plan PRO activé APRÈS confirmation");
  assert.equal(after.status, "active", "statut active");
  assert.equal(after.invoices[0].status, "PAID", "facture PAID");
  assert.ok(after.period.end > new Date().toISOString(), "période de 30 jours posée");
  // Idempotence du webhook
  const wh2 = await payWebhook(invoiceTx);
  assert.match(wh2.message, /idempot/i, "re-webhook idempotent");
  assert.equal((await A.get("/api/billing")).invoices[0].status, "PAID", "toujours une seule facture PAID");
});

test("8. Downgrade : appliqué en fin de période (jamais rétroactif)", async () => {
  const d = await A.post("/api/billing/downgrade", { plan: "STARTER" });
  assert.equal(d.http_status, 200, JSON.stringify(d));
  assert.equal(d.pending_plan, "STARTER");
  const bill = await A.get("/api/billing");
  assert.equal(bill.effective_plan, "PRO", "plan PRO conservé tant que la période court");
  assert.equal(bill.pending_plan, "STARTER", "downgrade programmé");
  // Fin de période (sans annulation) → le downgrade s'applique, l'org reste active
  expireNow(A.orgId);
  const bill2 = await A.get("/api/billing");
  assert.equal(bill2.status, "active", "reste active (downgrade = continuation sur plan réduit)");
  assert.equal(bill2.effective_plan, "STARTER", "plan STARTER appliqué en fin de période");
  assert.equal(bill2.pending_plan, null, "pending consommé");
  // Downgrade vers un plan plus cher refusé
  const upAsDown = await A.post("/api/billing/downgrade", { plan: "PRO" });
  assert.equal(upAsDown.http_status, 400, "downgrade vers un plan plus cher → 400");
});

test("9. Annulation : actif jusqu'à fin de période, puis FREE (données conservées)", async () => {
  // Remettre l'org en PRO actif (période future)
  setPlan(A.orgId, { plan: "PRO", status: "active" });
  const c = await A.post("/api/billing/cancel", {});
  assert.equal(c.http_status, 200, JSON.stringify(c));
  const bill = await A.get("/api/billing");
  assert.equal(bill.status, "active", "reste actif jusqu'à fin de période");
  assert.ok(bill.cancelled_at, "cancelled_at posé");
  assert.match(bill.message || c.message || "", /jusqu'au|Gratuit/i, "message honnête");
  // Données conservées (aucune suppression)
  const leads = await A.get("/api/leads?page_size=5");
  assert.ok(Array.isArray(leads.leads), "leads encore accessibles");
  // Fin de période → expired + FREE
  expireNow(A.orgId);
  const bill2 = await A.get("/api/billing");
  assert.equal(bill2.status, "expired");
  assert.equal(bill2.effective_plan, "FREE");
});

test("10. Expiration du TRIAL : TRIAL_EXPIRED → FREE, données conservées (spec §4)", async () => {
  const T = new User("trialx");
  await T.setup();
  const t0 = await T.get("/api/billing");
  assert.equal(t0.status, "trial");
  // Ajouter des données puis faire expirer le trial
  await T.post("/api/leads", { name: "Lead Trial", source: "MANUAL" });
  const db = rawDb();
  db.prepare("UPDATE subscriptions SET trial_ends_at = '2020-01-01T00:00:00.000Z' WHERE organization_id = ?").run(T.orgId);
  db.close();
  const t1 = await T.get("/api/billing");
  assert.equal(t1.status, "expired", "trial expiré → expired (TRIAL_EXPIRED)");
  assert.equal(t1.effective_plan, "FREE", "rétrogradation honnête en FREE");
  // Données conservées
  const leads = await T.get("/api/leads?page_size=5");
  assert.equal(leads.leads.length, 1, "lead du trial conservé (aucune suppression)");
  // L'org ne peut plus consommer au-delà de FREE
  assert.equal((await T.get("/api/billing")).usage.leads.limit, 100, "limites FREE appliquées");
});

test("11. Annulation du TRIAL : passage immédiat en FREE", async () => {
  const T = new User("trialy");
  await T.setup();
  const c = await T.post("/api/billing/cancel", {});
  assert.equal(c.http_status, 200, JSON.stringify(c));
  const t1 = await T.get("/api/billing");
  assert.equal(t1.status, "active", "plus en trial");
  assert.equal(t1.effective_plan, "FREE", "FREE immédiat");
  assert.equal(t1.trial.ends_at, null, "échéance de trial levée");
});

test("12. Factures : liste, statuts honnêtes (PAID seulement après confirmation)", async () => {
  const inv = await A.get("/api/billing/invoices");
  assert.equal(inv.http_status, 200);
  assert.ok(inv.invoices.some((i) => i.id === invoiceId), "facture de l'upgrade présente");
  const paid = inv.invoices.find((i) => i.id === invoiceId);
  assert.equal(paid.status, "PAID", "PAID (confirmée par webhook)");
  assert.ok(paid.amount > 0, "montant réel du plan");
});

/* ================================================================ ISOLATION / RBAC */
test("13. Multi-tenant : re-scope ?organization_id= (membre) / 403 (non-membre)", async () => {
  // Orgs dédiées (A est déjà à 3 membres depuis le test 3 → limite FREE)
  const M1 = new User("mtowner");
  const M2 = new User("mtviewer");
  const M3 = new User("mtstranger");
  await M1.setup();
  await M2.setup();
  await M3.setup();
  // M3 n'est PAS membre de l'org M1 → 403
  const denied = await M3.get(`/api/billing?organization_id=${M1.orgId}`);
  assert.equal(denied.http_status, 403, "non-membre → 403 (pas de fuite)");
  // M1 invite M2 (VIEWER) dans son org
  const inv = await M1.post("/api/team/invites", { email: "mtviewer@t8.test", role: "VIEWER" });
  assert.equal(inv.http_status, 200, JSON.stringify(inv));
  // M2 (membre VIEWER) lit le billing de M1 via re-scope
  const read = await M2.get(`/api/billing?organization_id=${M1.orgId}`);
  assert.equal(read.http_status, 200, "VIEWER lit via re-scope");
  assert.equal(read.status, "trial", "données de M1 (trial)");
  // M2 n'agit pas (403)
  const up = await M2.post(`/api/billing/upgrade?organization_id=${M1.orgId}`, { plan: "PRO", provider: "TEST" });
  assert.equal(up.http_status, 403, "VIEWER ne fait pas d'upgrade");
  const down = await M2.post(`/api/billing/downgrade?organization_id=${M1.orgId}`, { plan: "FREE" });
  assert.equal(down.http_status, 403, "VIEWER ne fait pas de downgrade");
  // M2 lit son propre billing (pas celui de M1)
  const own = await M2.get("/api/billing");
  assert.equal(own.http_status, 200);
  assert.equal(own.status, "trial", "M2 en trial (son org)");
});

test("14. Page /dashboard/billing rendue (HTML, pas de JSON d'erreur)", async () => {
  const page = await A.get("/dashboard/billing");
  assert.equal(page.http_status, 200);
  assert.equal(typeof page.text, "string", "HTML renvoyé");
  assert.ok(page.text.includes("Facturation"), "titre facturation");
  assert.ok(page.text.includes("Utilisation"), "section utilisation");
  assert.ok(page.text.includes("CONFIGURATION_REQUIRED") || page.text.includes("CONNECTED"), "état fournisseurs honnête");
  // Page non connectée → /login (redirect non suivi)
  const anon = await fetch(BASE + "/dashboard/billing", { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/login");
});

test("15. Super-admin : suivi des organisations (fondation spec §25)", async () => {
  // Non super-admin → 403
  const denied = await A.get("/api/billing/admin");
  assert.equal(denied.http_status, 403, "non super-admin → 403");
  const list = await SA.get("/api/billing/admin");
  assert.equal(list.http_status, 200, JSON.stringify(list).slice(0, 200));
  assert.ok(list.organizations.length >= 3, "plusieurs orgs suivies");
  const aRow = list.organizations.find((o) => o.id === A.orgId);
  assert.ok(aRow, "org A présente");
  assert.ok("revenue_paid" in aRow, "revenue payé suivi (factures PAID)");
  // Super-admin applique un plan/trial à une org
  const set = await SA.post(`/api/billing/admin/organizations/${A.orgId}`, { plan: "BUSINESS", trial_days: 30 }, { method: "PUT" });
  assert.equal(set.http_status, 200, JSON.stringify(set));
  const bill = await A.get("/api/billing");
  assert.equal(bill.plan, "BUSINESS", "plan BUSINESS appliqué");
  assert.equal(bill.status, "trial", "trial 30 j relancé");
  assert.equal(bill.trial.days_left, 30);
});
