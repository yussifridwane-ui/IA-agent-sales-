// test/channels.test.js — Phase 6 : canaux officiels (WhatsApp / Messenger / Instagram / Email)
// Couvre : connexions + masquage des secrets, envois réels (payloads officiels
// vérifiés via transport mock piloté par API), test d'envoi, webhooks (signature
// HMAC, handshake, ingestion, idempotence, receipts, STOP → opt-out, création de
// lead inconnu), détection de réponse, anti-spam, routage, multi-tenant, RBAC.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = 3906;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `data/test-channels-${process.pid}.db`;

let server;
let out = "";

const BASE_ENV = () => ({
  ...process.env,
  DB_PATH: DB,
  APP_ENV: "test",
  SESSION_SECRET: "test-secret-32-octets-minimum-00",
  RATE_LIMIT_LOGIN: "100",
  RATE_LIMIT_REGISTER: "100",
  RATE_LIMIT_AI_PER_MIN: "200",
  AUTOMATION_TICK_MS: "3600000",
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
  constructor(name) { this.name = name; this.cookie = null; this.csrf = null; this.orgId = null; }
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
    return { status: r.status, http_status: r.status, ...j };
  }
  async get(path) {
    const r = await fetch(BASE + path, { headers: this.headers({ "X-Requested-With": "fetch" }) });
    const text = await r.text();
    let j = { text };
    try { j = JSON.parse(text); } catch {}
    return { status: r.status, http_status: r.status, ...j };
  }
  async setup() {
    const reg = await this.post("/api/register", {
      first_name: "User", last_name: this.name, email: `${this.name}@ch6.test`,
      password: "password123", company: `Org ${this.name}`, country: "TG", industry: "E-commerce",
    });
    assert.equal(reg.status, 200, "inscription");
    for (const b of [
      { step: 1 }, { step: 2, company_name: `Org ${this.name}` }, { step: 3, industry: "E-commerce" },
      { step: 4, country: "TG" }, { step: 5, currency: "XOF" }, { step: 6, goal: "Générer des leads" }, { step: 7 },
    ]) {
      const r = await this.post("/api/onboarding", b);
      assert.equal(r.status, 200, `onboarding step ${b.step}`);
    }
    await this.me();
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

const A = new User("chana");
const B = new User("chanb");
const V = new User("chanv"); // VIEWER de l'org A

let kofiLead = null, kofiCustomer = null;

/** Pilote le transport mock du SERVEUR (endpoint test-only). */
async function mockConfig(cfg = {}) {
  const r = await A.post("/api/channels/mock-config", cfg);
  assert.equal(r.http_status, 200, JSON.stringify(r));
  return r;
}
async function mockRequests() {
  const r = await A.get("/api/channels/mock-requests");
  assert.equal(r.http_status, 200);
  return r;
}

/** Poste un payload webhook Meta signé (HMAC-SHA256 du corps brut). */
async function webhook(path, payload, secret) {
  const raw = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${sig}` },
    body: raw,
  });
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, ...j, raw };
}

/* ================================================================ SETUP */
test("setup : orgs A/B/V, client + lead, 4 connexions de canaux", async () => {
  await A.setup();
  await B.setup();
  await V.setup();
  const inv = await A.post("/api/team/invites", { email: "chanv@ch6.test", role: "VIEWER" });
  assert.equal(inv.status, 200, JSON.stringify(inv));
  // Phase 8 — les nouvelles orgs démarrent en TRIAL (plan STARTER : 2 canaux).
  // Ce fichier teste l'abstraction canaux (4 canaux) : on place les orgs sur un
  // plan sans limite (ENTERPRISE) pour que les limites de plan n'interfèrent pas.
  {
    const dbx = new DatabaseSync(DB);
    for (const u of [A, B, V]) {
      dbx.prepare("UPDATE subscriptions SET plan='ENTERPRISE', status='active', trial_ends_at=NULL, trial_days=NULL WHERE organization_id=?").run(u.orgId);
    }
    dbx.close();
  }
  // Client + lead avec téléphone (WhatsApp) + e-mail
  const cust = await A.post("/api/customers", { first_name: "Kofi", last_name: "Canaux", email: "kofi@ch6.test", phone: "22890111111", country: "TG" });
  assert.equal(cust.status, 201, JSON.stringify(cust));
  kofiCustomer = cust.id;
  const lead = await A.post("/api/leads", { name: "Kofi Canaux", customer_id: kofiCustomer, phone: "22890111111", email: "kofi@ch6.test", score: 70, status: "QUALIFIED" });
  assert.equal(lead.status, 201, JSON.stringify(lead));
  kofiLead = lead.id;
  // Connexions des 4 canaux (webhook_secret fourni pour pouvoir signer les tests)
  const wa = await A.post("/api/channels/WHATSAPP", { phone_number_id: "123456", access_token: "EAAG-test-wa", verify_token: "vt-wa", webhook_secret: "ws-wa-secret" });
  assert.equal(wa.http_status, 200, JSON.stringify(wa));
  assert.equal(wa.status, "CONNECTED", "WhatsApp connecté (vérification mock OK)");
  const fb = await A.post("/api/channels/FACEBOOK_MESSENGER", { page_id: "pg123", access_token: "EAAG-test-fb", verify_token: "vt-fb", webhook_secret: "ws-fb-secret" });
  assert.equal(fb.http_status, 200);
  assert.equal(fb.status, "CONNECTED", "Messenger connecté");
  const ig = await A.post("/api/channels/INSTAGRAM", { ig_user_id: "ig456", access_token: "EAAG-test-ig", verify_token: "vt-ig", webhook_secret: "ws-ig-secret" });
  assert.equal(ig.http_status, 200);
  assert.equal(ig.status, "CONNECTED", "Instagram connecté");
  const em = await A.post("/api/channels/EMAIL", { smtp_host: "smtp.test.local", smtp_port: 587, smtp_user: "a@ch6.test", smtp_pass: "secret-smtp", from_email: "noreply@ch6.test" });
  assert.equal(em.http_status, 200);
  assert.equal(em.status, "CONNECTED", "SMTP connecté");
  // Identifiants plateforme du client
  const pid = await A.post(`/api/customers/${kofiCustomer}/platform-ids`, { facebook: "psid-123", instagram: "iguid-456" });
  assert.equal(pid.http_status, 200, JSON.stringify(pid));
  // Limites adaptées aux tests (le test 15 couvre l'anti-spam explicitement)
  const lim = await A.post("/api/automation/limits", { max_per_day: 50, max_per_week: 200, min_interval_minutes: 0, max_followups: 50 }, { method: "PUT" });
  assert.equal(lim.http_status, 200, JSON.stringify(lim));
});

/* ================================================================ TESTS */

test("1. Connexions : secrets JAMAIS retournés en clair (masquage)", async () => {
  const r = await A.get("/api/channels");
  assert.equal(r.http_status, 200);
  assert.equal(r.channels.length, 4, "4 canaux");
  const wa = r.channels.find((c) => c.channel === "WHATSAPP");
  assert.equal(wa.status, "CONNECTED");
  assert.equal(wa.config.access_token, "••••", "token masqué");
  assert.equal(wa.config.webhook_secret, "••••", "webhook_secret masqué");
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes("EAAG-test-wa"), "token jamais en clair dans la réponse");
  assert.ok(!raw.includes("ws-wa-secret"), "webhook_secret jamais en clair");
  assert.ok(!raw.includes("secret-smtp"), "mot de passe SMTP jamais en clair");
});

test("2. Vérification de connexion en échec → statut ERROR + last_error", async () => {
  await mockConfig({ reset: true, verifyStatus: 400, verifyError: "Invalid OAuth access token." });
  const bad = await A.post("/api/channels/WHATSAPP", { phone_number_id: "123456", access_token: "BAD-TOKEN" });
  assert.equal(bad.http_status, 200);
  assert.equal(bad.status, "ERROR", "statut ERROR après vérification échouée");
  assert.match(bad.verify_error || "", /Invalid OAuth/i, "erreur lisible");
  // Restauration
  await mockConfig({});
  const fix = await A.post("/api/channels/WHATSAPP", { phone_number_id: "123456", access_token: "EAAG-test-wa" });
  assert.equal(fix.status, "CONNECTED", "reconnecté");
});

test("3. Envoi WhatsApp : payload officiel exact + journalisation", async () => {
  await mockConfig({ reset: true });
  // Automation : LEAD_BECAME_HOT → SEND_MESSAGE WhatsApp
  const auto = await A.post("/api/automations", {
    name: "Relance WA", trigger: "LEAD_BECAME_HOT", status: "ACTIVE",
    conditions: [], actions: [{ action: "SEND_MESSAGE", channel: "WHATSAPP", content: "Bonjour Kofi, votre produit est disponible." }],
  });
  assert.equal(auto.http_status, 201, JSON.stringify(auto));
  await A.post(`/api/leads/${kofiLead}/move`, { status: "HOT" });
  const reqs = await mockRequests();
  const req = reqs.httpRequests.find((r) => r.url.endsWith("/123456/messages") && r.method === "POST");
  assert.ok(req, "appel au Cloud API WhatsApp effectué");
  assert.equal(req.token, "EAAG-test-wa", "Bearer token de la connexion");
  assert.equal(req.body.messaging_product, "whatsapp", "payload officiel messaging_product");
  assert.equal(req.body.to, "22890111111", "numéro du lead");
  assert.equal(req.body.type, "text");
  assert.match(req.body.text.body, /Bonjour Kofi/);
  // Journalisation OUT
  const msgs = await A.get("/api/channels/WHATSAPP/messages");
  const outMsg = msgs.messages.find((m) => m.direction === "OUT");
  assert.ok(outMsg, "message OUT journalisé");
  assert.equal(outMsg.status, "SENT");
  assert.ok(outMsg.provider_message_id, "provider_message_id renseigné");
  assert.equal(outMsg.lead_id, kofiLead);
});

test("4. Canal non configuré : échec HONNÊTE (jamais d'envoi simulé)", async () => {
  await mockConfig({ reset: true });
  const off = await A.post("/api/channels/WHATSAPP", {}, { method: "DELETE" });
  assert.equal(off.http_status, 200, "déconnecté");
  const t = await A.post("/api/channels/WHATSAPP/test", { to: "22890111111", message: "Test" });
  assert.equal(t.http_status, 200);
  assert.equal(t.status, "failed", "test d'envoi en échec");
  assert.match(t.error || "", /Canal non configuré/i, "message honnête");
  const reqs = await mockRequests();
  assert.equal(reqs.httpRequests.length, 0, "aucun appel réseau effectué");
  // Reconnexion pour la suite (config complète : verify_token + webhook_secret conservés)
  const back = await A.post("/api/channels/WHATSAPP", { phone_number_id: "123456", access_token: "EAAG-test-wa", verify_token: "vt-wa", webhook_secret: "ws-wa-secret" });
  assert.equal(back.status, "CONNECTED");
});

test("5. Messenger + Instagram : payloads officiels (PSID / UID)", async () => {
  await mockConfig({ reset: true });
  const auto = await A.post("/api/automations", {
    name: "Relance FB/IG", trigger: "DEAL_CREATED", status: "ACTIVE",
    conditions: [],
    actions: [
      { action: "SEND_MESSAGE", channel: "FACEBOOK_MESSENGER", content: "Suivi Messenger" },
      { action: "SEND_MESSAGE", channel: "INSTAGRAM", content: "Suivi Instagram" },
    ],
  });
  assert.equal(auto.http_status, 201);
  const deal = await A.post("/api/deals", { name: "Deal Canaux", value: 100000, probability: 50, lead_id: kofiLead });
  assert.equal(deal.http_status, 201, JSON.stringify(deal));
  const reqs = await mockRequests();
  const fbReq = reqs.httpRequests.find((r) => r.method === "POST" && r.url.endsWith("/me/messages") && r.body?.recipient?.id === "psid-123");
  assert.ok(fbReq, "appel Messenger avec le PSID du client");
  assert.equal(fbReq.body.message.text, "Suivi Messenger");
  const igReq = reqs.httpRequests.find((r) => r.method === "POST" && r.url.endsWith("/me/messages") && r.body?.recipient?.id === "iguid-456");
  assert.ok(igReq, "appel Instagram avec l'UID du client");
  assert.equal(igReq.body.message_format, "TEXT", "format texte officiel");
});

test("6. Adresse plateforme manquante → échec honnête", async () => {
  await mockConfig({ reset: true });
  const auto = await A.post("/api/automations", {
    name: "FB sans psid", trigger: "LEAD_CREATED", status: "ACTIVE",
    conditions: [{ field: "lead.source", operator: "=", value: "MANUAL" }],
    actions: [{ action: "SEND_MESSAGE", channel: "FACEBOOK_MESSENGER", content: "Bonjour" }],
  });
  assert.equal(auto.http_status, 201);
  const lead2 = await A.post("/api/leads", { name: "Sans PSID", source: "MANUAL", phone: "22890999999" });
  assert.equal(lead2.http_status, 201);
  // La création ci-dessus a déclenché l'automation (LEAD_CREATED)
  const msgs = await A.get("/api/channels/FACEBOOK_MESSENGER/messages");
  const failed = msgs.messages.find((m) => m.lead_id === lead2.id && m.direction === "OUT");
  assert.ok(failed, "tentative journalisée");
  assert.equal(failed.status, "FAILED");
  assert.match(failed.error || "", /manquante/i, "raison honnête : identifiant manquant");
  // Isolement : l'automation ne doit pas tirer sur les leads créés par la suite
  await A.post(`/api/automations/${auto.id}`, { status: "ARCHIVED" }, { method: "PUT" });
});

test("7. Email : dialogue SMTP (mock) + envoi", async () => {
  await mockConfig({ reset: true });
  const auto = await A.post("/api/automations", {
    name: "Relance e-mail", trigger: "DEAL_STAGE_CHANGED", status: "ACTIVE",
    conditions: [], actions: [{ action: "SEND_EMAIL", subject: "Votre proposition", content: "Bonjour, voici votre proposition." }],
  });
  assert.equal(auto.http_status, 201);
  const dealId = (await A.get("/api/deals?page_size=5")).deals.find((d) => d.name === "Deal Canaux")?.id;
  await A.post(`/api/deals/${dealId}`, { stage: "PROPOSAL" }, { method: "PUT" });
  const reqs = await mockRequests();
  const dial = reqs.smtpDialogues.find((d) => d.to === "kofi@ch6.test");
  assert.ok(dial, "dialogue SMTP effectué");
  assert.equal(dial.host, "smtp.test.local");
  assert.equal(dial.from, "noreply@ch6.test");
  assert.match(dial.subject, /proposition/i);
  const msgs = await A.get("/api/channels/EMAIL/messages");
  assert.ok(msgs.messages.some((m) => m.direction === "OUT" && m.status === "SENT"), "e-mail OUT SENT");
});

test("8. Webhook : handshake de vérification Meta (hub.challenge)", async () => {
  const ok = await fetch(`${BASE}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=vt-wa&hub.challenge=42-31`);
  assert.equal(ok.status, 200, "handshake OK");
  assert.equal(await ok.text(), "42-31", "challenge renvoyé");
  const bad = await fetch(`${BASE}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=FAUX&hub.challenge=42`);
  assert.equal(bad.status, 403, "token invalide refusé");
});

test("9. Webhook WhatsApp : message entrant → détection de réponse (follow-ups annulés)", async () => {
  // Un follow-up en attente pour Kofi
  const fu = await A.post("/api/followups", { lead_id: kofiLead, channel: "WHATSAPP", wait: "immediate", message: "Relance en attente" });
  assert.equal(fu.http_status, 201);
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ id: "e1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", phone_number_id: "123456",
      messages: [{ from: "22890111111", id: "wamid.IN-1", timestamp: "123", type: "text", text: { body: "Merci, je suis toujours intéressé." } }],
    } }],
    },
  ],
};
  const r = await webhook("/api/webhooks/whatsapp", payload, "ws-wa-secret");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(r.processed >= 1, "message traité");
  // Message entrant journalisé + lié au lead
  const msgs = await A.get("/api/channels/WHATSAPP/messages");
  const inMsg = msgs.messages.find((m) => m.direction === "IN" && m.provider_message_id === "wamid.IN-1");
  assert.ok(inMsg, "message IN journalisé");
  assert.equal(inMsg.lead_id, kofiLead, "lié au lead Kofi");
  // Détection de réponse : le follow-up en attente est annulé
  const fus = await A.get("/api/followups");
  const f = fus.followups.find((x) => x.id === fu.id);
  assert.equal(f.status, "CANCELLED", "follow-up en attente annulé");
  assert.match(f.cancel_reason || "", /réponse du prospect/i);
});

test("10. Webhook : signature invalide → 401", async () => {
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { phone_number_id: "123456", messages: [{ from: "22890111111", id: "wamid.IN-BAD", type: "text", text: { body: "x" } }] } }] }] };
  const raw = JSON.stringify(payload);
  const r = await fetch(BASE + "/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + "ab".repeat(32) },
    body: raw,
  });
  assert.equal(r.status, 401, "signature invalide refusée");
});

test("11. Webhook : connexion inconnue → 404", async () => {
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { phone_number_id: "999999", messages: [{ from: "1", id: "wamid.IN-UNK", type: "text", text: { body: "x" } }] } }] }] };
  const r = await webhook("/api/webhooks/whatsapp", payload, "ws-wa-secret");
  assert.equal(r.status, 404, "phone_number_id inconnu → 404");
});

test("12. Webhook : receipts (delivered → read) mis à jour", async () => {
  // Récupère l'ID provider d'un message OUT réellement envoyé (test 3)
  const msgs = await A.get("/api/channels/WHATSAPP/messages");
  const outMsg = msgs.messages.find((m) => m.direction === "OUT" && m.provider_message_id);
  assert.ok(outMsg, "un message OUT avec ID provider existe");
  const statusPayload = (status) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { phone_number_id: "123456", statuses: [{ id: outMsg.provider_message_id, status, recipient_id: "22890111111", timestamp: "124" }] } }] }] });
  const r1 = await webhook("/api/webhooks/whatsapp", statusPayload("delivered"), "ws-wa-secret");
  assert.equal(r1.status, 200);
  const m2 = await A.get("/api/channels/WHATSAPP/messages");
  assert.equal(m2.messages.find((m) => m.provider_message_id === outMsg.provider_message_id).status, "DELIVERED", "statut DELIVERED");
  await webhook("/api/webhooks/whatsapp", statusPayload("read"), "ws-wa-secret");
  const m3 = await A.get("/api/channels/WHATSAPP/messages");
  assert.equal(m3.messages.find((m) => m.provider_message_id === outMsg.provider_message_id).status, "READ", "statut READ");
});

test("13. Webhook : STOP → opt-out immédiat + lead créé pour inconnu", async () => {
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { phone_number_id: "123456", messages: [{ from: "22890222222", id: "wamid.IN-STOP", type: "text", text: { body: "STOP" } }] } }] }] };
  const r = await webhook("/api/webhooks/whatsapp", payload, "ws-wa-secret");
  assert.equal(r.status, 200);
  // Lead créé automatiquement (expéditeur inconnu)
  const leads = await A.get("/api/leads?page_size=50");
  const stopLead = leads.leads.find((l) => String(l.phone || "").replace(/[^\d]/g, "").endsWith("22890222222"));
  assert.ok(stopLead, "lead créé pour l'expéditeur inconnu");
  assert.equal(stopLead.source, "WHATSAPP");
  // Opt-out : préférences marketing = 0
  const db = new DatabaseSync(DB);
  const pref = db.prepare("SELECT * FROM communication_preferences WHERE lead_id = ?").get(stopLead.id);
  db.close();
  assert.ok(pref, "préférences créées");
  assert.equal(pref.marketing, 0, "marketing désactivé");
  assert.equal(pref.whatsapp, 0, "whatsapp désactivé");
  // Événement OPT_OUT journalisé
  const evs = await A.get("/api/automation/events?type=OPT_OUT");
  assert.ok(evs.events.some((e) => e.lead_id === stopLead.id), "événement OPT_OUT");
});

test("14. Webhook : idempotence (message en doublon ignoré)", async () => {
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { phone_number_id: "123456", messages: [{ from: "22890111111", id: "wamid.IN-1", type: "text", text: { body: "Merci, je suis toujours intéressé." } }] } }] }] };
  const r = await webhook("/api/webhooks/whatsapp", payload, "ws-wa-secret");
  assert.equal(r.status, 200);
  assert.equal(r.processed, 0, "doublon non re-traité");
  assert.equal(r.ignored, 1, "doublon ignoré");
});

test("15. Anti-spam appliqué aux canaux officiels (max/jour + intervalle minimum)", async () => {
  const lead3 = await A.post("/api/leads", { name: "Anti Spam", phone: "22890333333", email: "antispam@ch6.test" });
  assert.equal(lead3.http_status, 201);
  // a) Limite quotidienne : 1/jour → 2ᵉ relance bloquée
  await A.post("/api/automation/limits", { max_per_day: 1, min_interval_minutes: 0 }, { method: "PUT" });
  const f1 = await A.post("/api/followups", { lead_id: lead3.id, channel: "WHATSAPP", wait: "immediate", message: "Relance 1" });
  const f2 = await A.post("/api/followups", { lead_id: lead3.id, channel: "WHATSAPP", wait: "immediate", message: "Relance 2" });
  assert.equal(f1.http_status, 201);
  assert.equal(f2.http_status, 201);
  await A.post("/api/automation/tick", {});
  let fus = await A.get("/api/followups");
  const a = fus.followups.find((x) => x.id === f1.id);
  const b = fus.followups.find((x) => x.id === f2.id);
  console.error("DBG15 lead:", lead3.id, JSON.stringify((fus.followups || []).filter((x) => x.lead_id === lead3.id).map((x) => [x.message, x.status, x.cancel_reason, x.error, x.attempts])));
  assert.deepEqual([a.status, b.status].sort(), ["CANCELLED", "SENT"], `un envoyé, un bloqué : ${[a.status, b.status].sort()}`);
  const blocked = a.status === "CANCELLED" ? a : b;
  assert.match(blocked.cancel_reason || "", /quotidienne/i, "raison limite quotidienne");
  // b) Intervalle minimum : 60 min → une relance juste après une envoi est bloquée
  await A.post("/api/automation/limits", { max_per_day: 50, min_interval_minutes: 60 }, { method: "PUT" });
  const f3 = await A.post("/api/followups", { lead_id: lead3.id, channel: "WHATSAPP", wait: "immediate", message: "Relance 3" });
  assert.equal(f3.http_status, 201);
  await A.post("/api/automation/tick", {});
  fus = await A.get("/api/followups");
  const c = fus.followups.find((x) => x.id === f3.id);
  assert.equal(c.status, "CANCELLED", "intervalle minimum non respecté");
  assert.match(c.cancel_reason || "", /intervalle/i, "raison intervalle");
  // Restauration
  await A.post("/api/automation/limits", { max_per_day: 50, max_per_week: 200, min_interval_minutes: 0 }, { method: "PUT" });
});

test("16. Routage : meilleur canal selon coordonnées + canal préféré", async () => {
  const r = await A.get(`/api/leads/${kofiLead}/channel-routing`);
  assert.equal(r.http_status, 200);
  assert.equal(r.best_channel, "WHATSAPP", "téléphone + WhatsApp connecté → WHATSAPP");
  const pref = await A.post(`/api/leads/${kofiLead}/preferred-channel`, { channel: "EMAIL" }, { method: "PUT" });
  assert.equal(pref.http_status, 200);
  const r2 = await A.get(`/api/leads/${kofiLead}/channel-routing`);
  assert.equal(r2.best_channel, "EMAIL", "canal préféré respecté");
});

test("17. Multi-tenant : org B ne voit rien des connexions/messages de A", async () => {
  const r = await B.get("/api/channels");
  assert.equal(r.http_status, 200);
  assert.equal(r.channels.length, 0, "B : aucune connexion");
  const msgs = await B.get("/api/channels/WHATSAPP/messages");
  assert.equal(msgs.http_status, 200);
  assert.equal(msgs.messages.length, 0, "B : aucun message de A");
  // Un webhook du marqueur de A ne touche pas B
  const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { phone_number_id: "123456", messages: [{ from: "22890444444", id: "wamid.IN-B", type: "text", text: { body: "salut" } }] } }] }] };
  const r2 = await webhook("/api/webhooks/whatsapp", payload, "ws-wa-secret");
  assert.equal(r2.status, 200, "traité par l'org propriétaire de la connexion");
  const leadsB = await B.get("/api/leads?page_size=50");
  assert.equal(leadsB.leads.length, 0, "B : aucun lead créé par ce webhook");
});

test("18. RBAC : VIEWER lit les canaux mais ne les configure pas", async () => {
  const scope = `?organization_id=${A.orgId}`;
  const read = await V.get(`/api/channels${scope}`);
  assert.equal(read.http_status, 200, "VIEWER lit les connexions (masquées)");
  assert.equal(read.channels.length, 4);
  const write = await V.post(`/api/channels/WHATSAPP${scope}`, { phone_number_id: "123456", access_token: "x" });
  assert.equal(write.http_status, 403, "VIEWER ne configure pas");
  const tst = await V.post(`/api/channels/WHATSAPP/test${scope}`, { to: "22890111111" });
  assert.equal(tst.http_status, 403, "VIEWER ne teste pas l'envoi");
});

test("19. Boîte de réception : page + API, aucun secret en clair", async () => {
  const r = await A.get("/api/channels/WHATSAPP/messages");
  assert.equal(r.http_status, 200);
  assert.ok(r.messages.length >= 3, "plusieurs messages (IN + OUT)");
  const directions = new Set(r.messages.map((m) => m.direction));
  assert.ok(directions.has("IN") && directions.has("OUT"), "entrants et sortants");
  const page = await A.get("/dashboard/channels");
  assert.equal(page.http_status, 200, "page canaux rendue");
  assert.ok(page.text.includes("Boîte de réception"), "section inbox présente");
  assert.ok(!page.text.includes("EAAG-test-wa"), "page : aucun secret en clair");
});
