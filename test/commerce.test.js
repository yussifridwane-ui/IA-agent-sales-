// test/commerce.test.js — Phase 7 : Devis + Commandes + Paiements
// Parcours complet : PROSPECT → DEVIS (envoi réel) → ACCEPTATION (lien public)
// → COMMANDE (idempotente) → PAIEMENT (jamais simulé : CONFIGURATION_REQUIRED
// en prod, double TEST en APP_ENV=test) → PROCESSING → COMPLETED → DEAL WON.
// Port 3911, base de test dédiée, transport mock (zéro réseau réel).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";

const PORT = 3911;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `data/test-commerce-${process.pid}.db`;
const PAY_WS = "test-ws-commerce";

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
      first_name: "User", last_name: this.name, email: `${this.name}@c7.test`,
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

const A = new User("commerca");
const B = new User("commercb");
const V = new User("commercav");

let prod = null, cust = null;
let quoteId = null, quoteToken = null, dealId = null;
let orderId = null, paymentId = null, payTx = null;

/* ================================================================ SETUP */
test("setup : orgs A/B/V, produit, client, invitation VIEWER", async () => {
  await A.setup();
  await B.setup();
  await V.setup();
  const inv = await A.post("/api/team/invites", { email: "commercav@c7.test", role: "VIEWER" });
  assert.equal(inv.status, 200, JSON.stringify(inv));
  const p = await A.post("/api/products", { name: "Ordinateur Pro", sku: "C7-1", price: "850000", stock_quantity: 5 });
  assert.equal(p.http_status, 201, JSON.stringify(p));
  prod = p;
  const c = await A.post("/api/customers", { first_name: "Ama", last_name: "Koffi", email: "ama@c7.test", phone: "22890123456" });
  assert.equal(c.http_status, 201, JSON.stringify(c));
  cust = c;
});

/* ================================================================ DEVIS */
test("1. Devis : création DRAFT, prix TOUJOURS catalogue, numérotation, totaux", async () => {
  const r = await A.post("/api/quotes", {
    customer_id: cust.id,
    items: [
      { product_id: prod.id, quantity: 2 },
      { product_id: prod.id, quantity: 1, unit_price: 1 }, // prix client ignoré
      { name: "Livraison", unit_price: 25000, quantity: 1 },
    ],
    notes: "Livraison à Lomé",
  });
  assert.equal(r.http_status, 201, JSON.stringify(r));
  assert.match(r.quote.number, /^DEV-\d{4}-\d{4}$/, "numéro séquentiel DEV-YYYY-NNNN");
  assert.equal(r.quote.status, "DRAFT");
  const lineProd = r.quote.items.filter((it) => it.product_id === prod.id);
  assert.equal(lineProd.length, 2);
  assert.ok(lineProd.every((it) => it.unit_price === 850000), "prix des lignes produit = catalogue (jamais le prix client)");
  assert.equal(r.quote.subtotal, 850000 * 3 + 25000, "sous-total");
  assert.equal(r.quote.total, 850000 * 3 + 25000, "total");
  assert.ok(r.quote.access_token, "token public présent");
  quoteId = r.quote.id;
  quoteToken = r.quote.access_token;
});

test("2. Devis : ligne invalide → 400 (jamais de prix négatif)", async () => {
  const bad = await A.post("/api/quotes", { items: [{ name: "X", unit_price: -5, quantity: 1 }] });
  assert.equal(bad.http_status, 400, "prix négatif refusé");
  const empty = await A.post("/api/quotes", { items: [] });
  assert.equal(empty.http_status, 400, "devis sans ligne refusé");
});

test("3. Devis : envoi SANS canal → échec honnête (jamais d'« envoyé » factice)", async () => {
  const r = await A.post(`/api/quotes/${quoteId}/send`, {});
  assert.equal(r.http_status, 200);
  assert.equal(r.status, "failed", "statut failed");
  assert.match(r.error || "", /non configuré/i, "raison honnête : " + r.error);
  const q = (await A.get(`/api/quotes/${quoteId}`)).quote;
  assert.equal(q.status, "DRAFT", "le devis reste DRAFT (rien n'a été envoyé)");
  const reqs = await A.get("/api/channels/mock-requests");
  assert.equal(reqs.smtpDialogues.length, 0, "aucun appel SMTP effectué");
});

