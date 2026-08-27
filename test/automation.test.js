// test/automation.test.js — Phase 5 : Automation Engine + Follow-up + Séquences
// Couvre le spec §50-55 : automation trigger/condition/action, idempotence,
// anti-spam, opt-out, business hours + timezone, séquences + stop conditions,
// human handoff, lead WON, assignation, campagnes/segments, prédiction (features
// immuables + outcome), readiness, notifications, analytics, multi-tenant + RBAC.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PORT = 3905;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `data/test-automation-${process.pid}.db`;

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
  AUTOMATION_TICK_MS: "3600000", // le tick manuel (API) pilote les tests
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
  server?.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { unlinkSync(f); } catch {} }
});

/* ---------- helpers ---------- */
class User {
  constructor(name) { this.name = name; this.cookie = null; this.csrf = null; this.orgId = null; this.conv = null; this.userId = null; }
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
      first_name: "User", last_name: this.name, email: `${this.name}@ai5.test`,
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
  async chat(message, { fresh = false } = {}) {
    if (fresh) this.conv = null;
    const r = await this.post("/api/ai/chat", { message, conversation_id: this.conv || undefined });
    if (r.conversation_id) this.conv = r.conversation_id;
    return r;
  }
}

const A = new User("autoa"); // propriétaire
const B = new User("autob"); // org isolée
const C = new User("autoc"); // SALES_AGENT de l'org A

// État partagé
let zoeLead = null, zoeConv = null, zoeDeal = null, zoeAuto = null;
let cUserId = null;

async function tick() {
  const r = await A.post("/api/automation/tick", {});
  assert.equal(r.status, 200, "tick : " + JSON.stringify(r));
  return r;
}
async function events(filter = {}) {
  const q = new URLSearchParams(filter);
  const r = await A.get(`/api/automation/events?${q}`);
  assert.equal(r.status, 200);
  return r.events || [];
}
async function leadByName(name) {
  const r = await A.get("/api/leads?page_size=100");
  return r.leads.find((l) => l.name === name) || null;
}
async function tasksFor(leadId) {
  const r = await A.get(`/api/tasks?lead_id=${leadId}`);
  return r.tasks || [];
}
/** Timezone Africa/Lome : {hour, minute, weekday} d'un instant UTC. */
function lomeParts(iso) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Lome", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(dtf.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { hour: p.hour, minute: Number(p.minute), weekday: p.weekday };
}

/* ================================================================ SETUP */
test("setup : orgs A/B, C (SALES_AGENT), produit, agent, KB", async () => {
  await A.setup();
  await B.setup();
  await C.setup();
  const inv = await A.post("/api/team/invites", { email: "autoc@ai5.test", role: "SALES_AGENT" });
  assert.equal(inv.status, 200, JSON.stringify(inv));
  const team = await A.get("/api/team");
  const cMember = team.members.find((m) => m.email === "autoc@ai5.test");
  assert.ok(cMember, "C membre de l'org A");
  cUserId = cMember.user_id;
  // Produit à token UNIQUE ("ordinaf") pour un appariement déterministe
  const p = await A.post("/api/products", { name: "Ordinaf Pro Y77", sku: "ORDINAF-Y77", price: 700000, stock_quantity: 5, low_stock_threshold: 1 });
  assert.equal(p.status, 201, JSON.stringify(p));
  const rules = await A.post("/api/agent/rules", { max_discount_percent: 10, negotiation_enabled: true }, { method: "PUT" });
  assert.equal(rules.status, 200);
  const agent = await A.post("/api/agent/settings", { name: "Nova", tone: "friendly", status: "ACTIVE", welcome_message: "Bonjour ! Je suis Nova." }, { method: "PUT" });
  assert.equal(agent.status, 200, JSON.stringify(agent));
  const kb = await A.post("/api/knowledge/documents", { name: "Délais de livraison", type: "DELIVERY", content: "Livraison sous 24 heures à Lomé." });
  assert.equal(kb.status, 201);
  assert.equal(kb.doc_status, "READY");
  // Limites adaptées aux tests (séquences « immediate ») — l'anti-spam est testé explicitement en test 9
  const lim = await A.post("/api/automation/limits", { max_per_day: 50, max_per_week: 200, min_interval_minutes: 0, max_followups: 50 }, { method: "PUT" });
  assert.equal(lim.status, 200, JSON.stringify(lim));
});

/* ================================================================ TESTS */

