# Déployer AI Sales Agent sur Vercel

Le code est **prêt** (`api/index.js` + `vercel.json` + seed démo).

## Option A — Import GitHub (recommandé, 2 min)

1. Ouvre **https://vercel.com/new**
2. Connecte ton compte GitHub **yussifridwane-ui**
3. Importe le repo **`IA-agent-sales-`**
4. **Branch** : `arena/01a04536-ia-agent-sales` (ou `main` après merge de la PR)
5. Framework Preset : **Other**
6. Root Directory : `.`
7. **Environment Variables** (Production + Preview) :

| Name | Value |
| --- | --- |
| `SESSION_SECRET` | génère avec `openssl rand -hex 32` |
| `PILOT_MODE` | `true` |
| `NODE_ENV` | `production` |
| `APP_ENV` | `production` |
| `APP_URL` | `https://<ton-projet>.vercel.app` (à mettre après le 1er deploy) |

8. Clique **Deploy**

URL attendue : `https://ia-agent-sales.vercel.app` (ou le nom choisi).

### Compte démo (seed inclus)

- Email : `demo@techstore.demo`
- Mot de passe : `demo12345`

> **Note SQLite** : sur Vercel la DB vit dans `/tmp` (éphémère entre cold starts).  
> Parfait pour le **pilote**. Pour la prod durable : Turso / Neon / Postgres plus tard.

## Option B — CLI (avec token)

```bash
# Crée un token : https://vercel.com/account/tokens
export VERCEL_TOKEN=vercel_xxx

npx vercel link --yes --token "$VERCEL_TOKEN"
npx vercel env add SESSION_SECRET production --token "$VERCEL_TOKEN"
npx vercel --prod --token "$VERCEL_TOKEN"
```

## Option C — Claim temporary (si dispo)

```bash
npx vercel deploy --temporary --yes
# Suivre le lien « claim » affiché
```

## Après déploiement

1. Ouvre l’URL Vercel sur ton **téléphone**
2. Login démo ou **Créer mon organisation**
3. Diagnostics → 6/6
4. Widget : `/widget?k=<clé>` (visible dans Canaux)

## PR

https://github.com/yussifridwane-ui/IA-agent-sales-/pull/1
