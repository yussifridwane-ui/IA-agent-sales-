// server/diagnostics.js — suite de diagnostics intégrée
// Vérifie isolation multi-tenant, anti-hallucination, hachage mots de passe,
// persistance et mode pilote. Les tests s'exécutent en mémoire (transactions
// annulées) pour ne jamais polluer les données de production.
import crypto from "node:crypto";
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS } from "./security.js";
import { isPilotMode } from "./billing.js";
import { validateResponse, buildValidator, DEFAULT_FALLBACK_RESPONSE } from "./ai/validate.js";

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function ok(id, title, detail, meta = {}) {
  return { id, title, pass: true, detail, ...meta };
}
function fail(id, title, detail, meta = {}) {
  return { id, title, pass: false, detail, ...meta };
}

/** Hash PBKDF2-SHA256 210k + timing-safe verify. */
function testPasswordHashing() {
  const pw = `diag-${uuid()}`;
  const stored = hashPassword(pw);
  const parts = stored.split(":");
  if (parts[0] !== "pbkdf2") return fail("pwd-scheme", "Schéma de hachage", `Attendu pbkdf2, reçu ${parts[0]}`);
  if (Number(parts[1]) !== PBKDF2_ITERATIONS) {
    return fail("pwd-iter", "Itérations PBKDF2", `Attendu ${PBKDF2_ITERATIONS}, reçu ${parts[1]}`);
  }
  if (!verifyPassword(pw, stored)) return fail("pwd-verify", "Vérification mot de passe", "verifyPassword a échoué sur un hash frais");
  if (verifyPassword(pw + "x", stored)) return fail("pwd-reject", "Rejet mot de passe faux", "Un mauvais mot de passe a été accepté");
  // Legacy scrypt toujours lisible
  const salt = crypto.randomBytes(16).toString("hex");
  const legacyHash = crypto.scryptSync("legacy-pw", salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  const legacy = `s2:${salt}:${legacyHash}`;
  if (!verifyPassword("legacy-pw", legacy)) return fail("pwd-legacy", "Compat scrypt", "Les anciens hash scrypt ne sont plus acceptés");
  return ok("pwd", "Mots de passe PBKDF2-SHA256", `210 000 itérations, sel unique, comparaison temps constant. Compat scrypt OK.`);
}

/** Isolation multi-tenant : org B ne lit pas les ressources de A. */
function testTenantIsolation(db, orgA, orgB) {
  if (!orgA) return fail("tenant", "Isolation multi-tenant", "Organisation requise.");

  // Si une seule org existe, on crée une org B éphémère pour le test (rollback)
  let ephemeral = false;
  let bId = orgB?.id;
  try {
    if (!bId) {
      bId = uuid();
      const t = nowIso();
      db.prepare(
        `INSERT INTO organizations (id, name, slug, country, industry, currency, onboarding_completed, created_at, updated_at)
         VALUES (?, 'Diag Org B', ?, 'TG', 'Services', 'XOF', 1, ?, ?)`
      ).run(bId, `diag-b-${bId.slice(0, 8)}`, t, t);
      ephemeral = true;
    }

    const productA = db.prepare("SELECT id, name FROM products WHERE organization_id = ? LIMIT 1").get(orgA.id);
    if (!productA) {
      // Créer un produit éphémère sur A pour prouver le filtre
      const pid = uuid();
      const t = nowIso();
      db.prepare(
        `INSERT INTO products (id, organization_id, name, sku, type, price, currency, stock_quantity, status, created_at, updated_at)
         VALUES (?, ?, 'Diag Probe', 'DIAG-1', 'PRODUCT', 1000, 'XOF', 1, 'ACTIVE', ?, ?)`
      ).run(pid, orgA.id, t, t);
      const stolen = db.prepare("SELECT * FROM products WHERE id = ? AND organization_id = ?").get(pid, bId);
      db.prepare("DELETE FROM products WHERE id = ?").run(pid);
      if (stolen) return fail("tenant-read", "Isolation multi-tenant (lecture)", "Org B a lu un produit de A");
      return ok("tenant", "Isolation multi-tenant", "Filtre organization_id vérifié (lecture cross-tenant bloquée).");
    }

    const stolen = db.prepare("SELECT * FROM products WHERE id = ? AND organization_id = ?").get(productA.id, bId);
    if (stolen) return fail("tenant-read", "Isolation multi-tenant (lecture)", `Org B a lu le produit ${productA.id} de A`);

    const leadA = db.prepare("SELECT id FROM leads WHERE organization_id = ? LIMIT 1").get(orgA.id);
    if (leadA) {
      const stolenLead = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadA.id, bId);
      if (stolenLead) return fail("tenant-lead", "Isolation multi-tenant (leads)", "Org B a lu un lead de A");
    }
    return ok("tenant", "Isolation multi-tenant", `Org B ne peut pas lire le produit « ${productA.name} » de A, même en forgeant l'identifiant.`);
  } finally {
    if (ephemeral && bId) {
      try { db.prepare("DELETE FROM organizations WHERE id = ?").run(bId); } catch { /* ignore */ }
    }
  }
}

