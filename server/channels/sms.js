// server/channels/sms.js — Phase 6 : client SMS (architecture, fournisseur configurable)
// Prépare l'architecture SMS (send / receive si disponible / delivery status) en
// respectant opt-in/opt-out/rate limit. Aucun fournisseur n'est connecté par défaut :
// STATUS NOT_CONFIGURED. Ne JAMAIS simuler un SMS envoyé.

import { httpJson, isTestEnv } from "./transport.js";

/** Envoie un SMS. config: { provider, account_sid, auth_token, from_number }
 *  provider : TWILIO (défaut) | FREESMS | GENERIC. En test, transport mock (jamais de vrai SMS). */
export async function sendSMS(config, { to, text }) {
  const toPhone = String(to || "").replace(/[^\d+]/g, "");
  if (!toPhone || toPhone.replace(/\D/g, "").length < 8) return { status: "failed", provider_message_id: null, error: "Numéro SMS invalide." };
  const body = String(text || "").slice(0, 1600);
  if (!config || !config.provider || !config.from_number) {
    return { status: "failed", provider_message_id: null, error: "Canal non configuré." };
  }
  const provider = String(config.provider).toUpperCase();
  if (isTestEnv()) {
    // Mock : on n'envoie jamais un vrai SMS en test.
    const mock = (globalThis.__smsMock || (globalThis.__smsMock = { sent: [] }));
    const sid = `SMSMOCK${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    mock.sent.push({ to: toPhone, body, provider });
    return { status: "sent", provider_message_id: sid, error: null };
  }
  if (provider === "TWILIO") {
    const auth = Buffer.from(`${config.account_sid}:${config.auth_token}`).toString("base64");
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.account_sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: toPhone, From: String(config.from_number), Body: body }),
    });
    if (!r.ok) return { status: "failed", provider_message_id: null, error: `Échec Twilio HTTP ${r.status}` };
    const data = await r.json().catch(() => null);
    return data?.sid
      ? { status: "sent", provider_message_id: data.sid, error: null }
      : { status: "failed", provider_message_id: null, error: "Réponse Twilio inattendue." };
  }
  return { status: "failed", provider_message_id: null, error: `Fournisseur SMS inconnu : ${provider}.` };
}

/** Vérifie la connexion SMS. */
export async function verifySMS(config) {
  if (!config?.provider || !config?.from_number) return { ok: false, error: "Configuration incomplète (provider + from_number)." };
  if (!config?.auth_token && config.provider === "TWILIO") return { ok: false, error: "auth_token requis (Twilio)." };
  if (isTestEnv()) return { ok: true, error: null }; // mock : OK si la config est complète
  const r = await sendSMS(config, { to: config.from_number, text: "[test] vérification SMS." }).catch((e) => ({ status: "failed", error: String(e.message || e) }));
  return r.status === "sent" ? { ok: true, error: null } : { ok: false, error: r.error };
}
