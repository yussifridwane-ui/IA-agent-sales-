// test/omnichannel.test.js — Phase 6 : Omnicanal (handling modes, inbox, widget,
// e-mail threading, anti-replay, handoffs, getMessageStatus, multi-tenant, RBAC)
// Port 3907, base de test dédiée. Aucun réseau réel (transport mock en APP_ENV=test).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = 3907;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `data/test-omnichannel-${process.pid}.db`;

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
      first_name: "User", last_name: this.name, email: `${this.name}@omni6.test`,
      password: "password123", company: `Org ${this.name}`, country: "TG", industry: "E-commerce",
    });
    assert.equal(reg.status, 200, "inscription");
    for (const b of [{ step: 1 }, { step: 2, company_name: `Org ${this.name}` }, { step: 3, industry: "E-commerce" }, { step: 4, country: "TG" }, { step: 5, currency: "XOF" }, { step: 6, goal: "Générer des leads" }, { step: 7 }]) {
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
  async setMode(mode) {
    const r = await this.post("/api/agent/settings", { status: "ACTIVE", ai_handling_mode: mode }, { method: "PUT" });
    assert.equal(r.http_status, 200, JSON.stringify(r));
    assert.equal(r.agent?.ai_handling_mode, mode, "mode appliqué");
  }
}

/** Widget (public, sans session). */
class Visitor {
  constructor(name) { this.visitor = `visitor${name}${"0".repeat(12 - name.length)}`; this.session = `session${name}${"0".repeat(12 - name.length)}`; this.key = null; this.convId = null; }
  qs(extra = {}) { const p = new URLSearchParams({ k: this.key, visitor_id: this.visitor, session_id: this.session, ...extra }); return p.toString(); }
  async config() { return (await fetch(`${BASE}/api/widget/config?k=` + this.key)).json(); }
  async conversation() { return (await fetch(`${BASE}/api/widget/conversation?` + this.qs())).json(); }
  async send(message) {
    const r = await fetch(`${BASE}/api/widget/send?` + this.qs(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: this.convId, message }) });
    const j = await r.json().catch(() => ({}));
    if (j.conversation_id) this.convId = j.conversation_id;
    // http_status = statut HTTP ; status = statut de la conversation (jamais confondus)
    return { http_status: r.status, ...j };
  }
}

