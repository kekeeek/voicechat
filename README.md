# Party Voice — Serveur

Serveur de signalisation + relay audio, testé et fonctionnel (create party / join party / relay de paquets audio via WebSocket binaire).

## Déploiement gratuit (Render.com)

1. Crée un compte sur https://render.com (gratuit, pas de CB requise pour le plan free)
2. Pousse ce dossier `server/` sur un repo GitHub (peut être privé)
3. Sur Render : **New +** → **Web Service** → connecte ton repo
4. Render détecte `render.yaml` automatiquement, sinon configure à la main :
   - Build command: `npm install`
   - Start command: `node server.js`
   - Plan: **Free**
5. Une fois déployé, Render te donne une URL du genre `https://party-voice-server.onrender.com`
   → ton client PS4 se connectera en `wss://party-voice-server.onrender.com`

⚠️ **Limite du plan gratuit Render** : le serveur "s'endort" après 15 min d'inactivité et met ~30-50s à se réveiller au prochain appel. Si ça pose problème, alternative gratuite sans ce défaut : **Railway** (a un quota d'heures gratuites/mois) ou un petit VPS gratuit type Oracle Cloud Free Tier (plus stable mais plus de config).

## Deux transports supportés

- **TCP brut sur le port `3001`** (ou `TCP_PORT` env var) — c'est celui qu'utilise le client PS4 (voir `party-voice-client/`), pas besoin d'implémenter le handshake WebSocket côté PS4.
- **WebSocket sur le port `3000`** — utile pour débugger/tester depuis un PC/navigateur.

Les deux exposent exactement la même logique (create/join party, relai audio).

### Format du protocole TCP brut
Chaque message : `[4 octets uint32 little-endian = longueur][1 octet type][payload]`
- type `0x01` = JSON (texte)
- type `0x02` = audio (binaire, préfixé par `[1 octet longueur ID][ID émetteur][données audio]` en réception)

Teste-le avec `node test-tcp.js` pendant que le serveur tourne.

## Protocole JSON (pour le client PS4)

Connexion : TCP brut (voir ci-dessus) ou WebSocket vers l'URL du serveur.

### Messages JSON (texte)

**Créer une party :**
```json
{ "type": "create_party", "username": "Bob" }
```
Réponse :
```json
{ "type": "party_created", "code": "AB12CD", "members": [...] }
```

**Rejoindre une party :**
```json
{ "type": "join_party", "code": "AB12CD", "username": "Alice" }
```
Réponse (à toi) :
```json
{ "type": "party_joined", "code": "AB12CD", "members": [...] }
```
Réponse (broadcast aux autres) :
```json
{ "type": "member_joined", "id": "...", "username": "Alice" }
```

**Quitter :** `{ "type": "leave_party" }` (ou juste fermer la connexion)

**Mute/unmute :** `{ "type": "mute_state", "muted": true }`

### Paquets audio (binaire)

Envoie directement les octets audio encodés (Opus recommandé) en tant que message **binaire** WebSocket. Le serveur les relaie automatiquement à tous les autres membres de la party, préfixés par l'ID de l'émetteur :

```
[1 octet: longueur de l'ID][ID en UTF-8][données audio brutes]
```

Le client doit lire ce header pour savoir de qui vient l'audio et le jouer sur le bon "canal".

## Fichiers

- `server.js` — le serveur complet, testé
- `test-flow.js` — script de test (create/join/audio), lance-le avec `node test-flow.js` pendant que le serveur tourne pour vérifier que tout fonctionne
