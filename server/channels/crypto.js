// server/channels/crypto.js — Phase 6 : chiffrement des secrets de connexion canal
// AES-256-GCM. La clé est dérivée de SESSION_SECRET (scrypt, salt fixe applicatif).
// Les secrets (access_token, auth_token, smtp_pass, webhook_secret) sont stockés
// chiffrés en base ; ils ne sont JAMAIS retournés en clair par l'API/UI (masqués « •••• »).

import { createCipheriv, createDecipheriv, scryptSync, randomBytes, createHash } from "node:crypto";

const ALG = "aes-256-gcm";
const SALT = "ai-sales-agent:channel-secrets:v1";

function deriveKey() {
  const secret = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
  return scryptSync(secret, SALT, 32);
}

/** Chiffre un objet de config (secrets chiffrés, champs non-secrets en clair).
 *  Renvoie une chaîne base64 : iv . tag . ciphertext . plaintext-json */
export function encryptConfig(config, secretFields = SECRET_FIELDS) {
  const obj = config || {};
  const secrets = {};
  const plain = {};
  for (const [k, v] of Object.entries(obj)) {
    if (secretFields.has(k) && v != null && v !== "") secrets[k] = String(v);
    else plain[k] = v == null ? null : String(v);
  }
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const cipherSecrets = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), cipherSecrets.toString("base64"), Buffer.from(JSON.stringify(plain), "utf8").toString("base64")].join(".");
}

/** Déchiffre une config. Compatibilité : si la chaîne n'est pas au format chiffré
 *  (ancienne base en clair), on la parse telle quelle (et l'appelant peut la re-chiffrer). */
export function decryptConfig(encoded, secretFields = SECRET_FIELDS) {
  if (!encoded) return {};
  if (typeof encoded === "object") return encoded;
  const str = String(encoded);
  const parts = str.split(".");
  if (parts.length !== 4) {
    // pas au format chiffré → config en clair (ancienne version) : on la parse
    try { return JSON.parse(str); } catch { return {}; }
  }
  try {
    const key = deriveKey();
    const iv = Buffer.from(parts[0], "base64");
    const tag = Buffer.from(parts[1], "base64");
    const cipherSecrets = Buffer.from(parts[2], "base64");
    const plain = JSON.parse(Buffer.from(parts[3], "base64").toString("utf8"));
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const secrets = JSON.parse(Buffer.concat([decipher.update(cipherSecrets), decipher.final()]).toString("utf8"));
    return { ...plain, ...secrets };
  } catch {
    // déchiffrement impossible (changement de clé) : on retourne la partie lisible
    try { return JSON.parse(Buffer.from(parts[3], "base64").toString("utf8")); } catch { return {}; }
  }
}

/** Vrai si la chaîne est au format chiffré. */
export function isEncrypted(encoded) {
  if (!encoded || typeof encoded !== "string") return false;
  return encoded.split(".").length === 4;
}

/** Hash court (pour comparer sans exposer la signature). */
export function hashSecret(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 32);
}

/** Champs considérés comme secrets (chiffrés au repos). */
export const SECRET_FIELDS = new Set(["access_token", "auth_token", "smtp_pass", "webhook_secret", "api_key", "from_number"]);

export function maskConfig(config, secretFields = SECRET_FIELDS) {
  const out = {};
  for (const [k, v] of Object.entries(config || {})) {
    out[k] = secretFields.has(k) ? (v ? "••••" : null) : (v == null ? null : String(v));
  }
  return out;
}

export function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  const str = String(raw);
  if (isEncrypted(str)) return decryptConfig(str);
  try { return JSON.parse(str); } catch { return {}; }
}