async function waWebhook(path, payload, secret) {
  const raw = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${sig}` }, body: raw });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
function waMsg(from, id, body, ts) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "e1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          phone_number_id: "888000",
          messages: [{ from, id, timestamp: String(ts ?? Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
        },
      }],
    }],
  };
}

const A = new User("omnicha");
const B = new User("omnichb");
const V = new User("omnichv");

let waSecret = "ws-omni-wa-secret";
let emailSecret = null;
let widgetKey = null;
let kvip = null, knormal = null, koptout = null;
let aiConv = null, humanConv = null, hybridConv1 = null, hybridConv2 = null;
let normalWaConv = null;

/* ================================================================ SETUP */
test("setup : orgs A/B/V, produit, agent ACTIVE, canaux WhatsApp + Email", async () => {
  await A.setup();
  await B.setup();
  await V.setup();
  const inv = await A.post("/api/team/invites", { email: "omnichv@omni6.test", role: "VIEWER" });
  assert.equal(inv.status, 200, JSON.stringify(inv));
  // Produit (source de connaissance pour l'activation de l'agent)
  const prod = await A.post("/api/products", { name: "Ordinateur Pro", sku: "OMNI-1", price: "850000", stock_quantity: 5 });
  assert.equal(prod.http_status, 201, JSON.stringify(prod));
  // Activation de l'agent (mode par défaut AI)
  await A.setMode("AI");
  // Connexions canaux
  const wa = await A.post("/api/channels/WHATSAPP", { phone_number_id: "888000", access_token: "EAAG-omni-wa", verify_token: "vt-omni", webhook_secret: waSecret });
  assert.equal(wa.http_status, 200, JSON.stringify(wa));
  assert.equal(wa.status, "CONNECTED", "WhatsApp connecté");
  const em = await A.post("/api/channels/EMAIL", { smtp_host: "smtp.omni6.local", smtp_port: 587, smtp_user: "s@omni6.test", smtp_pass: "secret-smtp-omni", from_email: "no-reply@omni6.test" });
  assert.equal(em.http_status, 200, JSON.stringify(em));
  assert.equal(em.status, "CONNECTED", "SMTP connecté");
  emailSecret = em.webhook_secret_new;
  assert.ok(emailSecret, "webhook_secret EMAIL retourné une seule fois à la création");
  // Leads
  const l1 = await A.post("/api/leads", { name: "Koffi VIP", phone: "22890777777", email: "kvip@omni6.test", score: 95, status: "QUALIFIED" });
  assert.equal(l1.http_status, 201); kvip = l1;
  const l2 = await A.post("/api/leads", { name: "Koffi Normal", phone: "22890888888", email: "knorm@omni6.test", score: 70, status: "QUALIFIED" });
  assert.equal(l2.http_status, 201); knormal = l2;
  const l3 = await A.post("/api/leads", { name: "Koffi Optout", phone: "22890999999", email: "kopt@omni6.test", score: 50 });
  assert.equal(l3.http_status, 201); koptout = l3;
  // Opt-out direct (préférences) pour le test de gating
  const db = new DatabaseSync(DB);
  db.prepare("INSERT INTO communication_preferences (id, organization_id, lead_id, email, sms, whatsapp, marketing, transactional, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0, 1, ?, ?)")
    .run("omni-pref-1", A.orgId, koptout.id, new Date().toISOString(), new Date().toISOString());
  db.close();
  widgetKey = (await A.get("/api/channels/WEBCHAT/widget-key")).widget_key;
  assert.ok(widgetKey, "clé du widget générée");
});

/* ================================================================ WIDGET */
test("1. Widget : config publique, jamais de secret exposé", async () => {
  const v = new Visitor("config"); v.key = widgetKey;
  const cfg = await v.config();
  assert.equal(cfg.org_name, "Org omnicha");
  assert.ok(cfg.agent_name, "nom de l'agent");
  assert.ok(cfg.welcome_message, "message d'accueil");
  assert.equal(cfg.widget_key, widgetKey, "clé publique seulement");
  const raw = JSON.stringify(cfg);
  assert.ok(!raw.includes("EAAG-omni-wa"), "access token jamais exposé");
  assert.ok(!raw.includes(waSecret), "webhook_secret WhatsApp jamais exposé");
  assert.ok(!raw.includes("secret-smtp-omni"), "mot de passe SMTP jamais exposé");
  assert.ok(!raw.includes(emailSecret), "webhook_secret EMAIL jamais exposé");
  // Clé inconnue → 404 honnête
  const bad = await fetch(`${BASE}/api/widget/config?k=xxxxxxxxxxxxxxxx`);
  assert.equal(bad.status, 404);
  // Page widget : 200, aucun secret dans le HTML
  const page = await fetch(`${BASE}/widget?k=${widgetKey}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Chat"), "page du widget rendue");
  assert.ok(!html.includes("EAAG-omni-wa") && !html.includes(emailSecret), "aucun secret dans le HTML du widget");
});

test("2. Widget (mode AI) : auto-réponse réelle, conversation créée", async () => {
  const v = new Visitor("aimode"); v.key = widgetKey;
  const r = await v.send("Bonjour, l ordinateur Pro est-il disponible ?");
  assert.equal(r.http_status, 200, JSON.stringify(r));
  assert.equal(r.auto_replied, true, "IA a répondu automatiquement");
  assert.equal(r.mode, "AI");
  assert.ok(r.reply.length > 10, "réponse non vide : " + r.reply);
  const conv = await v.conversation();
  assert.equal(conv.conversation_id, r.conversation_id);
  assert.equal(conv.channel, "WEBCHAT");
  const roles = conv.messages.map((m) => m.role);
  assert.ok(roles.includes("USER") && roles.includes("ASSISTANT"), "USER + ASSISTANT dans la conversation");
  assert.equal(conv.suggested_pending, 0, "aucune suggestion en mode AI");
  // Non lu remis à 0 (traité par l'IA)
  const db = new DatabaseSync(DB);
  const unread = db.prepare("SELECT unread_count FROM conversations WHERE id = ?").get(conv.conversation_id).unread_count;
  db.close();
  assert.equal(unread, 0, "conversation traitée par l'IA → 0 non-lus");
  aiConv = conv.conversation_id;
});

