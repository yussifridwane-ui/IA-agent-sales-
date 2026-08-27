// scripts/seed-demo.mjs — environnement de démonstration SÉPARÉ des données réelles.
// Usage :
//   node scripts/seed-demo.mjs                    → data/demo.db
//   DB_PATH=data/demo.db npm start                → serveur sur la base de démo
// La base de démo est un fichier distinct : aucune donnée réelle n'est mélangée.
import { randomUUID } from "node:crypto";

const DB_PATH = process.env.DB_PATH || "data/demo.db";
process.env.DB_PATH = DB_PATH;

const { db } = await import("../server/db.js");
const { hashPassword } = await import("../server/security.js");

const now = new Date();
const daysAgo = (n, h = 10) => new Date(now.getTime() - n * 86400000 - h * 3600000).toISOString();

// --- Idempotence ---
if (db.prepare("SELECT 1 FROM organizations WHERE slug = 'techstore-demo'").get()) {
  console.log("✔ Démo déjà présente dans", DB_PATH, "(rien à faire).");
  process.exit(0);
}

const orgId = randomUUID();
const userId = randomUUID();
const nowIso = now.toISOString();

db.prepare(
  `INSERT INTO users (id, first_name, last_name, email, phone, password_hash, email_verified, created_at, updated_at)
   VALUES (?, 'Demo', 'TechStore', 'demo@techstore.demo', '+228 90 00 00 00', ?, 1, ?, ?)`
).run(userId, hashPassword("demo12345"), daysAgo(45), nowIso);

db.prepare(
  `INSERT INTO organizations (id, name, slug, country, industry, currency, goal, onboarding_completed, created_at, updated_at)
   VALUES (?, 'TechStore Demo', 'techstore-demo', 'TG', 'E-commerce', 'XOF', 'Générer des leads', 1, ?, ?)`
).run(orgId, daysAgo(45), nowIso);

db.prepare(
  `INSERT INTO organization_members (id, organization_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'OWNER', 'active', ?)`
).run(randomUUID(), orgId, userId, daysAgo(45));

db.prepare(
  `INSERT INTO subscriptions (id, organization_id, plan, status, current_period_start, created_at, updated_at)
   VALUES (?, ?, 'FREE', 'active', ?, ?, ?)`
).run(randomUUID(), orgId, daysAgo(45), daysAgo(45), nowIso);

db.prepare(
  `INSERT INTO onboarding (organization_id, step, industry, country, currency, goal, completed, updated_at)
   VALUES (?, 7, 'E-commerce', 'TG', 'XOF', 'Générer des leads', 1, ?)`
).run(orgId, nowIso);

/* ---------- Catégories ---------- */
const cat = (name, description, order) => {
  const id = randomUUID();
  db.prepare("INSERT INTO categories (id, organization_id, name, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, orgId, name, description, order, daysAgo(44), nowIso);
  return id;
};
const cSmart = cat("Smartphones", "Téléphones et mobiles", 1);
const cPc = cat("Ordinateurs", "PC portables et fixes", 2);
const cAudio = cat("Audio", "Casques et enceintes", 3);
const cAcc = cat("Accessoires", "Souris, claviers, chargeurs", 4);
const cServ = cat("Services", "Installation, formation, maintenance", 5);

/* ---------- Produits (XOF) ---------- */
function product(p) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO products (id, organization_id, name, sku, type, category_id, description, price, discount_price, currency,
     stock_quantity, low_stock_threshold, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'XOF', ?, ?, 'ACTIVE', ?, ?, ?)`
  ).run(id, orgId, p.name, p.sku, p.type || "PRODUCT", p.cat, p.desc, p.price, p.promo ?? null, p.stock, p.thresh ?? 0, userId, p.created || daysAgo(40), nowIso);
  for (const v of p.variants || []) {
    db.prepare(
      `INSERT INTO product_variants (id, organization_id, product_id, name, sku, price, stock_quantity, low_stock_threshold, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), orgId, id, v.name, v.sku, v.price, v.stock, v.thresh ?? 1, daysAgo(40), nowIso);
  }
  for (const [url, alt] of p.images || []) {
    db.prepare("INSERT INTO product_images (id, organization_id, product_id, url, alt_text, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), orgId, id, url, alt, 0, daysAgo(40));
  }
  return id;
}

