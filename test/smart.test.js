// test/smart.test.js — Phase 4 : Smart Sales Engine
// Couvre le spec §2-§42 : scoring multi-dimensionnel explicable (borné 0-100),
// BANT, objections (type + sévérité), buying signals, hot leads, at-risk,
// Next Best Action explicable (confirm/idempotent + dismiss), timeline,
// Customer 360, coach IA, funnel + conversion, recommandations,
// deals risque/santé, filtres smart, duplication + fusion,
// isolation multi-tenant + permissions (VIEWER).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PORT = 3904;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `data/test-smart-${process.pid}.db`;

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
});

function waitForReady(proc, port, log) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`serveur ${port} non démarré :\n${log()}`)), 8000);
    proc.stdout.on("data", (d) => String(d).includes("démarré") && (clearTimeout(t), resolve()));
  });
}

function spawnServer(port, extraEnv = {}) {
  const proc = spawn("node", ["server/index.js"], {
    env: { ...BASE_ENV(), PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  return waitForReady(proc, port, () => out).then(() => proc);
}

test.before(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { unlinkSync(f); } catch {}
  }
  server = await spawnServer(PORT);
});

test.after(() => {
  server?.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { unlinkSync(f); } catch {}
  }
});

/* ---------- helpers ---------- */
class SmartUser {
  constructor(name) { this.name = name; this.cookie = null; this.csrf = null; this.orgId = null; this.conv = null; }
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
    return { status: r.status, ...j };
  }
  async get(path) {
    const r = await fetch(BASE + path, { headers: this.headers({ "X-Requested-With": "fetch" }) });
    const text = await r.text();
    let j = { text };
    try { j = JSON.parse(text); } catch {}
    return { status: r.status, ...j };
  }
  async setup() {
    const reg = await this.post("/api/register", {
      first_name: "User", last_name: this.name, email: `${this.name}@ai.test`,
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
    return r;
  }
  /** Message chat — poursuit la conversation par défaut (mémoire). */
  async chat(message, { fresh = false } = {}) {
    if (fresh) this.conv = null;
    const r = await this.post("/api/ai/chat", { message, conversation_id: this.conv || undefined });
    if (r.conversation_id) this.conv = r.conversation_id;
    return r;
  }
  async product(p) {
    const r = await this.post("/api/products", p);
    assert.equal(r.status, 201, JSON.stringify(p));
    return r;
  }
  async lead(p) {
    const r = await this.post("/api/leads", p);
    assert.equal(r.status, 201, JSON.stringify(p));
    return r;
  }
}

const A = new SmartUser("smarta");   // org propriétaire des données
const B = new SmartUser("smartb");   // org isolé (aucune donnée)
const V = new SmartUser("smartv");   // invité VIEWER de l'org A

const BANT_VALUES = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CONFIRMED"];
const assertDim = (dim) => {
  assert.ok(dim && Number.isFinite(dim.score), "dimension avec score numérique");
  assert.ok(dim.score >= 0 && dim.score <= 100, `score borné 0-100 : ${dim.score}`);
  assert.ok(Number.isFinite(dim.confidence), "confiance numérique");
};

/* ================================================================ SETUP */
test("setup : org A (catalogue + règles + agent + KB), org B vide, V (futur VIEWER d'A)", async () => {
  await A.setup();
  await B.setup();
  await V.setup();
  // Catalogue A — « ordispec » est un token UNIQUE (aucun autre produit ne l'a)
  // pour que l'appariement produit du flux IA soit déterministe.
  await A.product({ name: "Ordispec Pro X99", sku: "ORDISPEC-X99", price: 900000, stock_quantity: 10, low_stock_threshold: 2 });
  await A.product({ name: "Clavier QK45", sku: "CLAV-QK45", price: 120000, stock_quantity: 8, low_stock_threshold: 2 });
  const rules = await A.post("/api/agent/rules", { max_discount_percent: 10, negotiation_enabled: true, delivery_information: "Livraison 24h à Lomé" }, { method: "PUT" });
  assert.equal(rules.status, 200);
  const agent = await A.post("/api/agent/settings", { name: "Nova", tone: "friendly", status: "ACTIVE", welcome_message: "Bonjour ! Je suis Nova." }, { method: "PUT" });
  assert.equal(agent.status, 200, JSON.stringify(agent));
  const kb = await A.post("/api/knowledge/documents", { name: "Délais de livraison", type: "DELIVERY", content: "Livraison sous 24 heures à Lomé, 48-72 h en intérieur." });
  assert.equal(kb.status, 201);
  assert.equal(kb.doc_status, "READY", JSON.stringify(kb));
});

/* ================================================================ TESTS PHASE 4 */

test("1. scoring multi-dimensionnel + BANT : qualification avec budget/urgence (spec §1-§8, §13)", async () => {
  // Produit identifié (token unique), budget 800 000 (< prix 900 000), pas d'urgence
  const r = await A.chat("Bonjour, je cherche l'Ordispec Pro X99. Mon budget est de 800 000 FCFA. Je m'appelle Awa Qualif, mon e-mail est awa@qualif.test, tel 0701111001.", { fresh: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(r.metadata?.lead, "lead créé via chat");
  const leads = await A.get("/api/leads?page_size=100");
  const awa = leads.leads.find((l) => l.name === "Awa Qualif");
  assert.ok(awa, "lead Awa Qualif créé");
  assert.equal(awa.budget, 800000, "budget extrait sans invention");

  // Message 2 (intention commerciale) : budget remonté à 900 000 + urgence « cette semaine »
  const r2 = await A.chat("C'est parfait. Combien coute l'Ordispec Pro X99 avec 900 000 de budget ? Il me le faut cette semaine.");
  assert.equal(r2.status, 200);

  const d = await A.get(`/api/smart/leads/${awa.id}`);
  assert.equal(d.status, 200);
  const an = d.analysis;
  // 6 dimensions, chacune bornée 0-100 avec une confiance
  for (const k of ["intent", "engagement", "budget", "need", "urgency", "fit"]) assertDim(an.dimensions[k], k);
  assert.ok(Number.isFinite(an.lead_score) && an.lead_score >= 0 && an.lead_score <= 100, `score final borné : ${an.lead_score}`);
  // Explicabilité : raisons positives/négatives textuelles
  assert.ok(Array.isArray(an.reasons) && an.reasons.length >= 2, "raisons explicables");
  for (const rsn of an.reasons) assert.ok(String(rsn.text).length > 5, "raison lisible");
  assert.ok(Array.isArray(an.negatives), "négatifs en tableau");
  // BANT : 4 axes, valeurs dans l'énumération du spec
  for (const k of ["budget", "authority", "need", "timeline"]) {
    assert.ok(BANT_VALUES.includes(d.bant[k]), `BANT.${k} dans l'énumération : ${d.bant[k]}`);
  }
  assert.equal(d.bant.budget, "CONFIRMED", "budget ≥ prix → CONFIRMED");
  assert.equal(d.bant.timeline, "HIGH", "« cette semaine » → timeline HIGH");
  assert.equal(an.dimensions.budget.ratio, 1, "ratio budget/prix = 100 %");
  assert.equal(an.dimensions.urgency.score, 80, "urgence « cette semaine » = 80");
  // NBA explicable : budget compatible + urgence élevée → appeler
  assert.equal(an.next_best_action, "CALL_CUSTOMER", "NBA = CALL_CUSTOMER : " + an.next_best_action);
  assert.ok(String(an.next_best_action_reason).length > 10, "NBA justifiée");
  // Probabilité de conversion = estimation bornée (jamais de certitude inventée)
  assert.ok(an.conversion_probability >= 0 && an.conversion_probability <= 100, "probabilité bornée 0-100");
});

test("2. intention d'achat : deal auto-créé, hot lead, buying signals, NBA CREATE_DEAL (spec §11, §20-21)", async () => {
  const before = await A.get("/api/deals?page_size=100");
  const r = await A.chat("Bonjour, je veux commander l'Ordispec Pro X99 aujourd'hui, c'est urgent. Mon budget est de 1 000 000 FCFA. Je m'appelle Koffi Achat, mon e-mail est koffi@achat.test, tel 0702222002.", { fresh: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  const leads = await A.get("/api/leads?page_size=100");
  const koffi = leads.leads.find((l) => l.name === "Koffi Achat");
  assert.ok(koffi, "lead Koffi Achat créé");
  assert.equal(koffi.status, "HOT", "lead passé en HOT");
  // Le flux d'achat a créé le deal (jamais de valeur inventée : prix catalogue)
  const after = await A.get("/api/deals?page_size=100");
  assert.equal(after.deals.length, before.deals.length + 1, "un deal de plus");
  const deal = after.deals.find((x) => x.lead_id === koffi.id);
  assert.ok(deal, "deal lié au lead");
  assert.equal(deal.name, "Commande Ordispec Pro X99", "produit apparié de façon déterministe");
  assert.equal(deal.value, 900000, "valeur = prix catalogue");

  // Analyse (persistance) : hot + URGENT + CREATE_DEAL + signaux d'achat
  const an = await A.post(`/api/smart/leads/${koffi.id}/analyze`, {});
  assert.equal(an.status, 200, JSON.stringify(an));
  assert.ok([80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100].includes(an.lead_score), `score hot ≥ 80 : ${an.lead_score}`);
  assert.ok(["HIGH", "VERY_HIGH"].includes(an.purchase_intent), "intention d'achat haute : " + an.purchase_intent);
  assert.equal(an.next_best_action, "CREATE_DEAL", "NBA = CREATE_DEAL : " + an.next_best_action);

  const d = await A.get(`/api/smart/leads/${koffi.id}`);
  assert.equal(d.lead.hot, 1, "hot lead (score ≥ 80 + intention ≥ HIGH)");
  assert.equal(d.lead.priority, "URGENT", "priorité URGENT (hot + urgence)");
  assert.equal(d.lead.estimated_value, 900000, "valeur estimée = valeur du deal (jamais inventée)");
  // Signaux d'achat persistés (dédupliqués 24 h)
  assert.ok(d.buying_signals.length >= 1, "au moins un buying signal");
  assert.ok(d.buying_signals.some((s) => s.type === "PURCHASE"), "signal PURCHASE");
  assert.ok(d.buying_signals.every((s) => s.confidence >= 0 && s.confidence <= 100), "confiance bornée");
});

test("3. objection : détection (type + sévérité), NBA ANSWER_OBJECTION, résolution (spec §16-17, §23)", async () => {
  const r = await A.chat("Bonjour, le prix de l'Ordispec Pro X99 est trop cher pour mon budget. Je m'appelle Mensah Objection, mon e-mail est mensah@obj.test, tel 0703333003.", { fresh: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  const leads = await A.get("/api/leads?page_size=100");
  const mensah = leads.leads.find((l) => l.name === "Mensah Objection");
  assert.ok(mensah, "lead Mensah Objection créé");

  const an = await A.post(`/api/smart/leads/${mensah.id}/analyze`, {});
  assert.equal(an.status, 200);
  // Objection persistée avec type + sévérité
  const d = await A.get(`/api/smart/leads/${mensah.id}`);
  const obj = d.objections.find((o) => o.type === "PRICE");
  assert.ok(obj, "objection PRICE détectée et persistée");
  assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(obj.severity), "sévérité dans l'énumération");
  assert.equal(obj.severity, "MEDIUM", "« trop cher » = sévérité MEDIUM");
  assert.ok(obj.metadata && JSON.parse(obj.metadata).confidence > 0, "confiance de détection");
  // NBA : traiter l'objection avant de progresser
  assert.equal(an.next_best_action, "ANSWER_OBJECTION", "NBA = ANSWER_OBJECTION : " + an.next_best_action);
  assert.ok(String(d.analysis.next_best_action_reason).includes("PRICE"), "NBA cite l'objection : " + d.analysis.next_best_action_reason);
  // Coach IA : l'objection est dans le briefing
  assert.ok(d.coach.objections.some((o) => o.startsWith("PRICE")), "coach signale l'objection");

  // Résolution → plus de NBA ANSWER_OBJECTION
  const res = await A.post(`/api/smart/leads/${mensah.id}/objections/${obj.id}/resolve`, {});
  assert.equal(res.status, 200, JSON.stringify(res));
  const d2 = await A.get(`/api/smart/leads/${mensah.id}`);
  assert.equal(d2.objections.find((o) => o.id === obj.id).resolved, 1, "objection résolue");
  const an2 = await A.post(`/api/smart/leads/${mensah.id}/analyze`, {});
  assert.notEqual(an2.next_best_action, "ANSWER_OBJECTION", "NBA change après résolution");
  assert.equal(an2.next_best_action, "FOLLOW_UP", "NBA = FOLLOW_UP (budget à poser) : " + an2.next_best_action);
});

test("4. at-risk : forte intention + conversation abandonnée + tâche de suivi auto (spec §24, §33)", async () => {
  const r = await A.chat("Je veux commander l'Ordispec Pro X99. Je m'appelle Ata Risk, mon e-mail est ata@risk.test, tel 0704444004.", { fresh: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  // 2ᵉ + 3ᵉ messages : urgence + engagement (lèvent l'intention à HIGH, sans budget → NBA reste FOLLOW_UP)
  const r2 = await A.chat("C'est urgent, il me le faut aujourd'hui.");
  assert.equal(r2.status, 200);
  const r3 = await A.chat("Je confirme, je suis vraiment intéressé par l'Ordispec Pro X99.");
  assert.equal(r3.status, 200);
  const leads = await A.get("/api/leads?page_size=100");
  const ata = leads.leads.find((l) => l.name === "Ata Risk");
  assert.ok(ata, "lead Ata Risk créé");
  assert.ok(["HIGH", "VERY_HIGH"].includes(ata.purchase_intent), "intention haute : " + ata.purchase_intent);
  // Pas encore at-risk (conversation fraîche)
  const d0 = await A.get(`/api/smart/leads/${ata.id}`);
  assert.equal(d0.lead.at_risk, 0, "pas at-risk tant que la conversation est récente");

  // Simulation du temps : TOUTE la conversation datée de 8 jours
  // (l'abandon se mesure sur le DERNIER message client, dont le timestamp est le max)
  const db = new DatabaseSync(DB);
  db.prepare("UPDATE messages SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '-8 days') WHERE conversation_id = ?").run(A.conv);
  db.close();

  const an = await A.post(`/api/smart/leads/${ata.id}/analyze`, {});
  assert.equal(an.status, 200);
  const d = await A.get(`/api/smart/leads/${ata.id}`);
  assert.equal(d.lead.at_risk, 1, "lead chaud sans réponse depuis 8 jours → at-risk");
  assert.equal(an.next_best_action, "FOLLOW_UP", "NBA = FOLLOW_UP : " + an.next_best_action);
  assert.ok(d.lead.next_followup_at, "relance planifiée");
  // Tâche de suivi créée automatiquement (sans doublon)
  const tasks = await A.get(`/api/tasks?lead_id=${ata.id}`);
  const followTask = (tasks.tasks || []).find((t) => t.title.startsWith("Suivi IA"));
  assert.ok(followTask, "tâche de suivi auto créée");
  assert.equal(followTask.priority, "HIGH", "tâche haute priorité");
});

test("5. deals enrichis : risque + santé (spec §37-38)", async () => {
  const d = await A.get("/api/smart/deals");
  assert.equal(d.status, 200);
  assert.ok(d.deals.length >= 2, "deals enrichis");
  const byLead = (leadId) => d.deals.find((x) => x.lead_id === leadId);
  // Ata : inactif depuis 8 jours → risque MEDIUM + santé At Risk
  const leads = await A.get("/api/leads?page_size=100");
  const ata = leads.leads.find((l) => l.name === "Ata Risk");
  const koffi = leads.leads.find((l) => l.name === "Koffi Achat");
  const dealAta = byLead(ata.id);
  assert.ok(["MEDIUM", "HIGH"].includes(dealAta.risk), "deal at-risk : " + dealAta.risk);
  assert.ok(dealAta.risk_factors.length >= 1, "facteurs de risque explicables");
  assert.equal(dealAta.health, "At Risk", "santé At Risk");
  // Koffi : actif → sain
  const dealKoffi = byLead(koffi.id);
  assert.equal(dealKoffi.risk, "LOW", "deal frais : risque LOW");
  assert.equal(dealKoffi.health, "Healthy", "santé Healthy");
});

test("6. liste smart : filtres + tri (spec §30-31)", async () => {
  const all = await A.get("/api/smart/leads?page_size=100");
  assert.equal(all.status, 200);
  assert.ok(all.leads.length >= 4, "leads enrichis");
  assert.ok(all.filters.includes("hot") && all.filters.includes("at_risk") && all.filters.includes("ready_to_buy"), "filtres exposés");
  assert.ok(all.sorts.includes("score") && all.sorts.includes("priority"), "tris exposés");
  // Champs enrichis par lead
  const koffi = all.leads.find((l) => l.name === "Koffi Achat");
  assert.ok(koffi.messages_count >= 1, "messages_count");
  assert.equal(koffi.deal_value, 900000, "deal_value enrichi");
  // Filtres ciblés
  const hot = await A.get("/api/smart/leads?filter=hot");
  assert.ok(hot.leads.some((l) => l.name === "Koffi Achat"), "Koffi dans hot");
  assert.ok(!hot.leads.some((l) => l.name === "Awa Qualif"), "Awa (score < 80) hors hot");
  const intent = await A.get("/api/smart/leads?filter=high_intent");
  assert.ok(intent.leads.some((l) => l.name === "Koffi Achat"), "Koffi dans high_intent");
  assert.ok(!intent.leads.some((l) => l.name === "Mensah Objection"), "Mensah hors high_intent");
  const risk = await A.get("/api/smart/leads?filter=at_risk");
  assert.ok(risk.leads.some((l) => l.name === "Ata Risk"), "Ata dans at_risk");
  const ready = await A.get("/api/smart/leads?filter=ready_to_buy");
  assert.ok(ready.leads.some((l) => l.name === "Koffi Achat"), "Koffi prêt à acheter");
  // Tri par score : Koffi en tête
  const sorted = await A.get("/api/smart/leads?sort=score&page_size=100");
  assert.equal(sorted.leads[0].name, "Koffi Achat", "tri score : Koffi en tête");
});

test("7. NBA : confirmation idempotente + refus hors CREATE_DEAL + dismiss (spec §23, §26)", async () => {
  const leads = await A.get("/api/leads?page_size=100");
  const koffi = leads.leads.find((l) => l.name === "Koffi Achat");
  const mensah = leads.leads.find((l) => l.name === "Mensah Objection");
  const before = await A.get("/api/deals?page_size=100");
  // Koffi : le deal existe déjà (créé par le flux d'achat) → confirmation IDEMPOTENTE
  const conf = await A.post(`/api/smart/leads/${koffi.id}/nba/confirm`, {});
  assert.equal(conf.status, 200, "idempotent : " + JSON.stringify(conf));
  assert.ok(conf.deal, "deal existant retourné");
  const after = await A.get("/api/deals?page_size=100");
  assert.equal(after.deals.length, before.deals.length, "pas de deal en double");
  // Mensah : NBA ≠ CREATE_DEAL → refus
  const bad = await A.post(`/api/smart/leads/${mensah.id}/nba/confirm`, {});
  assert.equal(bad.status, 400, "confirm refusé sans NBA CREATE_DEAL");
  // Dismiss : la recommandation est mise en attente
  const dis = await A.post(`/api/smart/leads/${mensah.id}/nba/dismiss`, {});
  assert.equal(dis.status, 200, JSON.stringify(dis));
  const d = await A.get(`/api/smart/leads/${mensah.id}`);
  assert.equal(d.lead.next_best_action, "WAIT", "NBA → WAIT après dismiss");
});

test("8. timeline du lead : score, objections, signaux, activités, deals (spec §29)", async () => {
  const leads = await A.get("/api/leads?page_size=100");
  const koffi = leads.leads.find((l) => l.name === "Koffi Achat");
  const d = await A.get(`/api/smart/leads/${koffi.id}`);
  assert.ok(Array.isArray(d.timeline) && d.timeline.length >= 4, "timeline peuplée");
  const types = new Set(d.timeline.map((t) => t.type));
  assert.ok(types.has("lead"), "création du lead");
  assert.ok(types.has("score"), "évolution du score");
  assert.ok(types.has("signal"), "buying signal");
  assert.ok(types.has("activity"), "activité achat");
  assert.ok(types.has("deal"), "opportunité");
  // Tri décroissant par date
  for (let i = 1; i < d.timeline.length; i++) {
    assert.ok(new Date(d.timeline[i - 1].at) >= new Date(d.timeline[i].at), "tri décroissant");
  }
  // Historique du score : source smart_engine + raison lisible
  assert.ok(d.score_history.length >= 1, "historique du score");
  assert.equal(d.score_history[0].source, "smart_engine", "source smart_engine");
  assert.ok(String(d.score_history[0].reason).length > 5, "raison du changement de score");
});

test("9. follow-up : relance enregistrée, at-risk levé (spec §33)", async () => {
  const leads = await A.get("/api/leads?page_size=100");
  const ata = leads.leads.find((l) => l.name === "Ata Risk");
  const r = await A.post(`/api/smart/leads/${ata.id}/follow-up`, { message: "Relance test : êtes-vous toujours intéressé ?" });
  assert.equal(r.status, 200, JSON.stringify(r));
  const d = await A.get(`/api/smart/leads/${ata.id}`);
  assert.equal(d.lead.at_risk, 0, "at-risk levé après relance");
  assert.equal(d.lead.next_followup_at, null, "relance planifiée consommée");
  assert.ok(d.activities.some((a) => a.type === "FOLLOW_UP"), "activité FOLLOW_UP journalisée");
});

test("10. Customer 360 : vue unifiée du client (spec §35)", async () => {
  const leads = await A.get("/api/leads?page_size=100");
  const koffi = leads.leads.find((l) => l.name === "Koffi Achat");
  const d = await A.get(`/api/smart/customers/${koffi.customer_id}/360`);
  assert.equal(d.status, 200, JSON.stringify(d).slice(0, 300));
  assert.equal(d.profile.first_name, "Koffi", "profil client");
  assert.ok(d.leads.length >= 1, "leads du client");
  assert.equal(d.deals.length, 1, "deal du client");
  assert.ok(d.conversations.length >= 1, "conversations IA");
  assert.ok(d.activities.length >= 1, "activités");
  assert.equal(d.pipeline_value, 900000, "pipeline ouvert = valeur du deal");
  assert.equal(d.won_value, 0, "rien de gagné pour l'instant");
  assert.ok(d.score >= 80, "meilleur score du client");
});

test("11. funnel + conversion : données réelles (spec §39-40)", async () => {
  const d = await A.get("/api/smart/analytics/funnel");
  assert.equal(d.status, 200);
  assert.equal(d.funnel.length, 7, "7 étapes du pipeline");
  assert.deepEqual(d.funnel.map((f) => f.stage), ["NEW", "CONTACTED", "QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION", "WON"]);
  const byStage = Object.fromEntries(d.funnel.map((f) => [f.stage, f]));
  assert.equal(byStage.HOT.count, 2, "2 leads HOT (Koffi + Ata)");
  assert.equal(byStage.CONTACTED.count, 1, "1 lead CONTACTED (Awa)");
  assert.ok(byStage.NEW.count >= 1, "Mensah en NEW");
  for (const f of d.funnel) {
    assert.ok(f.conversion_to_next === null || (f.conversion_to_next >= 0 && f.conversion_to_next <= 100), "conversion bornée");
    assert.ok(f.value >= 0, "valeur positive");
  }
  assert.ok(d.conversions && typeof d.conversions.lead_to_qualified === "number", "conversions calculées");
  assert.ok(String(d.note).length > 5, "note sur la méthode (données réelles)");
});

test("12. recommandations IA : chiffres réels, liens (spec §41)", async () => {
  const d = await A.get("/api/smart/recommendations");
  assert.equal(d.status, 200);
  assert.ok(Array.isArray(d.recommendations) && d.recommendations.length >= 2, "recommandations");
  const types = d.recommendations.map((r) => r.type);
  assert.ok(types.includes("intent"), "reco forte intention");
  assert.ok(types.includes("ready"), "reco prêt à acheter");
  assert.ok(types.includes("new"), "reco nouveaux leads");
  for (const r of d.recommendations) {
    assert.ok(String(r.text).length > 5, "texte lisible");
    assert.ok(String(r.link).startsWith("/dashboard/"), "lien vers l'interface");
  }
});

test("13. coach IA : briefing complet pour le commercial (spec §36)", async () => {
  const leads = await A.get("/api/leads?page_size=100");
  const koffi = leads.leads.find((l) => l.name === "Koffi Achat");
  const an = await A.post(`/api/smart/leads/${koffi.id}/analyze`, {});
  assert.equal(an.status, 200);
  const c = an.coach;
  assert.ok(String(c.summary).length > 20, "résumé lisible");
  assert.ok(c.summary.includes("score"), "résumé cite le score");
  assert.ok(Array.isArray(c.strengths) && c.strengths.length >= 2, "points forts");
  assert.ok(Array.isArray(c.objections), "objections listées");
  assert.ok(Array.isArray(c.risks), "risques listés");
  assert.ok(String(c.opportunity).length > 5, "opportunité (valeur potentielle)");
  assert.ok(String(c.recommended_action).length > 5, "action recommandée");
  assert.ok(String(c.recommended_action_reason).length > 5, "action justifiée");
});

test("14. duplication : détection + fusion sécurisée (spec §34)", async () => {
  const leads = await A.get("/api/leads?page_size=100");
  const awa = leads.leads.find((l) => l.name === "Awa Qualif");
  // Doublon volontaire : même e-mail
  const dup = await A.lead({ name: "Awa Copie", email: "awa@qualif.test" });
  const found = await A.get(`/api/smart/leads/${awa.id}/duplicates`);
  assert.equal(found.status, 200);
  const hit = found.duplicates.find((x) => x.id === dup.id);
  assert.ok(hit, "doublon détecté");
  assert.equal(hit.reason, "même e-mail", "raison de la détection");
  // Fusion (le plus ancien est conservé)
  const m = await A.post(`/api/smart/leads/${awa.id}/merge`, { target_id: dup.id });
  assert.equal(m.status, 200, JSON.stringify(m));
  const gone = await A.get(`/api/leads/${dup.id}`);
  assert.equal(gone.status, 404, "lead fusionné supprimé");
  const kept = await A.get(`/api/leads/${awa.id}`);
  assert.equal(kept.status, 200, "lead conservé intact");
  // Fusion refusée sans coordonnées communes
  const solo = await A.lead({ name: "Solo Diff", email: "solo@diff.test", phone: "0705555005" });
  const denied = await A.post(`/api/smart/leads/${awa.id}/merge`, { target_id: solo.id });
  assert.equal(denied.status, 409, "fusion refusée sans coordonnées identiques");
});

test("15. isolation multi-tenant + permissions VIEWER sur /api/smart (spec §43)", async () => {
  const leads = await A.get("/api/leads?page_size=100");
  const koffi = leads.leads.find((l) => l.name === "Koffi Achat");
  // Org B (vide) ne voit rien de l'org A
  const bl = await B.get("/api/smart/leads?page_size=100");
  assert.equal(bl.status, 200);
  assert.equal(bl.leads.length, 0, "org B : aucun lead");
  const cross = await B.get(`/api/smart/leads/${koffi.id}`);
  assert.equal(cross.status, 404, "lead d'A invisible pour B (404, pas de fuite)");
  const c360 = await B.get(`/api/smart/customers/${koffi.customer_id}/360`);
  assert.equal(c360.status, 404, "customer 360 d'A invisible pour B");
  const bf = await B.get("/api/smart/analytics/funnel");
  assert.equal(bf.status, 200);
  assert.ok(bf.funnel.every((f) => f.count === 0), "funnel B vide");
  const br = await B.get("/api/smart/recommendations");
  assert.equal(br.recommendations.length, 0, "aucune reco pour B");
  // VIEWER de l'org A : lecture oui, écriture non
  const inv = await A.post("/api/team/invites", { email: "smartv@ai.test", role: "VIEWER" });
  assert.equal(inv.status, 200, JSON.stringify(inv));
  const scope = `?organization_id=${A.orgId}`;
  const vRead = await V.get(`/api/smart/leads${scope}`);
  assert.equal(vRead.status, 200, "VIEWER lit les leads d'A");
  assert.ok(vRead.leads.length >= 4, "tous les leads d'A");
  const vWrite = await V.post(`/api/smart/leads/${koffi.id}/analyze${scope}`, {});
  assert.equal(vWrite.status, 403, "VIEWER ne peut pas analyser (écriture)");
  // V n'est pas membre de B → 403
  const vB = await V.get(`/api/smart/leads?organization_id=${B.orgId}`);
  assert.equal(vB.status, 403, "V non membre de B → 403");
});