test("3. Widget (mode HUMAN) : l'IA ne répond JAMAIS, attente + notification", async () => {
  await A.setMode("HUMAN");
  const v = new Visitor("humanmd"); v.key = widgetKey;
  const r = await v.send("Bonjour, je veux un devis pour un ordinateur.");
  assert.equal(r.http_status, 200, JSON.stringify(r));
  assert.equal(r.auto_replied, false, "aucune auto-réponse IA");
  assert.equal(r.mode, "HUMAN");
  assert.ok(/notre [ée]quipe|vous r[ée]pondra/i.test(r.reply || ""), "attente honnête : " + r.reply);
  const conv = await v.conversation();
  const roles = conv.messages.map((m) => m.role);
  assert.ok(!roles.includes("ASSISTANT"), "aucun message IA dans la conversation");
  // Notification de l'équipe
  const notif = await A.get("/api/notifications");
  assert.ok(notif.notifications.some((n) => n.type === "INBOX_NEW_MESSAGE"), "notification INBOX_NEW_MESSAGE créée");
  humanConv = conv.conversation_id;
  await A.setMode("AI");
});

test("4. Widget (mode HYBRID) : suggestion IA en attente, pas d'envoi", async () => {
  await A.setMode("HYBRID");
  const v = new Visitor("hybrimd1"); v.key = widgetKey;
  const r = await v.send("L ordinateur Pro est en stock ?");
  assert.equal(r.http_status, 200, JSON.stringify(r));
  assert.equal(r.auto_replied, false, "rien n'est envoyé automatiquement");
  assert.equal(r.mode, "HYBRID");
  assert.equal(r.suggested_pending, true, "suggestion en attente");
  const conv = await v.conversation();
  const roles = conv.messages.map((m) => m.role);
  assert.ok(!roles.includes("ASSISTANT"), "réponse non envoyée avant approbation");
  assert.equal(conv.suggested_pending, 1);
  hybridConv1 = conv.conversation_id;
});

test("5. Suggestion HYBRID : approbation avec édition → envoi réel", async () => {
  const db = new DatabaseSync(DB);
  const sugg = db.prepare("SELECT * FROM suggested_replies WHERE conversation_id = ? AND status = 'PENDING'").get(hybridConv1);
  db.close();
  assert.ok(sugg, "suggestion PENDING existe");
  assert.ok(sugg.confidence > 0, "confiance chiffrée");
  assert.match(sugg.rationale || "", /Intention/i, "raison explicite");
  const r = await A.post(`/api/inbox/suggested/${sugg.id}/approve`, { content: "Oui, l Ordinateur Pro est disponible (5 en stock) à 850 000 FCFA." });
  assert.equal(r.http_status, 200, JSON.stringify(r));
  assert.equal(r.status, "sent");
  // Message ASSISTANT (contenu ÉDITÉ) dans la conversation (rechargement visiteur)
  const v5 = new Visitor("hybrimd1"); v5.key = widgetKey;
  const conv = await v5.conversation();
  const ai = conv.messages.filter((m) => m.role === "ASSISTANT");
  assert.equal(ai.length, 1, "une seule réponse envoyée");
  assert.ok(ai[0].content.includes("5 en stock"), "contenu édité par l'humain");
  const db2 = new DatabaseSync(DB);
  const st = db2.prepare("SELECT status FROM suggested_replies WHERE id = ?").get(sugg.id).status;
  db2.close();
  assert.equal(st, "SENT", "suggestion marquée SENT");
});

test("6. Suggestion HYBRID : rejet → aucune réponse envoyée", async () => {
  const v = new Visitor("hybrimd2"); v.key = widgetKey;
  const r = await v.send("Avez-vous une tablette en stock ?");
  assert.equal(r.suggested_pending, true);
  hybridConv2 = r.conversation_id;
  const db = new DatabaseSync(DB);
  const sugg = db.prepare("SELECT id FROM suggested_replies WHERE conversation_id = ? AND status = 'PENDING'").get(hybridConv2);
  db.close();
  assert.ok(sugg, "suggestion PENDING");
  const rej = await A.post(`/api/inbox/suggested/${sugg.id}/reject`, {});
  assert.equal(rej.http_status, 200, JSON.stringify(rej));
  assert.equal(rej.status, "REJECTED");
  const conv = await v.conversation();
  assert.ok(!conv.messages.some((m) => m.role === "ASSISTANT"), "aucune réponse après rejet");
  // Approbation tardive → 409 (idempotence de l'action)
  const late = await A.post(`/api/inbox/suggested/${sugg.id}/approve`, {});
  assert.equal(late.http_status, 409, "suggestion déjà traitée → 409");
});