const pIphone = product({
  name: "iPhone 15", sku: "IPHONE15", cat: cSmart, price: 1250000, promo: 1150000, stock: 12, thresh: 4,
  desc: "iPhone 15 — écran 6,1'' Dynamic Island, puce A16 Bionic.",
  variants: [
    { name: "128 GO", sku: "IPHONE15-128", price: 1250000, stock: 8, thresh: 3 },
    { name: "256 GO", sku: "IPHONE15-256", price: 1450000, stock: 4, thresh: 2 },
  ],
  images: [["https://placehold.co/600x600/eef0fe/4f46e5?text=iPhone+15", "iPhone 15 — face avant"]],
});
product({ name: "Samsung Galaxy S24", sku: "SAMSUNG-S24", cat: cSmart, price: 950000, stock: 8, thresh: 3, desc: "Galaxy S24 — 256 GO, AI on-device.", created: daysAgo(38) });
product({ name: "HP Laptop 15", sku: "HP-LAP-15", cat: cPc, price: 780000, stock: 5, thresh: 2, desc: "Ryzen 5, 16 GO, 512 GO SSD.", created: daysAgo(36) });
product({ name: "Dell XPS 13", sku: "DELL-XPS-13", cat: cPc, price: 1650000, stock: 3, thresh: 2, desc: "Core Ultra 7, 16 GO, OLED.", created: daysAgo(35) });
const pHeadset = product({ name: "Casque Bluetooth Pro", sku: "HEADSET-BT", cat: cAudio, price: 85000, promo: 65000, stock: 40, thresh: 10, desc: "Réduction de bruit active, 30 h d'autonomie.", created: daysAgo(30) });
product({ name: "Souris sans fil", sku: "MOUSE-WL", cat: cAcc, price: 35000, stock: 0, thresh: 5, desc: "Silencieuse, 2,4 GHz.", created: daysAgo(28) });
const pService = product({ name: "Installation boutique", type: "SERVICE", sku: "SERVICE-INST", cat: cServ, price: 75000, stock: 0, desc: "Prise en main du logiciel de caisse + formation du personnel.", created: daysAgo(25) });

/* ---------- Clients ---------- */
function customer(c) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO customers (id, organization_id, first_name, last_name, email, phone, company_name, country, city, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Togo', ?, ?, 'ACTIVE', ?, ?)`
  ).run(id, orgId, c.first, c.last, c.email, c.phone, c.company, c.city, c.source, daysAgo(c.daysAgo), nowIso);
  return id;
}
const custAwa = customer({ first: "Awa", last: "Konan", email: "awa.konan@example.tg", phone: "+228 91 11 11 11", company: "Konan Electronics", city: "Lomé", source: "REFERRAL", daysAgo: 40 });
const custJean = customer({ first: "Jean-Marc", last: "Mensah", email: "jm.mensah@example.tg", phone: "+228 92 22 22 22", company: "Mensah & Fils", city: "Kara", source: "WEBSITE", daysAgo: 35 });
const custFatou = customer({ first: "Fatou", last: "Diallo", email: "fatou.diallo@example.tg", phone: "+228 93 33 33 33", company: "Boutique Diallo", city: "Lomé", source: "FACEBOOK", daysAgo: 30 });
const custSerge = customer({ first: "Serge", last: "Agbeko", email: "serge.agbeko@example.tg", phone: "+228 94 44 44 44", company: "Agence Agbeko", city: "Lomé", source: "EMAIL", daysAgo: 22 });