test("4. Devis : envoi RÉEL (SMTP connecté) avec lien d'acceptation", async () => {
  const em = await A.post("/api/channels/EMAIL", { smtp_host: "smtp.c7.local", smtp_port: 587, smtp_user: "s@c7.test", smtp_pass: "secret-smtp-c7", from_email: "no-reply@c7.test" });
  assert.equal(em.status, "CONNECTED", JSON.stringify(em));
  const r = await A.post(`/api/quotes/${quoteId}/send`, {});
  assert.equal(r.status, "sent", JSON.stringify(r));
  assert.equal(r.channel, "EMAIL");
  const q = (await A.get(`/api/quotes/${quoteId}`)).quote;
  assert.equal(q.status, "SENT");
  assert.ok(q.sent_at, "sent_at horodaté");
  assert.ok(q.valid_until, "validité bornée (30 j par défaut)");
  const reqs = await A.get("/api/channels/mock-requests");
  const dial = [...reqs.smtpDialogues].reverse().find((d) => d.to === "ama@c7.test");
  assert.ok(dial, "e-mail envoyé au client");
  assert.match(dial.subject, /^Devis DEV-/, "objet = numéro du devis");
  assert.ok(dial.text.includes(`/quote/${quoteToken}`), "lien d'acceptation public dans le corps");
  assert.ok(dial.text.includes("2575000"), "total dans le corps");
});

test("5. Devis : vue publique → VIEWED + événement ; DRAFT masqué", async () => {
  const page = await fetch(`${BASE}/quote/${quoteToken}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Accepter le devis"), "boutons de décision présents");
  assert.ok(html.includes("Ama"), "client affiché");
  const q = (await A.get(`/api/quotes/${quoteId}`)).quote;
  assert.equal(q.status, "VIEWED", "consultation → VIEWED");
  // Un devis DRAFT (jamais envoyé) ne doit pas exposer son contenu
  const draft = await A.post("/api/quotes", { customer_id: cust.id, items: [{ product_id: prod.id, quantity: 1 }] });
  const dPage = await fetch(`${BASE}/quote/${draft.quote.access_token}`);
  const dHtml = await dPage.text();
  assert.ok(!dHtml.includes("Accepter le devis"), "pas de décision sur un devis non envoyé");
  assert.match(dHtml, /n'a pas encore été envoyé/i, "état « non envoyé » honnête");
});

test("6. Devis : acceptation publique → ACCEPTED + deal (valeur = total) + notification", async () => {
  const r = await fetch(`${BASE}/quote/${quoteToken}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "accept" }),
  });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.match(j.message, /accepté/i);
  const q = (await A.get(`/api/quotes/${quoteId}`)).quote;
  assert.equal(q.status, "ACCEPTED");
  assert.ok(q.decided_at, "décision horodatée");
  assert.ok(q.deal_id, "deal lié");
  dealId = q.deal_id;
  const deal = (await A.get(`/api/quotes/${quoteId}`)).deal;
  assert.equal(deal.value, 2575000, "valeur du deal = total du devis (jamais inventée)");
  // Re-décision → refusée (idempotence du cycle)
  const again = await fetch(`${BASE}/quote/${quoteToken}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "reject" }),
  });
  assert.equal(again.status, 409, "déjà traité → 409");
  // Notification de l'équipe
  const notif = await A.get("/api/notifications");
  assert.ok(notif.notifications.some((n) => n.type === "QUOTE_ACCEPTED"), "notification QUOTE_ACCEPTED");
});

test("7. Devis : rejet public → REJECTED + raison", async () => {
  const r2 = await A.post("/api/quotes", { customer_id: cust.id, items: [{ product_id: prod.id, quantity: 1 }] });
  await A.post(`/api/quotes/${r2.quote.id}/send`, {});
  const token2 = (await A.get(`/api/quotes/${r2.quote.id}`)).quote.access_token;
  await fetch(`${BASE}/quote/${token2}`, { headers: { "X-Requested-With": "fetch" } }); // → VIEWED
  const d = await fetch(`${BASE}/quote/${token2}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "reject", reason: "Trop cher" }),
  });
  assert.equal(d.status, 200);
  const q2 = (await A.get(`/api/quotes/${r2.quote.id}`)).quote;
  assert.equal(q2.status, "REJECTED");
  assert.equal(q2.decision_reason, "Trop cher");
});