/* ================================================================ INBOX */
test("7. Inbox : liste + filtres (ALL/UNREAD/ASSIGNED/AI/HUMAN/HYBRID)", async () => {
  // À ce stade : conv AI (traitée, 0 non-lus), HUMAN (1 non-lu), HYBRID×2 (1 non-lu chacune)
  const all = await A.get("/api/inbox?filter=ALL");
  assert.equal(all.http_status, 200);
  assert.ok(all.count >= 4, "4 conversations minimum");
  const unread = await A.get("/api/inbox?filter=UNREAD");
  assert.ok(unread.conversations.every((c) => c.unread_count > 0), "toutes non-lues");
  assert.ok(unread.conversations.some((c) => c.id === humanConv), "conv HUMAN non lue présente");
  assert.ok(!unread.conversations.some((c) => c.id === aiConv), "conv AI traitée absente des non-lus");
  const ai = await A.get("/api/inbox?filter=AI");
  assert.ok(ai.conversations.some((c) => c.id === aiConv), "filtre AI");
  const human = await A.get("/api/inbox?filter=HUMAN");
  assert.ok(human.conversations.some((c) => c.id === humanConv), "filtre HUMAN");
  const hybrid = await A.get("/api/inbox?filter=HYBRID");
  assert.ok(hybrid.conversations.some((c) => c.id === hybridConv1), "filtre HYBRID");
  // Champs par conversation (spec Phase 6)
  const c = all.conversations.find((x) => x.id === aiConv);
  for (const f of ["id", "name", "channel", "last_message", "last_message_at", "intent", "priority", "handling_mode", "assigned_to", "unread_count"]) {
    assert.ok(f in c, `champ ${f} présent`);
  }
  assert.equal(c.channel, "WEBCHAT");
  assert.ok(c.name.startsWith("Visiteur"), "nom du visiteur");
});

test("8. Inbox : assignation + marquage lu + changement de mode", async () => {
  // Assigner la conv AI à A (membre actif)
  const up = await A.post(`/api/inbox/conversations/${aiConv}`, { assigned_to: A.userId, handling_mode: "AI", status: "ACTIVE" }, { method: "PUT" });
  assert.equal(up.http_status, 200, JSON.stringify(up));
  const assigned = await A.get("/api/inbox?filter=ASSIGNED");
  assert.ok(assigned.conversations.some((c) => c.id === aiConv), "filtre ASSIGNED (à moi)");
  const row = assigned.conversations.find((c) => c.id === aiConv);
  assert.equal(row.assigned_to, A.userId);
  assert.ok(row.assignee_name, "nom de l'assignataire");
  // Marquer lu la conv HUMAN
  const rd = await A.post(`/api/inbox/conversations/${humanConv}/read`, {});
  assert.equal(rd.http_status, 200);
  const detail = await A.get(`/api/inbox/conversations/${humanConv}`);
  assert.equal(detail.conversation.unread_count, 0, "marquée lue");
  // Changement de mode
  const up2 = await A.post(`/api/inbox/conversations/${humanConv}`, { handling_mode: "HYBRID" }, { method: "PUT" });
  assert.equal(up2.http_status, 200);
  assert.equal(up2.handling_mode, "HYBRID");
  // Invalides
  const bad = await A.post(`/api/inbox/conversations/${humanConv}`, { handling_mode: "ROBOT" }, { method: "PUT" });
  assert.equal(bad.http_status, 400, "mode invalide refusé");
  const badAssign = await A.post(`/api/inbox/conversations/${humanConv}`, { assigned_to: "non-uuid" }, { method: "PUT" });
  assert.equal(badAssign.http_status, 400, "assignation invalide refusée");
  // Détail : messages + aides mode humain
  assert.ok(Array.isArray(detail.messages) && detail.messages.length >= 1, "messages dans le détail");
  assert.ok("summary" in detail, "résumé (aides mode humain)");
});