test("1. Automation WHEN/IF/THEN : purchase → HOT → tâche + notification + événements", async () => {
  // WHEN LEAD_BECAME_HOT, IF score >= 75, THEN CREATE_TASK + NOTIFY_SALES_AGENT
  const auto = await A.post("/api/automations", {
    name: "Relance lead chaud", description: "Task + notification quand un lead devient chaud",
    trigger: "LEAD_BECAME_HOT", status: "ACTIVE",
    conditions: [{ field: "lead.score", operator: ">=", value: 75 }],
    actions: [{ action: "CREATE_TASK", title: "Hot : traiter rapidement", priority: "HIGH", due_days: 1 }, { action: "NOTIFY_SALES_AGENT", title: "Lead chaud détecté" }],
  });
  assert.equal(auto.http_status, 201, JSON.stringify(auto));
  zoeAuto = auto.id;
  // Purchase : crée un lead HOT (score ≥ 75) → événement LEAD_BECAME_HOT
  const r = await A.chat("Bonjour, je veux commander le Ordinaf Pro Y77 aujourd'hui, c'est urgent. Mon budget est de 800 000 FCFA. Je m'appelle Zoe Achat, mon e-mail est zoe@achat5.test, tel 0707777001.", { fresh: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  zoeConv = A.conv;
  zoeLead = await leadByName("Zoe Achat");
  assert.ok(zoeLead, "lead Zoe créé");
  assert.equal(zoeLead.status, "HOT", "lead créé HOT (purchase)");
  assert.ok(zoeLead.score >= 75, `score ≥ 75 : ${zoeLead.score}`);
  // Événements journalisés
  const evs = await events({});
  for (const t of ["CONVERSATION_STARTED", "PRODUCT_VIEWED", "PURCHASE_INTENT_DETECTED", "DEAL_CREATED", "LEAD_CREATED", "LEAD_BECAME_HOT"]) {
    assert.ok(evs.some((e) => e.type === t), `événement ${t} journalisé`);
  }
  // Deal auto avec ligne produit
  const deals = await A.get("/api/deals?page_size=100");
  zoeDeal = deals.deals.find((d) => d.lead_id === zoeLead.id);
  assert.ok(zoeDeal, "deal créé par le flux d'achat");
  assert.equal(zoeDeal.value, 700000, "valeur = prix catalogue (jamais inventée)");
  // Actions exécutées
  const tasks = await tasksFor(zoeLead.id);
  assert.ok(tasks.some((t) => t.title === "Hot : traiter rapidement"), "tâche créée par l'automation");
  const logsDbg = await A.get(`/api/automations/${zoeAuto}`);
  const notifs = await A.get("/api/notifications");
  assert.ok(notifs.notifications.some((n) => n.type === "AUTOMATION"), "notification commercial — logs: " + JSON.stringify(logsDbg.logs.map((l) => [l.action, l.status, l.error])));
  const logs = await A.get(`/api/automations/${zoeAuto}`);
  assert.ok(logs.logs.some((l) => l.action === "CREATE_TASK" && l.status === "SUCCESS"), "log SUCCESS CREATE_TASK");
  assert.ok(logs.logs.some((l) => l.action === "NOTIFY_SALES_AGENT" && l.status === "SUCCESS"), "log SUCCESS NOTIFY");
});

test("2. Idempotence / anti-spam (§51) : même événement 2 fois → une seule action", async () => {
  // Même trigger LEAD_BECAME_HOT (déplacement NEW → HOT)
  await A.post(`/api/leads/${zoeLead.id}/move`, { status: "NEW" });
  const move = await A.post(`/api/leads/${zoeLead.id}/move`, { status: "HOT" });
  assert.equal(move.status, 200);
  const tasks = await tasksFor(zoeLead.id);
  const hotTasks = tasks.filter((t) => t.title === "Hot : traiter rapidement");
  assert.equal(hotTasks.length, 1, "une seule tâche malgré 2 événements HOT");
  const logs = await A.get(`/api/automations/${zoeAuto}`);
  assert.ok(logs.logs.some((l) => l.status === "SKIPPED" && /dédup/i.test(l.error || "")), "log SKIPPED dédup 24h");
});

test("3. Condition non remplie → SKIPPED, aucune action", async () => {
  const auto = await A.post("/api/automations", {
    name: "Deal géant", trigger: "DEAL_CREATED", status: "ACTIVE",
    conditions: [{ field: "deal.value", operator: ">", value: 999999999 }],
    actions: [{ action: "CREATE_TASK", title: "Deal géant !" }],
  });
  assert.equal(auto.http_status, 201, "CREATE AUTO: " + JSON.stringify(auto));
  const before = (await A.get("/api/tasks?page_size=100")).tasks.length;
  const deal = await A.post("/api/deals", { name: "Deal petit", value: 100000, probability: 60, lead_id: zoeLead.id });
  assert.equal(deal.status, 201);
  const after = (await A.get("/api/tasks?page_size=100")).tasks.length;
  assert.equal(after, before, "aucune tâche créée (condition fausse)");
  const logs = await A.get(`/api/automations/${auto.id}`);
  assert.ok(logs.logs.some((l) => l.status === "SKIPPED" && /conditions/i.test(l.error || "")), "log SKIPPED conditions");
});

test("4. Canal non configuré : échec honnête immédiat + retry limité sur échec transitoire (§13, §31)", async () => {
  // A) EMAIL non configuré → FAILED immédiat avec erreur honnête (pas d'envoi simulé, pas de retry inutile)
  const fu = await A.post("/api/followups", { lead_id: zoeLead.id, channel: "EMAIL", wait: "immediate", message: "Relance e-mail test" });
  assert.equal(fu.status, 201, JSON.stringify(fu));
  await tick();
  const failed = (await A.get(`/api/followups?status=FAILED`)).followups.find((x) => x.id === fu.id);
  assert.ok(failed, "FAILED (canal non configuré)");
  assert.match(failed.error || "", /Canal non configuré/, "erreur honnête (pas d'envoi simulé)");
  const notifsA = await A.get("/api/notifications");
  assert.ok(notifsA.notifications.some((n) => n.type === "AUTOMATION_FAILED"), "notification interne d'échec");
  // B) Échec transitoire (WEBCHAT sans conversation) → retry limité : 3 tentatives max puis FAILED, jamais de boucle infinie
  const noConv = await A.post("/api/leads", { name: "No Conv", email: "noconv@retry5.test", phone: "0706555001" });
  assert.equal(noConv.status, 201);
  const fu2 = await A.post("/api/followups", { lead_id: noConv.id, channel: "WEBCHAT", wait: "immediate", message: "Relance sans conversation" });
  assert.equal(fu2.status, 201);
  await tick();
  let f = (await A.get(`/api/followups?status=SCHEDULED`)).followups.find((x) => x.id === fu2.id);
  assert.ok(f, "retry n°1 programmé");
  assert.equal(f.attempts, 1, "1ʳᵉ tentative");
  for (let i = 2; i <= 3; i++) {
    const db = new DatabaseSync(DB);
    db.prepare("UPDATE followup_history SET scheduled_at = datetime('now', '-1 minute') WHERE id = ?").run(fu2.id);
    db.close();
    await tick();
    f = i < 3
      ? (await A.get(`/api/followups?status=SCHEDULED`)).followups.find((x) => x.id === fu2.id)
      : (await A.get(`/api/followups?status=FAILED`)).followups.find((x) => x.id === fu2.id);
    assert.ok(f, i < 3 ? `retry n°${i} programmé` : "FAILED après 3 tentatives");
    assert.equal(f.attempts, i, `${i} tentatives`);
  }
  assert.ok(f.error, "erreur d'échec renseignée");
});

test("5. WEBCHAT : envoi réel + détection de réponse (§20)", async () => {
  const fu = await A.post("/api/followups", { lead_id: zoeLead.id, channel: "WEBCHAT", wait: "immediate", message: "Bonjour Zoe, votre Ordinaf Pro Y77 vous attend. Je reste disponible." });
  assert.equal(fu.status, 201);
  await tick();
  const sent = (await A.get(`/api/followups?status=SENT`)).followups.find((x) => x.id === fu.id);
  assert.ok(sent, "follow-up WEBCHAT envoyé");
  assert.ok(sent.sent_at, "sent_at renseigné");
  // Message réel dans la conversation (source followup)
  const conv = await A.get(`/api/ai/conversations/${zoeConv}`);
  const followupMsg = conv.messages.find((m) => m.role === "ASSISTANT" && m.metadata?.source === "followup");
  assert.ok(followupMsg, "message assistant inséré dans la conversation");
  // Le prospect répond → response_at + événement
  await A.chat("Oui, je suis toujours intéressé, merci !");
  const evs = await events({ lead_id: zoeLead.id });
  assert.ok(evs.some((e) => e.type === "RESPONSE_RECEIVED"), "événement RESPONSE_RECEIVED");
  const f2 = (await A.get(`/api/followups?status=SENT`)).followups.find((x) => x.id === fu.id);
  assert.ok(f2?.response_at, "response_at marqué sur le follow-up envoyé");
});

test("6. Mode APPROVAL_REQUIRED : validation commerciale avant envoi (§17)", async () => {
  const s = await A.post("/api/automation/settings", { followup_mode: "APPROVAL_REQUIRED" }, { method: "PUT" });
  assert.equal(s.status, 200, JSON.stringify(s));
  const fu = await A.post("/api/followups", { lead_id: zoeLead.id, channel: "WEBCHAT", wait: "immediate", message: "Relance à valider" });
  assert.equal(fu.status, 201);
  await tick();
  const pend = (await A.get(`/api/followups?status=PENDING_APPROVAL`)).followups.find((x) => x.id === fu.id);
  assert.ok(pend, "en attente de validation (non envoyé)");
  const notifs = await A.get("/api/notifications");
  assert.ok(notifs.notifications.some((n) => n.type === "FOLLOWUP_APPROVAL"), "notification de validation");
  const ap = await A.post(`/api/followups/${fu.id}/approve`, {});
  assert.equal(ap.http_status, 200, JSON.stringify(ap));
  assert.equal(ap.status, "SENT", "approuvé puis envoyé");
  const sent = (await A.get(`/api/followups?status=SENT`)).followups.find((x) => x.id === fu.id);
  assert.ok(sent, "envoyé après validation");
});

test("7. Mode MANUAL : l'IA prépare le message, ne l'envoie pas (§17)", async () => {
  await A.post("/api/automation/settings", { followup_mode: "MANUAL" }, { method: "PUT" });
  const fu = await A.post("/api/followups", { lead_id: zoeLead.id, channel: "WEBCHAT", wait: "immediate", message: "Relance manuelle" });
  assert.equal(fu.status, 201);
  await tick();
  const drafted = (await A.get(`/api/followups?status=DRAFTED`)).followups.find((x) => x.id === fu.id);
  assert.ok(drafted, "DRAFTED : message préparé, non envoyé");
  await A.post("/api/automation/settings", { followup_mode: "AUTO" }, { method: "PUT" });
});

test("8. Opt-out (§12, §52) : « STOP » → marketing arrêté immédiatement", async () => {
  const r = await A.chat("Bonjour, je cherche le Ordinaf Pro Y77. Je m'appelle Stop Test, mon e-mail est stop@opt5.test, tel 0704444004.", { fresh: true });
  assert.equal(r.status, 200);
  const stopConv = A.conv;
  await A.chat("STOP");
  const evs = await events({ type: "OPT_OUT" });
  assert.ok(evs.length >= 1, "événement OPT_OUT");
  // Un follow-up planifié après le STOP ne doit JAMAIS être envoyé
  const lead = await leadByName("Stop Test");
  const fu = await A.post("/api/followups", { lead_id: lead.id, channel: "WEBCHAT", wait: "immediate", message: "Relance après stop" });
  assert.equal(fu.status, 201);
  await tick();
  const cancelled = (await A.get(`/api/followups?status=CANCELLED`)).followups.find((x) => x.id === fu.id);
  assert.ok(cancelled, "follow-up annulé (opt-out)");
  assert.match(cancelled.cancel_reason || "", /opt-out/i, "raison opt-out");
  void stopConv;
});

test("9. Limites anti-spam (§11) : max/jour respecté", async () => {
  const lim = await A.post("/api/automation/limits", { max_per_day: 1 }, { method: "PUT" });
  assert.equal(lim.status, 200);
  const r = await A.chat("Bonjour, je cherche le Ordinaf Pro Y77. Je m'appelle Sena Limit, mon e-mail est sena@lim5.test, tel 0703333003.", { fresh: true });
  assert.equal(r.status, 200);
  const lead = await leadByName("Sena Limit");
  const f1 = await A.post("/api/followups", { lead_id: lead.id, channel: "WEBCHAT", wait: "immediate", message: "Première relance" });
  const f2 = await A.post("/api/followups", { lead_id: lead.id, channel: "WEBCHAT", wait: "immediate", message: "Seconde relance" });
  assert.equal(f1.status, 201);
  assert.equal(f2.status, 201);
  await tick();
  const f1row = (await A.get("/api/followups")).followups.find((x) => x.id === f1.id);
  const f2row = (await A.get("/api/followups")).followups.find((x) => x.id === f2.id);
  const statuses = [f1row.status, f2row.status].sort();
  assert.deepEqual(statuses, ["CANCELLED", "SENT"], `un envoyé, un bloqué : ${statuses}`);
  const blocked = f1row.status === "CANCELLED" ? f1row : f2row;
  assert.match(blocked.cancel_reason || "", /quotidienne/i, "raison limite quotidienne");
  await A.post("/api/automation/limits", { max_per_day: 10, max_per_week: 50 }, { method: "PUT" });
});

test("10. Business hours + timezone (§25-26) : jamais de message hors créneau", async () => {
  const bh = await A.post("/api/automation/settings", { business_hours: { days: [1, 2, 3, 4, 5], open: 180, close: 240 } }, { method: "PUT" });
  assert.equal(bh.status, 200, JSON.stringify(bh));
  const lead = await leadByName("Sena Limit");
  const fu = await A.post("/api/followups", { lead_id: lead.id, channel: "WEBCHAT", wait: "immediate", message: "Relance horaire" });
  assert.equal(fu.status, 201);
  const rows = (await A.get(`/api/followups?status=SCHEDULED`)).followups.filter((x) => x.id === fu.id);
  assert.ok(rows.length, "planifié");
  const p = lomeParts(rows[0].scheduled_at);
  assert.equal(p.hour, "03", `dans le créneau 03:00-04:00 de Lomé (heure Lomé ${p.hour}:${p.minute})`);
  const scheduledMs = new Date(rows[0].scheduled_at).getTime();
  assert.ok(scheduledMs >= Date.now() - 60e3, "pas dans le passé");
  await A.post("/api/automation/settings", { business_hours: { days: [0, 1, 2, 3, 4, 5, 6], open: 0, close: 1440 } }, { method: "PUT" });
});

test("11. Séquence 3 étapes : envoi progressif + complétion (§9, §34)", async () => {
  const seq = await A.post("/api/sequences", {
    name: "Seq Test", channel: "WEBCHAT", status: "ACTIVE",
    steps: [
      { wait: "immediate", subject: "Étape 1", content: "Bonjour {{first_name}}, étape un." },
      { wait: "immediate", subject: "Étape 2", content: "Étape deux." },
      { wait: "immediate", subject: "Étape 3", content: "Étape trois." },
    ],
  });
  assert.equal(seq.http_status, 201, JSON.stringify(seq));
  await A.chat("Bonjour, je cherche le Ordinaf Pro Y77. Je m'appelle Seq Test, mon e-mail est seq@test5.test, tel 0702222002.", { fresh: true });
  const lead = await leadByName("Seq Test");
  const st = await A.post(`/api/sequences/${seq.id}/start`, { lead_ids: [lead.id] });
  assert.equal(st.status, 200, JSON.stringify(st));
  assert.equal(st.enrolled, 1, "lead inscrit");
  await tick();
  let fu = (await A.get(`/api/followups?status=SENT`)).followups.filter((x) => x.sequence_id === seq.id);
  assert.equal(fu.length, 1, "étape 1 envoyée");
  assert.match(fu[0].message, /Seq/, "variable {{first_name}} rendue (échappée)");
  assert.ok(!fu[0].message.includes("{{"), "aucune variable non rendue");
  await tick();
  fu = (await A.get(`/api/followups?status=SENT`)).followups.filter((x) => x.sequence_id === seq.id);
  assert.equal(fu.length, 2, "étape 2 envoyée");
  await tick();
  fu = (await A.get(`/api/followups?status=SENT`)).followups.filter((x) => x.sequence_id === seq.id);
  assert.equal(fu.length, 3, "étape 3 envoyée");
  const db = new DatabaseSync(DB);
  const enr = db.prepare("SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND lead_id = ?").get(seq.id, lead.id);
  db.close();
  assert.equal(enr.status, "COMPLETED", "séquence complétée");
  const evs = await events({ type: "SEQUENCE_COMPLETED", lead_id: lead.id });
  assert.ok(evs.length >= 1, "événement SEQUENCE_COMPLETED");
});

test("12. Stop condition : réponse du client arrête la séquence (§10)", async () => {
  const seq = await A.post("/api/sequences", {
    name: "Seq Stop", channel: "WEBCHAT", status: "ACTIVE",
    steps: [
      { wait: "immediate", content: "Première relance séquence." },
      { wait: "immediate", content: "Deuxième relance séquence." },
    ],
  });
  assert.equal(seq.http_status, 201);
  const r2 = await A.chat("Bonjour, je cherche le Ordinaf Pro Y77. Je m'appelle Seq Réplique, mon e-mail est seqstop@stop5.test, tel 0701111001.", { fresh: true });
  assert.equal(r2.status, 200);
  const lead = await leadByName("Seq Réplique");
  assert.ok(lead, "lead Seq Réplique");
  const st2 = await A.post(`/api/sequences/${seq.id}/start`, { lead_ids: [lead.id] });
  assert.equal(st2.enrolled, 1, "lead inscrit");
  await tick();
  let sent = (await A.get(`/api/followups?status=SENT`)).followups.filter((x) => x.sequence_id === seq.id);
  assert.equal(sent.length, 1, "étape 1 envoyée");
  // Le client répond → stop
  await A.chat("Merci pour les infos, je reviens vers vous.");
  const db = new DatabaseSync(DB);
  const enr = db.prepare("SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND lead_id = ?").get(seq.id, lead.id);
  db.close();
  assert.equal(enr.status, "STOPPED", "séquence stoppée");
  assert.match(enr.stop_reason || "", /réponse|reponse/i, "raison : réponse du prospect");
  await tick();
  sent = (await A.get(`/api/followups?status=SENT`)).followups.filter((x) => x.sequence_id === seq.id);
  assert.equal(sent.length, 1, "étape 2 JAMAIS envoyée");
  const evs = await events({ type: "SEQUENCE_STOPPED", lead_id: lead.id });
  assert.ok(evs.length >= 1, "événement SEQUENCE_STOPPED");
});

test("13. Stop condition : prise en main humaine (handoff arrête la séquence, §10, §53)", async () => {
  const seq = await A.post("/api/sequences", {
    name: "Seq Handoff", channel: "WEBCHAT", status: "ACTIVE",
    steps: [{ wait: "immediate", content: "Relance avant handoff." }, { wait: "immediate", content: "Relance après handoff (interdite)." }],
  });
  assert.equal(seq.http_status, 201);
  const r = await A.chat("Bonjour, je cherche le Ordinaf Pro Y77. Je m'appelle Seq Handoff, mon e-mail est seqh@hand5.test, tel 0708888008.", { fresh: true });
  assert.equal(r.status, 200);
  const lead = await leadByName("Seq Handoff");
  const convBefore = A.conv;
  await A.post(`/api/sequences/${seq.id}/start`, { lead_ids: [lead.id] });
  await tick();
  // Demande de conseiller humain → handoff
  const rh = await A.chat("Je veux parler à un conseiller humain.");
  assert.equal(rh.status, 200);
  assert.ok(rh.metadata?.handoff, "handoff signalé");
  const conv = await A.get(`/api/ai/conversations/${convBefore}`);
  assert.equal(conv.conversation.status, "HANDOFF", "conversation en HANDOFF");
  const evs = await events({ type: "HUMAN_HANDOFF" });
  assert.ok(evs.length >= 1, "événement HUMAN_HANDOFF");
  const tasks = await tasksFor(lead.id);
  assert.ok(tasks.some((t) => t.title.startsWith("[Handoff IA]")), "ticket handoff créé");
  const notifs = await A.get("/api/notifications");
  assert.ok(notifs.notifications.some((n) => n.type === "HUMAN_HANDOFF"), "commercial notifié du handoff");
  // La séquence doit être stoppée au prochain tick
  await tick();
  const db = new DatabaseSync(DB);
  const enr = db.prepare("SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND lead_id = ?").get(seq.id, lead.id);
  db.close();
  assert.equal(enr.status, "STOPPED", "séquence arrêtée (prise en main humaine)");
  assert.match(enr.stop_reason || "", /humaine|réponse|reponse/i, "raison : prise en main humaine (ou réponse au moment du handoff)");
  const sent2 = (await A.get(`/api/followups?status=SENT`)).followups.filter((x) => x.sequence_id === seq.id);
  assert.equal(sent2.length, 1, "étape 2 jamais envoyée après handoff");
});

test("14. Action différée + garde (attendre → re-vérifier → agir ou annuler)", async () => {
  // Cas A : personne ne répond → l'action s'exécute après le délai
  const a1 = await A.post("/api/automations", {
    name: "Delay run", trigger: "LEAD_BECAME_HOT", status: "ACTIVE",
    conditions: [], actions: [{ action: "CREATE_TASK", title: "Delayed done", delay_minutes: 1, guard: { no_user_response: true } }],
  });
  assert.equal(a1.http_status, 201, JSON.stringify(a1));
  const l1 = await A.post("/api/leads", { name: "Delay Run", email: "delayrun@run5.test", phone: "0706666001" });
  assert.equal(l1.status, 201);
  await A.post(`/api/leads/${l1.id}/move`, { status: "HOT" });
  const db = new DatabaseSync(DB);
  const run = db.prepare("SELECT * FROM automation_runs WHERE lead_id = ? AND status = 'PENDING'").get(l1.id);
  assert.ok(run, "exécution différée PENDING");
  db.prepare("UPDATE automation_runs SET due_at = datetime('now', '-1 minute') WHERE id = ?").run(run.id);
  db.close();
  await tick();
  const tasks1 = await tasksFor(l1.id);
  assert.ok(tasks1.some((t) => t.title === "Delayed done"), "action exécutée après délai (personne n'a répondu)");
  // Cas B : le prospect répond pendant l'attente → annulation
  const a2 = await A.post("/api/automations", {
    name: "Delay cancel", trigger: "LEAD_BECAME_HOT", status: "ACTIVE",
    conditions: [], actions: [{ action: "CREATE_TASK", title: "Delayed cancelled", delay_minutes: 1, guard: { no_user_response: true } }],
  });
  assert.equal(a2.http_status, 201);
  await A.chat("Bonjour, je cherche le Ordinaf Pro Y77. Je m'appelle Delay Cancel, mon e-mail est delayc@run5.test, tel 0705555005.", { fresh: true });
  const l2 = await leadByName("Delay Cancel");
  const conv2 = A.conv;
  await A.post(`/api/leads/${l2.id}/move`, { status: "HOT" });
  const db2 = new DatabaseSync(DB);
  const run2 = db2.prepare("SELECT * FROM automation_runs WHERE lead_id = ? AND status = 'PENDING'").get(l2.id);
  assert.ok(run2, "exécution différée PENDING (cas B)");
  db2.prepare("UPDATE automation_runs SET due_at = datetime('now', '-1 minute') WHERE id = ?").run(run2.id);
  db2.close();
  await A.chat("Désolé, je repense mon projet."); // réponse pendant l'attente
  await tick();
  const db3 = new DatabaseSync(DB);
  const run3 = db3.prepare("SELECT * FROM automation_runs WHERE id = ?").get(run2.id);
  db3.close();
  assert.equal(run3.status, "CANCELLED", "exécution annulée (réponse du prospect)");
  const tasks2 = await tasksFor(l2.id);
  assert.ok(!tasks2.some((t) => t.title === "Delayed cancelled"), "aucune tâche créée");
  void conv2;
});

test("15. Assignation intelligente : lead HOT → membre le moins chargé (§21-22)", async () => {
  const rule = await A.post("/api/assignment-rules", {
    name: "Équipe de vente", strategy: "ROUND_ROBIN", team_member_ids: [cUserId, A.userId],
  });
  assert.equal(rule.status, 201, JSON.stringify(rule));
  const r = await A.chat("Je veux commander le Ordinaf Pro Y77. Je m'appelle Assign Hot, mon e-mail est assign@hot5.test, tel 0705555003.", { fresh: true });
  assert.equal(r.status, 200);
  const lead = await leadByName("Assign Hot");
  assert.equal(lead.status, "HOT");
  assert.ok(lead.assigned_to, "lead assigné automatiquement");
  assert.equal(lead.assigned_to, cUserId, "assigné au membre le moins chargé (C)");
});

test("16. Campagne + segment + template : ciblage, rendu des variables, empty segment", async () => {
  const tpl = await A.post("/api/message-templates", {
    name: "Relance polie", channel: "WEBCHAT",
    content: "Bonjour {{first_name}}, votre produit {{product_name}} vous attend. Cordialement, {{sales_agent}}.",
  });
  assert.equal(tpl.status, 201, JSON.stringify(tpl));
  const seg = await A.post("/api/segments", { name: "Leads chauds", definition: { score_min: 80 } });
  assert.equal(seg.status, 201, JSON.stringify(seg));
  assert.ok(seg.count >= 1, `segment non vide (${seg.count})`);
  const camp = await A.post("/api/campaigns", { name: "Campagne chauds", segment_id: seg.id, template_id: tpl.id, channel: "WEBCHAT" });
  assert.equal(camp.status, 201, JSON.stringify(camp));
  const started = await A.post(`/api/campaigns/${camp.id}/start`, {});
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.ok(started.sent >= 1, "messages planifiés pour le segment");
  // Rendu des variables dans les messages planifiés
  const fus = (await A.get(`/api/followups?status=SCHEDULED`)).followups.filter((f) => f.campaign_id === camp.id);
  assert.ok(fus.length >= 1, "follow-ups liés à la campagne");
  assert.match(fus[0].message, /Zoe/, "{{first_name}} rendu");
  assert.ok(!fus[0].message.includes("{{"), "aucune variable non rendue");
  // Étape 17 : segment vide → refus
  const segEmpty = await A.post("/api/segments", { name: "Leads perdus", definition: { statuses: ["LOST"] } });
  assert.equal(segEmpty.status, 201);
  assert.equal(segEmpty.count, 0, "segment vide");
  const camp2 = await A.post("/api/campaigns", { name: "Campagne vide", segment_id: segEmpty.id, template_id: tpl.id, channel: "WEBCHAT" });
  const failed = await A.post(`/api/campaigns/${camp2.id}/start`, {});
  assert.equal(failed.status, 400, "campagne sur segment vide refusée");
});

test("17. Lead/deal WON (§37, §54) : tout s'arrête + outcome enregistré", async () => {
  const r = await A.chat("Bonjour, je cherche le Ordinaf Pro Y77 pour mon entreprise. Je m'appelle Won Stop, mon e-mail est won@stop5.test, tel 0706666006.", { fresh: true });
  assert.equal(r.status, 200);
  const lead = await leadByName("Won Stop");
  const deal = await A.post("/api/deals", { name: "Deal Won", value: 500000, probability: 60, lead_id: lead.id });
  assert.equal(deal.status, 201);
  // Séquence active + étape 1 envoyée
  const seq = await A.post("/api/sequences", { name: "Seq Won", channel: "WEBCHAT", status: "ACTIVE", steps: [{ wait: "immediate", content: "Relance pré-WON." }, { wait: "immediate", content: "Relance post-WON (interdite)." }] });
  assert.equal(seq.http_status, 201);
  await A.post(`/api/sequences/${seq.id}/start`, { lead_ids: [lead.id] });
  await tick();
  let sent = (await A.get(`/api/followups?status=SENT`)).followups.filter((x) => x.sequence_id === seq.id);
  assert.equal(sent.length, 1, "étape 1 envoyée avant WON");
  // Deal WON
  const won = await A.post(`/api/deals/${deal.id}`, { stage: "WON" }, { method: "PUT" });
  assert.equal(won.status, 200, JSON.stringify(won));
  const lead2 = await leadByName("Won Stop");
  assert.equal(lead2.status, "WON", "lead passé en WON");
  const db = new DatabaseSync(DB);
  const enr = db.prepare("SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND lead_id = ?").get(seq.id, lead.id);
  db.close();
  assert.equal(enr.status, "STOPPED", "séquence stoppée");
  assert.match(enr.stop_reason || "", /gagné/i, "raison : deal gagné");
  const sent2 = (await A.get(`/api/followups?status=SENT`)).followups.filter((x) => x.sequence_id === seq.id);
  assert.equal(sent2.length, 1, "étape 2 jamais envoyée après WON");
  const evs = await events({ type: "DEAL_WON", lead_id: lead.id });
  assert.ok(evs.length >= 1, "événement DEAL_WON");
});

test("18. Prédiction : snapshot immuable + résolution du résultat (§35-38, §55)", async () => {
  const before = await A.get(`/api/predictions/${zoeLead.id}`);
  assert.equal(before.status, 200);
  assert.ok(before.predictions.length >= 1, "prédictions enregistrées");
  assert.equal(before.provider.label, "HEURISTIC ESTIMATE", "jamais présenté comme ML");
  assert.equal(before.provider.mode, "HEURISTIC");
  const p = before.predictions[0];
  assert.ok(p.features_snapshot.lead_score !== null, "features : lead_score");
  assert.ok("intent" in p.features_snapshot, "features : intent");
  assert.ok("budget" in p.features_snapshot, "features : budget");
  const snapshotBefore = JSON.stringify(p.features_snapshot);
  // Deal WON → outcome résolu
  const won = await A.post(`/api/deals/${zoeDeal.id}`, { stage: "WON" }, { method: "PUT" });
  assert.equal(won.status, 200, JSON.stringify(won));
  const after = await A.get(`/api/predictions/${zoeLead.id}`);
  const p2 = after.predictions[0];
  assert.equal(p2.actual_outcome, "WON", "actual_outcome = WON");
  assert.ok(p2.resolved_at, "resolved_at renseigné");
  assert.equal(JSON.stringify(p2.features_snapshot), snapshotBefore, "features originales NON modifiées rétroactivement");
});

test("19. Prediction Readiness : dataset + statut honnête (§40)", async () => {
  const r = await A.get("/api/predictions/readiness");
  assert.equal(r.http_status, 200);
  assert.ok(r.dataset.leads >= 6, "leads comptés");
  assert.ok(r.dataset.won >= 2, "deals WON comptés (Zoe + Won Stop)");
  assert.ok(r.dataset.resolved_predictions >= 2, "prédictions résolues");
  assert.equal(r.label, "HEURISTIC ESTIMATE");
  assert.equal(r.ready, false, "dataset insuffisant");
  assert.match(r.status, /insuffisant/i, "statut honnête");
  assert.ok(r.min_required >= 10, "seuil configurable");
  assert.ok(r.missing.length >= 1, "données manquantes listées");
  assert.ok(!/modèle ML/i.test(r.label), "pas de prétention ML");
});

test("20. Notifications : lecture + marquage lu (§23)", async () => {
  const r1 = await A.get("/api/notifications");
  assert.equal(r1.status, 200);
  assert.ok(r1.unread >= 1, "notifications non lues");
  const n = r1.notifications.find((x) => !x.read);
  const r2 = await A.post(`/api/notifications/${n.id}/read`, {});
  assert.equal(r2.status, 200);
  const r3 = await A.get("/api/notifications");
  assert.equal(r3.unread, r1.unread - 1, "unread décrémenté");
});

test("21. Analytics automation : mesures réelles + « Données insuffisantes » (§33-34, §46)", async () => {
  const r = await A.get("/api/automation/analytics");
  assert.equal(r.status, 200);
  assert.ok(r.has_data, "données présentes pour A");
  assert.ok(r.automations.executions >= 3, "automations exécutées");
  assert.ok(r.automations.SUCCESS >= 2, "succès");
  assert.ok(r.automations.SKIPPED >= 2, "skip (condition + dédup)");
  assert.ok(r.messages.sent >= 3, "messages envoyés");
  assert.ok(r.revenue_associated.total >= 1200000, `revenue associé ≥ 1 200 000 : ${r.revenue_associated.total}`);
  assert.match(r.revenue_associated.label, /associ/i, "« revenue associé », jamais « causé par l'IA »");
  // Org B : aucune donnée
  const rb = await B.get("/api/automation/analytics");
  assert.equal(rb.status, 200);
  assert.equal(rb.has_data, false, "B : aucune donnée");
  assert.match(rb.note || "", /Données insuffisantes/i, "message honnête");
});

test("22. Isolation multi-tenant + permissions (§56)", async () => {
  // Org B ne voit rien de A
  const autos = await B.get("/api/automations");
  assert.equal(autos.status, 200);
  assert.equal(autos.automations.length, 0, "B : aucune automation");
  const cross = await B.get(`/api/automations/${zoeAuto}`);
  assert.equal(cross.status, 404, "ID d'A → 404 (pas de fuite)");
  const crossScope = await B.get(`/api/automations?organization_id=${A.orgId}`);
  assert.equal(crossScope.status, 403, "re-scope non membre → 403");
  const crossPred = await B.get(`/api/predictions/${zoeLead.id}`);
  assert.equal(crossPred.status, 404, "prédiction d'A invisible pour B");
  // C (SALES_AGENT) : lecture oui, écriture non
  const cRead = await C.get(`/api/automations?organization_id=${A.orgId}`);
  assert.equal(cRead.status, 200, "C lit les automations");
  assert.ok(cRead.automations.length >= 3, "automations d'A visibles");
  const cWrite = await C.post(`/api/automations?organization_id=${A.orgId}`, { name: "Hack", trigger: "LEAD_CREATED", actions: [{ action: "ADD_NOTE", content: "x" }] });
  assert.equal(cWrite.status, 403, "C ne crée pas d'automation (automation:manage)");
});

test("23. A/B testing : fondation sans lancement auto (§47)", async () => {
  const exp = await A.post("/api/experiments", { name: "Message court vs consultatif", metric: "reply_rate" });
  assert.equal(exp.http_status, 201, JSON.stringify(exp));
  assert.equal(exp.message, "Expérience créée (brouillon) — lancement manuel requis (aucun lancement auto sur faibles volumes).");
  const v1 = await A.post(`/api/experiments/${exp.id}/variants`, { name: "Version A court" });
  assert.equal(v1.status, 201);
  const v2 = await A.post(`/api/experiments/${exp.id}/variants`, { name: "Version B consultatif" });
  assert.equal(v2.status, 201);
  const list = await A.get("/api/experiments");
  const e = list.experiments.find((x) => x.id === exp.id);
  assert.equal(e.status, "DRAFT", "aucun lancement automatique");
  assert.equal(e.variants.length, 2, "2 variants");
});
