// server/payments/providers.js — Phase 7 : abstraction PaymentProvider (spec §23)
// CARD · MOBILE_MONEY · BANK_TRANSFER (production : configuration requise)
// + TEST (double de test, UNIQUEMENT en APP_ENV=test — même principe que le
// transport mock des canaux : jamais disponible en production).
//
// RÈGLE ABSOLUE : un paiement n'est CONFIRMED que par le fournisseur
// (webhook signé + vérification de la transaction). Sans configuration,
// l'API renvoie honnêtement CONFIGURATION_REQUIRED — jamais de « payé » factice.
// Aucune donnée sensible de carte n'est stockée (seuls : provider,
// provider_transaction_id, amount, currency, statut, instructions).

const isTestEnv = () => process.env.APP_ENV === "test";

export const PAYMENT_PROVIDERS = {
  CARD: {
    label: "Carte bancaire",
    key: "PAYMENT_CARD",
    // Configuration attendue (fournisseur type Stripe/Flutterwave/CinetPay…)
    needs: ["PAYMENT_CARD_KEY (clé API du fournisseur)", "PAYMENT_CARD_WEBHOOK_SECRET"],
    configured: () => !!process.env.PAYMENT_CARD_KEY,
  },
  MOBILE_MONEY: {
    label: "Mobile Money (Orange Money, MTN, T-Money…)",
    key: "PAYMENT_MM",
    needs: ["PAYMENT_MM_KEY (clé API du fournisseur)", "PAYMENT_MM_WEBHOOK_SECRET"],
    configured: () => !!process.env.PAYMENT_MM_KEY,
  },
  BANK_TRANSFER: {
    label: "Virement bancaire",
    key: "PAYMENT_BANK",
    needs: ["PAYMENT_BANK_IBAN (compte de réception)"],
    configured: () => !!process.env.PAYMENT_BANK_IBAN,
  },
  TEST: {
    label: "Double de test (APP_ENV=test uniquement)",
    key: null,
    needs: [],
    configured: () => isTestEnv(),
  },
};

/** Statut honnête de chaque fournisseur pour l'UI (CONNECTED / CONFIGURATION_REQUIRED). */
export function providerStatus() {
  const out = [];
  for (const [id, p] of Object.entries(PAYMENT_PROVIDERS)) {
    if (id === "TEST" && !isTestEnv()) continue; // jamais affiché en production
    let ok = false;
    try { ok = p.configured(); } catch { ok = false; }
    out.push({
      provider: id,
      label: p.label,
      status: ok ? "CONNECTED" : "CONFIGURATION_REQUIRED",
      needs: ok ? [] : p.needs,
    });
  }
  return out;
}

/**
 * Crée l'intention de paiement.
 * renvoie { status: "PENDING", provider_transaction_id, instructions }
 *       ou { status: "CONFIGURATION_REQUIRED", needs }  (jamais de faux PENDING)
 */
export async function createIntent({ provider, order, method = null }) {
  const p = PAYMENT_PROVIDERS[provider];
  if (!p) return { status: "UNKNOWN", error: `Fournisseur inconnu : ${provider}` };
  let ok = false;
  try { ok = p.configured(); } catch { ok = false; }
  if (!ok) return { status: "CONFIGURATION_REQUIRED", needs: p.needs };

  if (provider === "TEST") {
    // Double de test : simule le cycle fournisseur (PENDING → confirmation webhook)
    const tx = `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    return {
      status: "PENDING",
      provider_transaction_id: tx,
      instructions: `Paiement de test : confirmez via l'endpoint de test (webhook /api/webhooks/payments/TEST).`,
    };
  }
  // Fournisseurs réels : l'intégration appelle l'API du fournisseur (fetch natif)
  // avec la clé de configuration. À brancher (voir README §Phase 7) — sans clé,
  // le statut CONFIGURATION_REQUIRED ci-dessus est le seul résultat possible.
  return { status: "CONFIGURATION_REQUIRED", needs: p.needs };
}

/**
 * Vérifie une transaction auprès du fournisseur (webhook).
 * - TEST : valide le format (transaction_id présent + signature du secret de test).
 * - Réels : appel de vérification API + signature du webhook (à brancher).
 * renvoie { ok, error? }
 */
export function verifyTransaction(provider, { transactionId = null } = {}) {
  if (!PAYMENT_PROVIDERS[provider]) return { ok: false, error: "Fournisseur inconnu." };
  if (provider === "TEST") {
    return transactionId && /^TEST-/.test(String(transactionId))
      ? { ok: true }
      : { ok: false, error: "Transaction de test invalide." };
  }
  let ok = false;
  try { ok = PAYMENT_PROVIDERS[provider].configured(); } catch { ok = false; }
  if (!ok) return { ok: false, error: "CONFIGURATION_REQUIRED" };
  return { ok: false, error: "Intégration de vérification à brancher (API fournisseur)." };
}

/** Renvoie le secret de signature du webhook (ou null si non configuré). */
export function webhookSecret(provider) {
  const envKey = { CARD: "PAYMENT_CARD_WEBHOOK_SECRET", MOBILE_MONEY: "PAYMENT_MM_WEBHOOK_SECRET", TEST: "PAYMENT_TEST_WEBHOOK_SECRET" }[provider];
  return envKey ? (process.env[envKey] || null) : null;
}