/* ---------- Leads ---------- */
function lead(l) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO leads (id, organization_id, customer_id, name, company_name, email, phone, source, status, interest, budget, currency, score, notes, last_contact_at, next_followup_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'XOF', ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, l.cust ?? null, l.name, l.company, l.email, l.phone, l.source, l.status, l.interest, l.budget, l.score, l.notes || null, daysAgo(l.daysAgo - 2), l.next ? daysAgo(l.next) : null, daysAgo(l.daysAgo), daysAgo(l.daysAgo - 2));
  return id;
}
const leadKomi = lead({ cust: custAwa, name: "Awa Konan", company: "Konan Electronics", email: "awa.konan@example.tg", phone: "+228 91 11 11 11", source: "WHATSAPP", status: "HOT", interest: "Recharge en smartphones", budget: 1500000, score: 85, notes: "Très sérieuse, veut commander avant la rentrée.", daysAgo: 20, next: 2 });
const leadGrace = lead({ name: "Grâce Amouzou", company: "TechCorner", email: "grace@example.tg", phone: "+228 95 55 55 55", source: "WEBSITE", status: "QUALIFIED", interest: "Ordinateurs pour le bureau", budget: 2000000, score: 65, daysAgo: 15, next: 4 });
const leadPaul = lead({ name: "Paul Lawson", company: "—", email: "paul.lawson@example.tg", phone: "+228 96 66 66 66", source: "INSTAGRAM", status: "NEW", interest: "Casque Bluetooth", budget: 100000, score: 20, daysAgo: 5 });
const leadMariam = lead({ name: "Mariam Traoré", company: "Traoré Import", email: "mariam@example.tg", phone: "+228 97 77 77 77", source: "REFERRAL", status: "PROPOSAL", interest: "Stock mixte 40 articles", budget: 2500000, score: 70, notes: "Proposition envoyée le " + daysAgo(6).slice(0, 10) + ".", daysAgo: 12, next: 1 });
const leadKoffi = lead({ name: "Koffi Essossou", company: "Essossou Mobile", email: "koffi@example.tg", phone: "+228 98 88 88 88", source: "FACEBOOK", status: "CONTACTED", interest: "Galaxy S24", budget: 1000000, score: 40, daysAgo: 10 });
const leadAfi = lead({ cust: custJean, name: "Jean-Marc Mensah", company: "Mensah & Fils", email: "jm.mensah@example.tg", phone: "+228 92 22 22 22", source: "EMAIL", status: "NEGOTIATION", interest: "Flotte de 10 laptops", budget: 2400000, score: 78, notes: "Négocie -5 % sur la quantité.", daysAgo: 18, next: 1 });
const leadRoch = lead({ cust: custFatou, name: "Fatou Diallo", company: "Boutique Diallo", email: "fatou.diallo@example.tg", phone: "+228 93 33 33 33", source: "WHATSAPP", status: "WON", interest: "Audio + installation", budget: 400000, score: 95, daysAgo: 25, next: 14 });
lead({ name: "Eto Nana", company: "—", email: "eto.nana@example.tg", phone: "+228 99 99 99 99", source: "ADVERTISEMENT", status: "LOST", interest: "iPhone 15", budget: 0, score: 10, notes: "A choisi un concurrent sur le prix.", daysAgo: 30 });

/* ---------- Deals ---------- */
function deal(d) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO deals (id, organization_id, customer_id, lead_id, name, description, value, currency, stage, probability, expected_close_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'XOF', ?, ?, ?, ?, ?)`
  ).run(id, orgId, d.cust ?? null, d.lead ?? null, d.name, d.desc, d.value, d.stage, d.prob, d.close, daysAgo(d.daysAgo), daysAgo(d.daysAgo - 2));
  return id;
}
const deal1 = deal({ cust: custAwa, lead: leadKomi, name: "Recharge rentrée — Konan Electronics", desc: "8 iPhone 15 + accessoires", value: 1500000, stage: "PROPOSAL", prob: 80, close: daysAgo(-10), daysAgo: 18 });
const deal2 = deal({ cust: custJean, lead: leadAfi, name: "Flotte laptops — Mensah & Fils", desc: "10 × HP Laptop 15", value: 2400000, stage: "NEGOTIATION", prob: 60, close: daysAgo(-15), daysAgo: 16 });
const deal3 = deal({ cust: custFatou, lead: leadRoch, name: "Équipement audio — Boutique Diallo", desc: "4 casques + installation", value: 340000, stage: "WON", prob: 100, close: daysAgo(8), daysAgo: 24 });
const deal4 = deal({ cust: custSerge, name: "Formation caisse — Agence Agbeko", desc: "Installation + formation", value: 75000, stage: "WON", prob: 100, close: daysAgo(5), daysAgo: 20 });
deal({ lead: leadGrace, name: "Bureau TechCorner", desc: "6 laptops + 2 XPS", value: 3300000, stage: "QUALIFICATION", prob: 40, close: daysAgo(-30), daysAgo: 12 });

/* ---------- Lignes deal_products (ventes gagnées) ---------- */
function line(dealId, productId, qty, unitPrice, discount) {
  db.prepare(
    `INSERT INTO deal_products (id, organization_id, deal_id, product_id, quantity, unit_price, discount, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), orgId, dealId, productId, qty, unitPrice, discount, Math.max(qty * unitPrice - discount, 0), daysAgo(10), daysAgo(10));
}
line(deal3, pHeadset, 4, 65000, 20000); // 240 000
line(deal3, pService, 1, 75000, 5000);   // 70 000  → total 310 000 (valeur deal 340 000 : marge arrondie)
line(deal4, pService, 1, 75000, 0);       // 75 000