test("8. Devis : expiration (valid_until passée) → EXPIRED, décision refusée", async () => {
  const r3 = await A.post("/api/quotes", { customer_id: cust.id, items: [{ product_id: prod.id, quantity: 1 }], valid_until: "2020-01-01" });
  await A.post(`/api/quotes/${r3.quote.id}/send`, {});
  const token3 = (await A.get(`/api/quotes/${r3.quote.id}`)).quote.access_token;
  const page = await fetch(`${BASE}/quote/${token3}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /expir/i, "page « expiré »");
  const d = await fetch(`${BASE}/quote/${token3}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "accept" }),
  });
  assert.equal(d.status, 409, "décision sur devis expiré → 409");
  const evs = await A.get("/api/automation/events?limit=50");
  assert.ok(evs.events.some((e) => e.type === "QUOTE_EXPIRED"), "événement QUOTE_EXPIRED");
});

test("9. Devis : PDF professionnel (zéro dépendance)", async () => {
  const r = await fetch(`${BASE}/api/quotes/${quoteId}/pdf`, { headers: { "X-Requested-With": "fetch", cookie: A.cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /application\/pdf/);
  assert.match(r.headers.get("content-disposition") || "", /attachment/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(buf.subarray(-10).toString().includes("%%EOF"), "PDF structuré (EOF)");
  assert.ok(buf.length > 500, "PDF non trivial");
  assert.ok(buf.toString("latin1").includes("DEV-2026-"), "numéro du devis dans le PDF");
});

test("10. Devis : annulation (DRAFT/SENT) + modification DRAFT seulement", async () => {
  const r4 = await A.post("/api/quotes", { customer_id: cust.id, items: [{ product_id: prod.id, quantity: 1 }] });
  // modification DRAFT : remise + recalcul
  const up = await A.post(`/api/quotes/${r4.quote.id}`, { discount: 10000 }, { method: "PUT" });
  assert.equal(up.http_status, 200, JSON.stringify(up));
  assert.equal(up.quote.total, 850000 - 10000, "total recalculé après remise");
  // envoi puis annulation
  await A.post(`/api/quotes/${r4.quote.id}/send`, {});
  const c = await A.post(`/api/quotes/${r4.quote.id}/cancel`, {});
  assert.equal(c.http_status, 200);
  const q4 = (await A.get(`/api/quotes/${r4.quote.id}`)).quote;
  assert.equal(q4.status, "CANCELLED");
  // plus modifiable
  const up2 = await A.post(`/api/quotes/${r4.quote.id}`, { discount: 0 }, { method: "PUT" });
  assert.equal(up2.http_status, 409, "CANCELLED non modifiable");
  // plus annulable
  const c2 = await A.post(`/api/quotes/${r4.quote.id}/cancel`, {});
  assert.equal(c2.http_status, 409, "CANCELLED non re-annulable");
});

/* ================================================================ COMMANDES */
test("11. Commande : création depuis devis ACCEPTÉ (idempotente) ; refus sinon", async () => {
  const o1 = await A.post("/api/orders", { quote_id: quoteId });
  assert.equal(o1.http_status, 201, JSON.stringify(o1));
  assert.match(o1.order.number, /^CMD-\d{4}-\d{4}$/);
  assert.equal(o1.order.status, "PENDING");
  assert.equal(o1.order.total, 2575000, "total = devis accepté");
  orderId = o1.order.id;
  const o2 = await A.post("/api/orders", { quote_id: quoteId });
  assert.equal(o2.http_status, 200, "idempotence : 200 (pas de 201)");
  assert.equal(o2.order.id, orderId, "même commande renvoyée");
  // Devis DRAFT → refusée
  const qd = await A.post("/api/quotes", { customer_id: cust.id, items: [{ product_id: prod.id, quantity: 1 }] });
  assert.equal((await A.post("/api/orders", { quote_id: qd.quote.id })).http_status, 409, "devis DRAFT → 409");
  assert.equal((await A.post("/api/orders", { quote_id: "non-uuid" })).http_status, 400, "devis inconnue → 400");
});

test("12. Commande : workflow PENDING → CONFIRMED ; PROCESSING avant PAID refusé", async () => {
  const c = await A.post(`/api/orders/${orderId}/confirm`, {});
  assert.equal(c.http_status, 200, JSON.stringify(c));
  assert.equal(c.order.status, "CONFIRMED");
  // PROCESSING sans paiement → refusé (jamais de traitement d'une commande non payée)
  const p = await A.post(`/api/orders/${orderId}/processing`, {});
  assert.equal(p.http_status, 409, JSON.stringify(p));
  assert.match(p.error || "", /PAID/i, "rappel : PAID d'abord");
});

test("13. Paiement : fournisseur réel non configuré → CONFIGURATION_REQUIRED (jamais simulé)", async () => {
  const r = await A.post("/api/payments", { order_id: orderId, provider: "CARD" });
  assert.equal(r.http_status, 409, JSON.stringify(r));
  assert.equal(r.status, "CONFIGURATION_REQUIRED");
  assert.ok(Array.isArray(r.needs) && r.needs.length, "ce qu'il manque est listé");
  assert.match(r.message || "", /jamais simulé|non configuré/i);
  // Aucun paiement n'a été créé
  const list = await A.get("/api/payments");
  assert.equal(list.payments.length, 0, "aucun paiement factice créé");
  // Statuts fournisseurs (honnêtes)
  const prov = await A.get("/api/payments/providers");
  const card = prov.providers.find((x) => x.provider === "CARD");
  assert.equal(card.status, "CONFIGURATION_REQUIRED");
  const mm = prov.providers.find((x) => x.provider === "MOBILE_MONEY");
  assert.equal(mm.status, "CONFIGURATION_REQUIRED");
});

test("14. Paiement TEST (double, APP_ENV=test) : PENDING → webhook signé → CONFIRMED → commande PAID", async () => {
  const r = await A.post("/api/payments", { order_id: orderId, provider: "TEST" });
  assert.equal(r.http_status, 201, JSON.stringify(r));
  assert.equal(r.payment.status, "PENDING");
  assert.match(r.payment.provider_transaction_id, /^TEST-/);
  paymentId = r.payment.id;
  payTx = r.payment.provider_transaction_id;
  // PAID manuel sans confirmation → impossible (aucun endpoint ; transition gardée)
  const proc = await A.post(`/api/orders/${orderId}/processing`, {});
  assert.equal(proc.http_status, 409, "processing refusé tant que non payé");
  // Webhook signature invalide → 401
  const raw = JSON.stringify({ transaction_id: payTx });
  const bad = await fetch(`${BASE}/api/webhooks/payments/TEST`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Provider-Signature": "sha256=" + "ab".repeat(32) }, body: raw,
  });
  assert.equal(bad.status, 401, "signature invalide → 401");
  // Webhook fournisseur sans secret → 401
  const noSecret = await fetch(`${BASE}/api/webhooks/payments/CARD`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(noSecret.status, 401, "fournisseur sans secret → 401");
  // Webhook transaction inconnue → 404
  const rawU = JSON.stringify({ transaction_id: "TEST-unknown" });
  const sigU = createHmac("sha256", PAY_WS).update(rawU, "utf8").digest("hex");
  const unk = await fetch(`${BASE}/api/webhooks/payments/TEST`, { method: "POST", headers: { "Content-Type": "application/json", "X-Provider-Signature": "sha256=" + sigU }, body: rawU });
  assert.equal(unk.status, 404, "transaction inconnue → 404");
  // Webhook signé → CONFIRMED + commande PAID
  const sig = createHmac("sha256", PAY_WS).update(raw, "utf8").digest("hex");
  const wh = await fetch(`${BASE}/api/webhooks/payments/TEST`, { method: "POST", headers: { "Content-Type": "application/json", "X-Provider-Signature": "sha256=" + sig }, body: raw });
  assert.equal(wh.status, 200, await wh.text().catch(() => ""));
  const o = (await A.get(`/api/orders/${orderId}`)).order;
  assert.equal(o.status, "PAID", "commande PAID via confirmation fournisseur");
  assert.ok(o.paid_at, "paid_at horodatée");
  const pay = (await A.get(`/api/payments/${paymentId}`)).payment;
  assert.equal(pay.status, "CONFIRMED");
  assert.ok(pay.confirmed_at, "confirmed_at horodatée");
  // Idempotence du webhook
  const wh2 = await fetch(`${BASE}/api/webhooks/payments/TEST`, { method: "POST", headers: { "Content-Type": "application/json", "X-Provider-Signature": "sha256=" + sig }, body: raw });
  assert.match((await wh2.json()).message || "", /idempot/i, "re-webhook idempotent");
});

test("15. Commande : PAID → PROCESSING → COMPLETED → deal WON + événements", async () => {
  const p = await A.post(`/api/orders/${orderId}/processing`, {});
  assert.equal(p.http_status, 200, JSON.stringify(p));
  assert.equal(p.order.status, "PROCESSING");
  const c = await A.post(`/api/orders/${orderId}/complete`, {});
  assert.equal(c.http_status, 200, JSON.stringify(c));
  const det = await A.get(`/api/orders/${orderId}`);
  assert.equal(det.order.status, "COMPLETED");
  assert.ok(det.order.completed_at);
  assert.equal(det.deal.stage, "WON", "deal lié → WON (revenus réels)");
  assert.equal(det.deal.probability, 100);
  // Transitions invalides
  assert.equal((await A.post(`/api/orders/${orderId}/complete`, {})).http_status, 409, "COMPLETED non re-terminable");
  // Événements du parcours (tous journalisés)
  const evs = await A.get("/api/automation/events?limit=100");
  const types = new Set(evs.events.map((e) => e.type));
  for (const t of ["QUOTE_CREATED", "QUOTE_SENT", "QUOTE_VIEWED", "QUOTE_ACCEPTED", "QUOTE_REJECTED", "QUOTE_EXPIRED", "ORDER_CREATED", "ORDER_PAID", "ORDER_COMPLETED", "PAYMENT_CONFIRMED", "DEAL_WON"]) {
    assert.ok(types.has(t), `événement ${t} journalisé`);
  }
});

test("16. Paiement : annulation (PENDING) + remboursement (cycle complet sur 2ᵉ commande)", async () => {
  // 2ᵉ parcours court : devis → acceptation → commande (pour le cycle paiement)
  const q5 = await A.post("/api/quotes", { customer_id: cust.id, items: [{ product_id: prod.id, quantity: 1 }] });
  await A.post(`/api/quotes/${q5.quote.id}/send`, {});
  const tok5 = (await A.get(`/api/quotes/${q5.quote.id}`)).quote.access_token;
  await fetch(`${BASE}/quote/${tok5}`, { headers: { "X-Requested-With": "fetch" } });
  const d5 = await fetch(`${BASE}/quote/${tok5}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "accept" }) });
  assert.equal(d5.status, 200);
  const o5 = await A.post("/api/orders", { quote_id: q5.quote.id });
  assert.equal(o5.http_status, 201);
  // Paiement 1 : créé puis ANNULLÉ (PENDING → CANCELLED)
  const r1 = await A.post("/api/payments", { order_id: o5.order.id, provider: "TEST" });
  assert.equal(r1.http_status, 201);
  const c1 = await A.post(`/api/payments/${r1.payment.id}/cancel`, {});
  assert.equal(c1.http_status, 200);
  assert.equal((await A.get(`/api/payments/${r1.payment.id}`)).payment.status, "CANCELLED");
  assert.equal((await A.post(`/api/payments/${r1.payment.id}/cancel`, {})).http_status, 409, "déjà annulé → 409");
  // Paiement 2 : confirmé par webhook puis REMBOURSÉ → commande REFUNDED
  const r2 = await A.post("/api/payments", { order_id: o5.order.id, provider: "TEST" });
  assert.equal(r2.http_status, 201);
  const raw2 = JSON.stringify({ transaction_id: r2.payment.provider_transaction_id });
  const sig2 = createHmac("sha256", PAY_WS).update(raw2, "utf8").digest("hex");
  const wh2 = await fetch(`${BASE}/api/webhooks/payments/TEST`, { method: "POST", headers: { "Content-Type": "application/json", "X-Provider-Signature": "sha256=" + sig2 }, body: raw2 });
  assert.equal(wh2.status, 200);
  const rfd = await A.post(`/api/payments/${r2.payment.id}/refund`, {});
  assert.equal(rfd.http_status, 200, JSON.stringify(rfd));
  assert.equal((await A.get(`/api/payments/${r2.payment.id}`)).payment.status, "REFUNDED");
  assert.equal((await A.get(`/api/orders/${o5.order.id}`)).order.status, "REFUNDED", "commande → REFUNDED");
  // Aucune donnée de carte, aucun paiement CARD factice (fournisseur non configuré)
  const list = await A.get("/api/payments");
  assert.ok(list.payments.every((p) => p.provider !== "CARD"), "aucun paiement CARD (non configuré)");
  assert.ok(list.payments.every((p) => !p.provider_payload || !/card|cvc|exp/i.test(String(p.provider_payload))), "aucune donnée de carte stockée");
});

/* ================================================================ ISOLATION / RBAC */
test("17. Multi-tenant : org B ne voit rien de A (listes vides + IDOR 404)", async () => {
  assert.equal((await B.get("/api/quotes")).quotes.length, 0, "B : 0 devis");
  assert.equal((await B.get("/api/orders")).orders.length, 0, "B : 0 commandes");
  assert.equal((await B.get("/api/payments")).payments.length, 0, "B : 0 paiements");
  assert.equal((await B.get(`/api/quotes/${quoteId}`)).http_status, 404, "IDOR devis → 404");
  assert.equal((await B.get(`/api/orders/${orderId}`)).http_status, 404, "IDOR commande → 404");
  assert.equal((await B.get(`/api/payments/${paymentId}`)).http_status, 404, "IDOR paiement → 404");
  // B ne peut pas créer de commande depuis le devis de A
  assert.equal((await B.post("/api/orders", { quote_id: quoteId })).http_status, 400, "devis de A inconnue pour B");
  // Re-scope non-membre → 403
  assert.equal((await B.get(`/api/quotes?organization_id=${A.orgId}`)).http_status, 403, "re-scope org non membre → 403");
});

test("18. RBAC : VIEWER lit (re-scope) mais n'agit pas ; reste OWNER de son org", async () => {
  const scope = `?organization_id=${A.orgId}`;
  const read = await V.get(`/api/quotes${scope}`);
  assert.equal(read.http_status, 200, "VIEWER lit les devis de A");
  assert.ok(read.quotes.length >= 3, "tous les devis visibles");
  const create = await V.post(`/api/quotes${scope}`, { items: [{ name: "x", unit_price: 1, quantity: 1 }] });
  assert.equal(create.http_status, 403, "VIEWER ne crée pas (403)");
  const act = await V.post(`/api/orders/${orderId}/complete${scope}`, {});
  assert.equal(act.http_status, 403, "VIEWER n'agit pas sur les commandes (403)");
  const pdf = await V.get(`/api/quotes/${quoteId}/pdf${scope}`);
  assert.equal(pdf.http_status, 200, "VIEWER peut lire le PDF");
  // V reste OWNER de son propre org (écriture OK)
  const own = await V.post(`/api/quotes?organization_id=${V.orgId}`, { items: [{ name: "Prestation V", unit_price: 100, quantity: 1 }] });
  assert.equal(own.http_status, 201, "V = OWNER de son org : création OK");
  assert.equal((await V.get(`/api/quotes?organization_id=${V.orgId}`)).quotes.length, 1, "son devis chez lui, pas chez A");
});

test("19. Pages : /dashboard/quotes et /dashboard/orders rendues (RBAC inclus)", async () => {
  const page1 = await A.get("/dashboard/quotes");
  console.error("DBG19:", page1.http_status, JSON.stringify(page1).slice(0, 300));
  const me19 = await A.me();
  console.error("DBG19b: me:", me19.s, !!me19.user, !!me19.organization);
  assert.equal(page1.http_status, 200, "page devis rendue");
  assert.ok(page1.text.includes("Devis"), "contenu devis");
  assert.ok(!page1.text.includes("secret-smtp-c7"), "aucun secret SMTP dans la page");
  const page2 = await A.get("/dashboard/quotes/" + quoteId);
  assert.equal(page2.http_status, 200, "détail devis rendu");
  assert.ok(page2.text.includes("PDF"), "action PDF présente");
  const page3 = await A.get("/dashboard/orders");
  assert.equal(page3.http_status, 200, "page commandes rendue");
  assert.ok(page3.text.includes("CONFIGURATION_REQUIRED"), "statut fournisseur honnête affiché");
  const vPage = await V.get(`/dashboard/orders?organization_id=${A.orgId}`);
  assert.equal(vPage.http_status, 200, "VIEWER lit la page commandes (re-scope)");
});