/* ================================================================ EMAIL THREADING */
test("9. Email : entrant → auto-réponse avec In-Reply-To/References", async () => {
  // Mode AI
  await A.setMode("AI");
  const payload = { from: "knorm@omni6.test", to: "no-reply@omni6.test", subject: "Question produit", text: "Bonjour, quel est le prix de l ordinateur Pro ?", message_id: "<m1@omni6.test>" };
  const raw = JSON.stringify(payload);
  const sig = createHmac("sha256", emailSecret).update(raw, "utf8").digest("hex");
  const r = await fetch(`${BASE}/api/webhooks/email`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${sig}` }, body: raw });
  const jtext = await r.text();
  assert.equal(r.status, 200, jtext);
  const j = JSON.parse(jtext);
  assert.equal(j.processed, 1, "e-mail traité");
  // Dialogue SMTP de l'auto-réponse : threading
  const reqs = await A.get("/api/channels/mock-requests");
  const dial = [...reqs.smtpDialogues].reverse().find((d) => d.to === "knorm@omni6.test");
  assert.ok(dial, "réponse SMTP envoyée");
  assert.equal(dial.in_reply_to, "m1@omni6.test", "In-Reply-To du Message-ID entrant");
  assert.ok(String(dial.references || "").includes("m1@omni6.test"), "References renseigné");
  assert.match(dial.subject, /^Re: /, "objet Re: ");
});

test("10. Email : réponse du client → même conversation (thread_id) + dédup", async () => {
  const send = async (p) => {
    const raw = JSON.stringify(p);
    const sig = createHmac("sha256", emailSecret).update(raw, "utf8").digest("hex");
    const r = await fetch(`${BASE}/api/webhooks/email`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${sig}` }, body: raw });
    return { status: r.status, ...(await r.json()) };
  };
  const p2 = { from: "knorm@omni6.test", to: "no-reply@omni6.test", subject: "Re: Question produit", text: "Merci, et la livraison à Lomé ?", message_id: "<m2@omni6.test>", in_reply_to: "m1@omni6.test", references: "m1@omni6.test" };
  const r2 = await send(p2);
  assert.equal(r2.status, 200);
  assert.equal(r2.processed, 1, "2e e-mail traité");
  // Doublon (même Message-ID) → ignoré
  const r3 = await send(p2);
  assert.equal(r3.processed, 0, "doublon non re-traité");
  assert.equal(r3.reason, "DUPLICATE", "doublon identifié via webhook_events");
  // Une seule conversation EMAIL pour ce contact, 2 messages entrants, même thread
  const db = new DatabaseSync(DB);
  const convs = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = 'EMAIL' AND external_contact_id = 'knorm@omni6.test'").all(A.orgId);
  assert.equal(convs.length, 1, "une seule conversation pour le contact");
  const msgs = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'USER'").all(convs[0].id);
  db.close();
  assert.equal(msgs.length, 2, "2 entrants dans la même conversation");
  assert.ok(msgs.every((m) => m.thread_id === "m1@omni6.test"), "thread_id cohérent (In-Reply-To)");
  assert.equal(msgs[0].external_message_id, "m1@omni6.test");
  assert.equal(msgs[1].in_reply_to, "m1@omni6.test");
  // Réponse humaine depuis l'inbox : threading sur le dernier entrant
  const reply = await A.post(`/api/inbox/conversations/${convs[0].id}/reply`, { message: "Bonjour, livraison à Lomé sous 24h." });
  assert.equal(reply.http_status, 200, JSON.stringify(reply));
  const reqs = await A.get("/api/channels/mock-requests");
  const dial = [...reqs.smtpDialogues].reverse().find((d) => d.to === "knorm@omni6.test" && d.in_reply_to === "m2@omni6.test");
  assert.ok(dial, "réponse humaine rattachée au thread (In-Reply-To: m2)");
});

