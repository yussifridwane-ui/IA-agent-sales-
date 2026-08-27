# AI Sales Agent — Agent commercial IA & CRM

> **Un commercial IA qui ne ment jamais.**
> L'agent répond 24 h/24 en s'appuyant **uniquement** sur votre catalogue réel (prix, stock, caractéristiques). Il qualifie, note et transmet — jamais d'invention.

SaaS multi-tenant Node.js ≥ 18, **zéro dépendance npm** (HTTP natif, SQLite `node:sqlite`, crypto PBKDF2).

## Démarrage rapide

```bash
cp .env.example .env
npm start          # → http://localhost:3000
npm test           # 193 tests (Phases 1 → 8)
```

Comptes démo (après seed) :

```bash
node scripts/seed-demo.mjs
DB_PATH=data/demo.db npm start
# demo@techstore.demo / demo12345
```

## Positionnement produit

| Promesse | Implémentation |
| --- | --- |
| **0 hallucination** | Garde `validate.js` : prix hors catalogue rejetés ; repli « Je n'ai pas cette information dans le catalogue » |
| **Pilote gratuit** | `PILOT_MODE=true` (défaut hors test) : pas de limite d'usage, pas de carte bancaire |
| **Lead scoring explicable** | Intention 30 · Budget 25 · Urgence 20 · Engagement 15 · Adéquation 10 |
| **Mots de passe** | PBKDF2-SHA256, 210 000 itérations, sel unique, comparaison temps constant |
| **Isolation multi-tenant** | Chaque requête filtrée par `organization_id` ; page Diagnostics le prouve |
| **Diagnostics** | `/dashboard/diagnostics` + `GET /api/diagnostics` |

## Phases livrées

1. **Fondations SaaS** — landing, auth, multi-tenant, RBAC, onboarding, settings
2. **CRM commercial** — catalogue, leads, pipeline, deals, tâches, contacts
3. **Moteur IA** — agent, RAG, tool calling, anti-hallucination, handoff humain
4. **Smart Sales** — scoring multi-dimensionnel, BANT, NBA, Customer 360, coach
5. **Automation** — EVENT→CONDITION→ACTION, follow-ups, séquences, campagnes
6. **Omnicanal** — WhatsApp, Messenger, Instagram, e-mail, SMS, widget webchat
7. **Commerce** — devis → commande → paiement (jamais simulé)
8. **SaaS billing** — plans, trial, limites (désactivées en pilote), factures

## Variables clés

Voir `.env.example`. Obligatoires en production : `SESSION_SECRET`. Optionnel : `AI_API_KEY` (sinon moteur local hors-ligne).

```
PILOT_MODE=true   # illimité pendant le pilote commerçants
```

## Architecture

```
server/
  ai/           moteur IA + Smart Sales + validation anti-hallucination
  automation/   règles, follow-ups, prédiction
  channels/     WhatsApp / Messenger / Instagram / e-mail / SMS
  routes/       API + pages
  views/        HTML serveur (landing, CRM, billing, diagnostics…)
  diagnostics.js  suite de diagnostics intégrée
  billing.js      plans + PILOT_MODE
  security.js     PBKDF2-SHA256
public/         CSS + JS client
test/           193 tests automatisés
```

## Licence

MIT