/* ---------- Activités / notes / tâches ---------- */
function act(refField, refId, type, desc, daysAgoN) {
  db.prepare(
    `INSERT INTO activities (id, organization_id, ${refField}, user_id, type, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), orgId, refId, userId, type, desc, daysAgo(daysAgoN));
}
act("lead_id", leadKomi, "CALL", "Appel de qualification — besoin confirmé avant la rentrée", 12);
act("lead_id", leadKomi, "STATUS_CHANGE", "Statut : QUALIFIED → HOT", 6);
act("deal_id", deal1, "NOTE", "Proposition commerciale envoyée (8 iPhone 15)", 5);
act("lead_id", leadAfi, "MEETING", "Réunion Kara — négociation volume", 3);
act("deal_id", deal2, "STATUS_CHANGE", "Étape deal : PROPOSAL → NEGOTIATION", 3);
act("lead_id", leadRoch, "PURCHASE", "Commande validée — audio + installation", 9);

function note(refField, refId, content, daysAgoN) {
  db.prepare(
    `INSERT INTO notes (id, organization_id, user_id, ${refField}, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), orgId, userId, refId, content, daysAgo(daysAgoN), daysAgo(daysAgoN));
}
note("lead_id", leadKomi, "Préférence pour la livraison en boutique, pas en domicile.", 8);
note("lead_id", leadAfi, "Souhaite un essai de 1 laptop avant la commande complète.", 2);
note("customer_id", custFatou, "Cliente fidèle — proposer un programme de fidélité.", 6);