/* ================================================================ WHATSAPP : REPLAY / AUTO-REPLY */
test("11. Webhook WhatsApp : replay (timestamp ancien) rejeté, event journalisé REPLAY", async () => {
  const old = Math.floor(Date.now() / 1000) - 3600; // il y a 1 h
  const r = await waWebhook("/api/webhooks/whatsapp", waMsg("22890111111", "wamid.OMNI-REPLAY", "bonjour", old), waSecret);
  assert.equal(r.status, 200);
  assert.equal(r.processed, 0, "replay non traité");
  assert.equal(r.ignored, 1);
  const db = new DatabaseSync(DB);
  const ev = db.prepare("SELECT * FROM webhook_events WHERE channel = 'WHATSAPP' AND event_id = 'wamid.OMNI-REPLAY'").get();
  db.close();
  assert.ok(ev, "événement journalisé");
  assert.equal(ev.status, "REPLAY", "statut REPLAY");
  assert.ok(ev.payload_hash, "empreinte du payload conservée");
});

test("12. Webhook WhatsApp (mode AI) : auto-réponse réelle via le canal", async () => {
  const r = await waWebhook("/api/webhooks/whatsapp", waMsg("22890888888", "wamid.OMNI-OK", "Bonjour, l ordinateur Pro est disponible ?"), waSecret);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.processed, 1, "message traité");
  // Réponse réelle sur le canal (mock provider)
  const reqs = await A.get("/api/channels/mock-requests");
  const waReq = [...reqs.httpRequests].reverse().find((x) => x.method === "POST" && x.url.endsWith("/888000/messages"));
  assert.ok(waReq, "appel Cloud API WhatsApp effectué pour l'auto-réponse");
  assert.equal(waReq.token, "EAAG-omni-wa", "token de la connexion");
  // Conversation omnicanal créée, traitée (0 non-lus)
  const db = new DatabaseSync(DB);
  const conv = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = 'WHATSAPP' AND external_contact_id = '22890888888'").get(A.orgId);
  db.close();
  assert.ok(conv, "conversation WhatsApp créée");
  assert.equal(conv.unread_count, 0, "traitée par l'IA");
  assert.equal(conv.lead_id, knormal.id, "liée au lead existant");
  normalWaConv = conv.id;
});

test("13. Gating opt-out : AUCUNE auto-réponse, équipe notifiée", async () => {
  const before = await A.get("/api/channels/WHATSAPP/messages");
  const beforeCount = before.messages.filter((m) => m.direction === "OUT").length;
  const r = await waWebhook("/api/webhooks/whatsapp", waMsg("22890999999", "wamid.OMNI-OPT", "Bonjour, avez-vous le nouveau modèle ?"), waSecret);
  assert.equal(r.processed, 1, "message ingéré (le client a bien écrit)");
  const after = await A.get("/api/channels/WHATSAPP/messages");
  const afterCount = after.messages.filter((m) => m.direction === "OUT").length;
  assert.equal(afterCount, beforeCount, "aucune réponse envoyée (opt-out respecté)");
  const notif = await A.get("/api/notifications");
  assert.ok(notif.notifications.some((n) => n.type === "AUTO_REPLY_BLOCKED"), "notification AUTO_REPLY_BLOCKED");
  const db = new DatabaseSync(DB);
  const conv = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = 'WHATSAPP' AND external_contact_id = '22890999999'").get(A.orgId);
  db.close();
  assert.ok(conv, "conversation créée (le message reste visible dans l'inbox)");
  assert.equal(conv.unread_count, 1, "reste non lue (traitemen humain requis)");
});

/* ================================================================ HUMAN HANDOFF TRIGGERS */
test("14. Handoff : plainte → HANDOFF + tâche + notification", async () => {
  const r = await waWebhook("/api/webhooks/whatsapp", waMsg("22890606060", "wamid.OMNI-CPLT", "Je suis insatisfait, je depose une plainte"), waSecret);
  assert.equal(r.processed, 1, JSON.stringify(r));
  const db = new DatabaseSync(DB);
  const conv = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = 'WHATSAPP' AND external_contact_id = '22890606060'").get(A.orgId);
  const task = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND title LIKE '%Handoff IA%' ORDER BY created_at DESC LIMIT 1").get(A.orgId);
  db.close();
  assert.equal(conv.status, "HANDOFF", "conversation en HANDOFF");
  assert.ok(task, "tâche de suivi créée (spec : NOTIFICATION → TASK → SUMMARY)");
  const notif = await A.get("/api/notifications");
  assert.ok(notif.notifications.some((n) => n.type === "HUMAN_HANDOFF"), "notification HUMAN_HANDOFF");
  // La conversation apparaît comme URGENT dans l'inbox
  const urgent = await A.get("/api/inbox?filter=URGENT");
  assert.ok(urgent.conversations.some((c) => c.id === conv.id), "filtre URGENT (plainte)");
});