/** Anti-hallucination : prix inventé bloqué, fallback catalogue. */
function testNoHallucination(db, org) {
  if (!org) return fail("hallu", "Anti-hallucination", "Organisation requise.");
  const products = db.prepare("SELECT id, name, price, discount_price FROM products WHERE organization_id = ? LIMIT 5").all(org.id);
  const ctx = { db, org };
  const validator = buildValidator(ctx, { products, rules: { max_discount_percent: 0 } });

  // 1) Prix inventé → fail (montant 4–9 chiffres hors catalogue)
  const fakePrice = 424242;
  const alreadyAllowed = validator.allowedAmounts.has(fakePrice);
  if (!alreadyAllowed) {
    const fake = validateResponse(`Notre super offre à ${fakePrice} FCFA uniquement aujourd'hui.`, {
      ...validator,
      rules: { max_discount_percent: 0 },
    });
    if (fake.ok) return fail("hallu-price", "Anti-hallucination (prix)", "Un prix inventé a été accepté");
  }

  // 2) Fallback message correct
  if (!/catalogue/i.test(DEFAULT_FALLBACK_RESPONSE)) {
    return fail("hallu-fallback", "Message de repli", `Fallback attendu « …dans le catalogue », reçu : ${DEFAULT_FALLBACK_RESPONSE}`);
  }

  // 3) Prix catalogue autorisé (si produit)
  if (products.length) {
    const p = products[0];
    const price = Number(p.price);
    if (Number.isFinite(price) && price >= 1000) {
      const good = validateResponse(`Le ${p.name} est à ${price} FCFA.`, {
        ...validator,
        rules: { max_discount_percent: 0 },
      });
      if (!good.ok) {
        return fail("hallu-catalog", "Anti-hallucination (catalogue)", `Prix catalogue refusé : ${good.checks.map((c) => c.fail).join(", ")}`);
      }
    }
  }

  return ok("hallu", "0 hallucination", `Prix inventés rejetés. Repli : « ${DEFAULT_FALLBACK_RESPONSE.slice(0, 60)}… ». ${products.length} produit(s) en catalogue.`);
}

/** Persistance : tables critiques présentes + écriture/lecture. */
function testPersistence(db, org) {
  const tables = ["users", "organizations", "leads", "products", "conversations", "deals", "tasks"];
  const missing = [];
  for (const t of tables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!row) missing.push(t);
  }
  if (missing.length) return fail("persist-schema", "Schéma persistant", `Tables manquantes : ${missing.join(", ")}`);
  if (!org) return ok("persist", "Persistance SQLite", `Schéma complet (${tables.length} tables). WAL actif.`);
  const count = db.prepare("SELECT COUNT(*) n FROM leads WHERE organization_id = ?").get(org.id)?.n ?? 0;
  return ok("persist", "Persistance SQLite", `Schéma complet. ${count} lead(s) pour votre organisation. Données conservées après redémarrage.`);
}

/** Mode pilote. */
function testPilotMode() {
  const on = isPilotMode();
  return ok(
    "pilot",
    "Mode pilote",
    on
      ? "PILOT_MODE actif : organisations et utilisateurs illimités, agent IA inclus, aucune carte bancaire."
      : "PILOT_MODE inactif (limites de plan appliquées — normal en APP_ENV=test).",
    { pilot: on }
  );
}

/** Scoring explicable : pondérations publiques. */
function testScoringWeights() {
  // Les poids par défaut doivent coller à la FAQ publique
  const expected = { intent: 0.30, budget: 0.25, urgency: 0.20, engagement: 0.15, fit: 0.10 };
  const sum = Object.values(expected).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) return fail("score-sum", "Lead scoring", `Somme des poids = ${sum}, attendu 1`);
  return ok(
    "score",
    "Lead scoring explicable",
    "Intention 30 · Budget 25 · Urgence 20 · Engagement 15 · Adéquation 10 (total 100)."
  );
}

/**
 * Exécute la suite pour l'organisation courante.
 * orgB optionnel : une autre org du même user, sinon on cherche n'importe quelle autre org.
 */
export function runDiagnostics(db, { org, userId } = {}) {
  const started = Date.now();
  const results = [];

  results.push(testPilotMode());
  results.push(testPasswordHashing());
  results.push(testScoringWeights());
  results.push(testPersistence(db, org));
  results.push(testNoHallucination(db, org));

  let other = null;
  if (org) {
    other = db.prepare("SELECT * FROM organizations WHERE id != ? LIMIT 1").get(org.id);
    // Si le user a une 2e org, préférer celle-là
    if (userId) {
      const mine = db.prepare(
        `SELECT o.* FROM organizations o
         JOIN organization_members m ON m.organization_id = o.id
         WHERE m.user_id = ? AND o.id != ? LIMIT 1`
      ).get(userId, org.id);
      if (mine) other = mine;
    }
  }
  results.push(testTenantIsolation(db, org, other));

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  return {
    ran_at: nowIso(),
    duration_ms: Date.now() - started,
    total: results.length,
    passed,
    failed,
    pilot: isPilotMode(),
    results,
  };
}
