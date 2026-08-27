// server/ai/validate.js — validation de sécurité AVANT envoi de la réponse au client
// (spec §48) : pas de prix inventé, pas de produit hors contexte, pas de remise
// interdite, pas de fuite d'instructions/secrets. Si échec → réponse fallback.

const fmt = (v) => new Intl.NumberFormat("fr-FR").format(Math.round(v));

/** Trousse de validation pour une réponse donnée. */
export function buildValidator(ctx, { session = {}, products = [], selected = null, total = null, rules = {}, extraAmounts = [] }) {
  const org = ctx.org;
  // Montants autorisés : prix catalogue (+ promos), budget de session, total calculé, seuil min de commande
  const allowedAmounts = new Set();
  const addAmount = (v) => {
    if (v == null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 100) return;
    allowedAmounts.add(n);
    allowedAmounts.add(fmt(n));
  };
  for (const p of products) { addAmount(p.price); addAmount(p.discount_price); }
  if (selected) { addAmount(selected.price); addAmount(selected.discount_price); }
  addAmount(session.budget);
  addAmount(total);
  addAmount(rules.minimum_order_value);
  // Montants présents dans les sources KB citées (documents de l'organisation)
  for (const v of extraAmounts) addAmount(v);

  // Noms de produits connus (catalogue de l'org)
  const allProducts = ctx.db.prepare("SELECT name FROM products WHERE organization_id = ?").all(org.id).map((r) => r.name);
  const contextProductNames = new Set([
    ...products.map((p) => p.name),
    ...(selected ? [selected.name] : []),
  ]);

  return { allowedAmounts, allProducts, contextProductNames };
}

export function validateResponse(response, { allowedAmounts, allProducts, contextProductNames, rules }) {
  const text = String(response || "");
  const checks = [];

  // 1) Prix : tout montant mentionné doit être autorisé
  const amountRe = /(\d{1,3}(?:[ \u00a0.]\d{3})+|\d{4,9})(?:\s*(?:fcfa|xf|xof|xaf|francs?|€|xof))?\b/gi;
  let m;
  while ((m = amountRe.exec(text)) !== null) {
    const digits = m[1].replace(/[ \u00a0.]/g, "");
    const n = parseInt(digits, 10);
    if (!Number.isFinite(n) || n < 1000) continue;
    const ok = allowedAmounts.has(n);
    if (!ok) {
      checks.push({ fail: "prix_invente", detail: `montant ${n} non présent dans les sources` });
      break;
    }
  }

  // 2) Produits : un produit du catalogue NON présent dans le contexte ne doit pas être cité
  for (const name of allProducts) {
    const tokens = name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (tokens.length < 2) continue;
    if (contextProductNames.has(name)) continue;
    const mentioned = tokens.every((w) => text.toLowerCase().includes(w));
    if (mentioned) {
      checks.push({ fail: "produit_hors_contexte", detail: name });
      break;
    }
  }

  // 3) Remises : tout % de remise mentionné ne doit pas dépasser max_discount_percent
  const maxD = Number(rules.max_discount_percent) || 0;
  const discountRe = /(\d{1,2})\s*%\s*(?:de\s+remise|de\s+reduction|remise|reduction|discount)/i;
  const dm = text.match(discountRe);
  if (dm && Number(dm[1]) > maxD) {
    checks.push({ fail: "remise_interdite", detail: `${dm[1]}% > max ${maxD}%` });
  }

  // 4) Fuites : instructions, prompt système, secrets
  const leakRe = /system\s*prompt|instructions\s+(?:internes|systeme)|prompt\s+systeme|api[_\s-]?key|cl[ée]s?\s+(?:api|secret)|token\s+secret|base\s+de\s+donnees\s+interne/i;
  if (leakRe.test(text)) checks.push({ fail: "fuite_instructions", detail: "référence à des éléments internes" });

  // 5) Promesses non autorisées (livraison/paiement non confirmés)
  if (maxD === 0 && /je\s+(?:vous\s+)?offre\s+une\s+remise|remise\s+accordee/i.test(text)) {
    checks.push({ fail: "remise_interdite", detail: "remise promise alors que négociation désactivée" });
  }

  return { ok: checks.length === 0, checks };
}

export const DEFAULT_FALLBACK_RESPONSE =
  "Je n'ai pas cette information dans le catalogue. Je peux vous mettre en relation avec un conseiller.";

export function fallbackFor(agent) {
  return (agent?.fallback_message || DEFAULT_FALLBACK_RESPONSE).slice(0, 500);
}