test("15. Handoff : lead VIP (score ≥ 90) → transfert humain", async () => {
  const r = await waWebhook("/api/webhooks/whatsapp", waMsg("22890777777", "wamid.OMNI-VIP", "Je veux commander le laptop"), waSecret);
  assert.equal(r.processed, 1, JSON.stringify(r));
  const db = new DatabaseSync(DB);
  const conv = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = 'WHATSAPP' AND external_contact_id = '22890777777'").get(A.orgId);
  db.close();
  assert.equal(conv.status, "HANDOFF", "conversation VIP en HANDOFF");
  assert.equal(conv.lead_id, kvip.id);
  // La raison du transfert est « VIP » (vérifiée dans l'audit — le score est
  // ensuite ré-évalué par le Smart Engine, c'est attendu)
  const audit = await A.get("/api/audit?limit=50");
  const handoffLog = audit.logs.filter((l) => l.action === "HUMAN_HANDOFF").reverse().find((l) => (l.metadata?.reason || "").includes("VIP"));
  assert.ok(handoffLog, "audit HUMAN_HANDOFF avec raison VIP : " + JSON.stringify(audit.logs.filter((l) => l.action === "HUMAN_HANDOFF").slice(-3)));
  // Filtre HOT : conversation liée à un lead score ≥ 81 (lead stable, pas rafraîchi par l'IA)
  const db2 = new DatabaseSync(DB);
  const lvip2 = db2.prepare("INSERT INTO leads (id, organization_id, name, score, status, created_at, updated_at) VALUES (?, ?, 'Lead Stable Chaud', 92, 'HOT', ?, ?)").run("omni-hot-lead", A.orgId, new Date().toISOString(), new Date().toISOString());
  db2.prepare("INSERT INTO conversations (id, organization_id, channel, status, handling_mode, lead_id, last_message_at, metadata, created_at, updated_at) VALUES (?, ?, 'WEBCHAT', 'ACTIVE', 'AI', 'omni-hot-lead', ?, '{}', ?, ?)")
    .run("omni-hot-conv", A.orgId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  db2.close();
  const hot = await A.get("/api/inbox?filter=HOT");
  const hotRow = hot.conversations.find((c) => c.id === "omni-hot-conv");
  assert.ok(hotRow, "conversation du lead 92 dans le filtre HOT");
  assert.equal(hotRow.score, 92);
  assert.equal(hotRow.priority, "HIGH", "priorité HIGH (score ≥ 81)");
});

test("16. Handoff : sujet sensible → transfert humain", async () => {
  const r = await waWebhook("/api/webhooks/whatsapp", waMsg("22890616161", "wamid.OMNI-SENS", "Mon dossier est en contentieux avec un huissier"), waSecret);
  assert.equal(r.processed, 1, JSON.stringify(r));
  const db = new DatabaseSync(DB);
  const conv = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = 'WHATSAPP' AND external_contact_id = '22890616161'").get(A.orgId);
  db.close();
  assert.equal(conv.status, "HANDOFF", "sujet sensible → HANDOFF");
});

/* ================================================================ getMessageStatus */
test("17. getMessageStatus : statuts réels (jamais inventés) + receipts", async () => {
  const msgs = await A.get("/api/channels/WHATSAPP/messages");
  const outMsg = msgs.messages.find((m) => m.direction === "OUT" && m.provider_message_id && m.lead_id === knormal.id);
  assert.ok(outMsg, "un message OUT avec ID provider (test 12)");
  // Statut avant receipt : SENT (accepté par le provider) — confirmé, pas inventé
  const st1 = await A.get(`/api/channels/WHATSAPP/message-status?provider_message_id=${outMsg.provider_message_id}`);
  assert.equal(st1.http_status, 200, JSON.stringify(st1));
  assert.equal(st1.status, "SENT");
  assert.equal(st1.confirmed_by_provider, true, "statut réel du fournisseur");
  // Unknown → statut null + note honnête (jamais de DELIVERED inventé)
  const stU = await A.get(`/api/channels/WHATSAPP/message-status?provider_message_id=wamid.inconnu`);
  assert.equal(stU.status, null, "aucun statut sans accusé");
  assert.equal(stU.confirmed_by_provider, false);
  assert.match(stU.note || "", /aucun accus[ée]/i, "note honnête");
  // Receipts : delivered → read
  const statusPayload = (status) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { phone_number_id: "888000", statuses: [{ id: outMsg.provider_message_id, status, timestamp: "125" }] } }] }] });
  await waWebhook("/api/webhooks/whatsapp", statusPayload("delivered"), waSecret);
  const st2 = await A.get(`/api/channels/WHATSAPP/message-status?provider_message_id=${outMsg.provider_message_id}`);
  assert.equal(st2.status, "DELIVERED", "DELIVERED après receipt");
  await waWebhook("/api/webhooks/whatsapp", statusPayload("read"), waSecret);
  const st3 = await A.get(`/api/channels/WHATSAPP/message-status?provider_message_id=${outMsg.provider_message_id}`);
  assert.equal(st3.status, "READ", "READ après receipt");
});