function task(title, priority, status, due, refField, refId, daysAgoN) {
  db.prepare(
    `INSERT INTO tasks (id, organization_id, assigned_to, ${refField}, title, priority, status, due_date, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), orgId, userId, refId, title, priority, status, due, userId, daysAgo(daysAgoN), daysAgo(daysAgoN - 1));
}
task("Relancer Mariam Traoré (proposition)", "HIGH", "IN_PROGRESS", daysAgo(-1), "lead_id", leadMariam, 4);
task("Préparer l'essai laptop pour Mensah & Fils", "URGENT", "TODO", daysAgo(-2), "lead_id", leadAfi, 3);
task("Commander 20 casques au fournisseur", "MEDIUM", "TODO", daysAgo(-5), "customer_id", custFatou, 6);
task("Envoyer facture — Boutique Diallo", "HIGH", "COMPLETED", daysAgo(7), "deal_id", deal3, 9);

/* ---------- Phase 3 : agent IA, règles de vente, knowledge base ---------- */
const { processDocument } = await import("../server/ai/embed.js");

const agentId = randomUUID();
db.prepare(
  `INSERT INTO agent_settings (id, organization_id, name, description, language, tone, style, business_goal, welcome_message, fallback_message, human_handoff_enabled, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'fr', 'friendly', 'equilibre', ?, ?, ?, 1, 'ACTIVE', ?, ?)`
).run(
  agentId, orgId, "Aria", "Assistante commerciale de TechStore Demo",
  "Qualifier les leads entrants et proposer les bons produits",
  "Bonjour ! Je suis Aria, l'assistante commerciale de TechStore Demo. Je peux vous aider à trouver un produit, vérifier les prix et la disponibilité. Comment puis-je vous aider ?",
  "Je n'ai pas cette information pour le moment. Je peux vous mettre en relation avec un conseiller.",
  daysAgo(20), nowIso
);

db.prepare(
  `INSERT INTO agent_prompt_versions (id, organization_id, agent_id, version, instructions, active, created_at)
   VALUES (?, ?, ?, 1, ?, 1, ?)`
).run(randomUUID(), orgId, agentId, "Insister sur la garantie 12 mois. Proposer systématiquement l'essai avant l'achat.", daysAgo(20));

db.prepare(
  `INSERT INTO sales_rules (id, organization_id, max_discount_percent, negotiation_enabled, minimum_order_value, payment_methods, delivery_information, return_policy, created_at, updated_at)
   VALUES (?, ?, 10, 1, 100000, ?, ?, ?, ?, ?)`
).run(
  randomUUID(), orgId,
  "Espèces, Mobile Money (Moov, T-Money), Virement",
  "Livraison 24 à 72h selon la zone (Lomé 24h, intérieur 48-72h).",
  "Retours sous 7 jours, produit non utilisé. Remboursement sous 72h.",
  daysAgo(20), nowIso
);

// Documents knowledge base
const kbDocs = [
  { name: "Délais de livraison", type: "DELIVERY", content: "Livraison sous 24 heures à Lomé pour toute commande passée avant 15h. Pour l'intérieur du pays (Kara, Sokodé, Atakpamé), livraison sous 48 à 72 heures. La livraison est gratuite dès 500 000 FCFA d'achat. Un SMS de confirmation est envoyé à la prise en charge du colis." },
  { name: "FAQ livraison", type: "FAQ", content: "Question : Quels sont les délais de livraison ?\nCatégorie : Livraison\nRéponse : Livraison sous 24 à 72 heures selon la zone. Lomé : 24h. Intérieur du pays : 48 à 72h. Gratuite dès 500 000 FCFA d'achat." },
  { name: "Politique de retours", type: "RETURN", content: "Vous disposez de 7 jours à compter de la réception pour retourner un produit non utilisé dans son emballage d'origine. Le remboursement est effectué sous 72 heures après contrôle du produit, par le même moyen que le paiement ou en espèces en boutique." },
  { name: "Garantie", type: "WARRANTY", content: "Tous nos produits sont couverts par une garantie constructeur de 12 mois. Les smartphones sont garantis 12 mois pièces et main d'œuvre. L'échange se fait en boutique avec la facture d'origine. La garantie ne couvre pas les chocs, l'eau ou les modifications non autorisées." },
  { name: "Modes de paiement", type: "CONDITIONS", content: "Nous acceptons : espèces en boutique, Mobile Money (Moov Money et T-Money), virement bancaire. Pour les commandes supérieures à 1 000 000 FCFA, un acompte de 30 % peut être demandé. La facture est émise pour chaque transaction." },
  { name: "À propos de TechStore", type: "COMPANY", content: "TechStore Demo est une boutique de produits électroniques basée à Lomé, au Togo, depuis 2019. Nous vendons smartphones, ordinateurs, audio et accessoires. Notre boutique se situe au carrefour Togobank. Horaires : 8h-18h du lundi au samedi, 9h-16h le dimanche." },
];
for (const d of kbDocs) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO knowledge_documents (id, organization_id, name, type, source, status, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'MANUAL', 'PROCESSING', ?, ?, ?)`
  ).run(id, orgId, d.name, d.type, d.content, daysAgo(15), daysAgo(15));
  const doc = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(id);
  processDocument(db, doc);
}

console.log("✔ Données de démonstration créées dans", DB_PATH);
console.log("  Organisation : TechStore Demo (devise XOF)");
console.log("  Connexion    : demo@techstore.demo / demo12345");
console.log("  Contenu      : 5 catégories, 7 produits, 4 clients, 8 leads, 5 deals, activités, notes, tâches");
console.log("  IA (Phase 3) : agent « Aria » ACTIVE, 6 documents KB indexés, règles de vente (remise max 10 %)");