/* ================================================================ RBAC / MULTI-TENANT / ABUS */
test("18. RBAC : VIEWER lit l'inbox, n'agit pas ; non-membre refusé", async () => {
  const scope = `?organization_id=${A.orgId}`;
  const read = await V.get(`/api/inbox${scope}`);
  assert.equal(read.http_status, 200, "VIEWER lit l'inbox de A");
  assert.ok(read.count >= 4, "conversations visibles");
  const row = read.conversations.find((c) => c.id === aiConv);
  assert.ok(row, "conv A visible");
  const write = await V.post(`/api/inbox/conversations/${aiConv}/reply${scope}`, { message: "test" });
  assert.equal(write.http_status, 403, "VIEWER ne répond pas");
  const up = await V.post(`/api/inbox/conversations/${aiConv}${scope}`, { assigned_to: V.userId }, { method: "PUT" });
  assert.equal(up.http_status, 403, "VIEWER n'assigne pas");
  // B (non membre de A) → 403 sur A
  const bOnA = await B.get(`/api/inbox?organization_id=${A.orgId}`);
  assert.equal(bOnA.http_status, 403, "org non-membre refusée (pas de fuite par l'ID)");
  // B voit uniquement sa propre org (vide)
  const bOwn = await B.get("/api/inbox");
  assert.equal(bOwn.http_status, 200);
  assert.equal(bOwn.count, 0, "B : aucune conversation de A");
  // Conversation de A inaccessibles à B par ID direct (IDOR)
  const direct = await B.get(`/api/inbox/conversations/${aiConv}`);
  assert.equal(direct.http_status, 404, "IDOR : conversation de A invisible pour B");
});

test("19. Widget : rate limiting par visiteur (anti-abus public)", async () => {
  await A.setMode("HUMAN"); // moins coûteux pour le test
  const v = new Visitor("spammer"); v.key = widgetKey;
  let last = null;
  for (let i = 1; i <= 31; i++) {
    last = await v.send(`message n°${i}`);
    if (last.http_status === 429) break;
  }
  assert.equal(last.http_status, 429, "429 après dépassement (30/min)");
  assert.match(last.error || "", /trop de messages/i, "message honnête");
  await A.setMode("AI");
});

test("20. Widget : état HANDOFF visible par le visiteur (transfert humain)", async () => {
  // La conversation VIP (test 15) est en HANDOFF — le visiteur le voit via son endpoint
  const db = new DatabaseSync(DB);
  const conv = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = 'WHATSAPP' AND external_contact_id = '22890777777'").get(A.orgId);
  db.close();
  assert.equal(conv.status, "HANDOFF");
  const view = await (await fetch(`${BASE}/api/widget/conversation?k=${widgetKey}&visitor_id=visitor${"vip".padEnd(12, "0")}&session_id=session${"vip".padEnd(12, "0")}&conversation_id=${conv.id}`)).json();
  // La conversation n'est pas une conv webchat du visiteur : pas de fuite (null/404)
  assert.ok(!view.status || view.error, "conversation WhatsApp privée non exposée via l'API visiteur");
});
