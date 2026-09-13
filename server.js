// ============================================================
// PARTY VOICE - Serveur de signalisation + relay audio
// ============================================================
// Ce serveur fait deux choses :
// 1. Gère la création/join de "party" via un code à 6 caractères
// 2. Relaie les paquets audio entre les membres d'une même party
//
// Tout passe par WebSocket (simple à héberger gratuitement,
// pas de config réseau compliquée côté PS4/routeur).
// ============================================================

const express = require("express");
const http = require("http");
const net = require("net");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ------------------------------------------------------------
// Support TCP brut EN PLUS du WebSocket.
// La PS4 (client C++) se connecte en TCP simple, pas besoin
// d'implémenter le handshake WebSocket côté PS4 (complexe et
// impossible à tester sans matériel réel). Un navigateur/outil
// de debug peut toujours utiliser le WebSocket classique.
//
// Protocole TCP : chaque message est préfixé par 4 octets
// (uint32 little-endian = longueur du message qui suit).
//   - Si le 1er octet du message vaut 0x01 -> le reste est du JSON (texte)
//   - Si le 1er octet du message vaut 0x02 -> le reste est de l'audio (binaire)
// ------------------------------------------------------------
const TYPE_JSON = 0x01;
const TYPE_AUDIO = 0x02;

const tcpServer = net.createServer((socket) => {
  socket.id = crypto.randomUUID();
  socket.partyCode = null;
  socket.username = null;
  socket.isTcp = true;
  socket._buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    socket._buffer = Buffer.concat([socket._buffer, chunk]);

    // On dépile tous les messages complets présents dans le buffer
    while (socket._buffer.length >= 5) {
      const msgLen = socket._buffer.readUInt32LE(0);
      const totalLen = 4 + msgLen;
      if (socket._buffer.length < totalLen) break; // message pas complet, on attend la suite

      const type = socket._buffer[4];
      const payload = socket._buffer.slice(5, totalLen);
      socket._buffer = socket._buffer.slice(totalLen);

      if (type === TYPE_JSON) {
        let msg;
        try {
          msg = JSON.parse(payload.toString("utf8"));
        } catch (e) {
          continue;
        }
        handleClientMessage(socket, msg);
      } else if (type === TYPE_AUDIO) {
        handleAudioPacket(socket, payload);
      }
    }
  });

  socket.on("close", () => handleLeaveParty(socket));
  socket.on("error", () => {});
});

function tcpSendJSON(socket, obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt32LE(json.length + 1, 0);
  header[4] = TYPE_JSON;
  socket.write(Buffer.concat([header, json]));
}

function tcpSendAudio(socket, senderId, audioBuf) {
  const idBuf = Buffer.from(senderId, "utf8");
  const idLenByte = Buffer.from([idBuf.length]);
  const payload = Buffer.concat([idLenByte, idBuf, audioBuf]);
  const header = Buffer.alloc(5);
  header.writeUInt32LE(payload.length + 1, 0);
  header[4] = TYPE_AUDIO;
  socket.write(Buffer.concat([header, payload]));
}

// Route simple pour vérifier que le serveur tourne (utile pour Render/Railway healthcheck)
app.get("/", (req, res) => {
  res.send(`Party Voice server OK - ${parties.size} party(s) active`);
});

// ------------------------------------------------------------
// État en mémoire : { code -> { members: Map<id, ws>, createdAt } }
// ------------------------------------------------------------
const parties = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I pour éviter confusion
function generateCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    }
  } while (parties.has(code)); // évite les collisions
  return code;
}

// sendJSON fonctionne pour les deux transports (WebSocket ET TCP brut)
function sendJSON(sock, obj) {
  if (sock.isTcp) {
    if (!sock.destroyed) tcpSendJSON(sock, obj);
  } else if (sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify(obj));
  }
}

function broadcastToParty(code, obj, exceptId = null) {
  const party = parties.get(code);
  if (!party) return;
  for (const [memberId, memberSock] of party.members) {
    if (memberId !== exceptId) sendJSON(memberSock, obj);
  }
}

// ------------------------------------------------------------
// Connexion WebSocket
// ------------------------------------------------------------
wss.on("connection", (ws) => {
  ws.id = crypto.randomUUID();
  ws.partyCode = null;
  ws.username = null;

  ws.on("message", (raw, isBinary) => {
    // Les paquets audio arrivent en binaire (Opus encodé côté client) -> relais direct
    if (isBinary) {
      handleAudioPacket(ws, raw);
      return;
    }

    // Le reste (create/join/leave/mute) arrive en JSON texte
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return sendJSON(ws, { type: "error", message: "JSON invalide" });
    }

    handleClientMessage(ws, msg);
  });

  ws.on("close", () => handleLeaveParty(ws));
});

// ------------------------------------------------------------
// Handlers
// ------------------------------------------------------------
function handleClientMessage(sock, msg) {
  switch (msg.type) {
    case "create_party":
      return handleCreateParty(sock, msg);
    case "join_party":
      return handleJoinParty(sock, msg);
    case "leave_party":
      return handleLeaveParty(sock);
    case "mute_state":
      return handleMuteState(sock, msg);
    case "ping":
      return sendJSON(sock, { type: "pong" });
    default:
      return sendJSON(sock, { type: "error", message: "Type de message inconnu" });
  }
}

function handleCreateParty(ws, msg) {
  const code = generateCode();
  const username = (msg.username || "Joueur").slice(0, 20);

  parties.set(code, {
    members: new Map([[ws.id, ws]]),
    createdAt: Date.now(),
  });

  ws.partyCode = code;
  ws.username = username;

  sendJSON(ws, {
    type: "party_created",
    code,
    members: [{ id: ws.id, username }],
  });

  console.log(`[+] Party créée: ${code} par ${username}`);
}

function handleJoinParty(ws, msg) {
  const code = (msg.code || "").toUpperCase().trim();
  const username = (msg.username || "Joueur").slice(0, 20);
  const party = parties.get(code);

  if (!party) {
    return sendJSON(ws, { type: "error", message: "Code de party invalide ou expiré" });
  }
  if (party.members.size >= 16) {
    return sendJSON(ws, { type: "error", message: "Party pleine (16 max)" });
  }

  ws.partyCode = code;
  ws.username = username;
  party.members.set(ws.id, ws);

  const memberList = [...party.members.entries()].map(([id, w]) => ({
    id,
    username: w.username,
  }));

  // Confirme au nouvel arrivant + donne la liste actuelle
  sendJSON(ws, { type: "party_joined", code, members: memberList });

  // Prévient tout le monde qu'un nouveau membre est là
  broadcastToParty(code, { type: "member_joined", id: ws.id, username }, ws.id);

  console.log(`[+] ${username} a rejoint la party ${code} (${party.members.size} membres)`);
}

function handleLeaveParty(ws) {
  const code = ws.partyCode;
  if (!code) return;
  const party = parties.get(code);
  if (!party) return;

  party.members.delete(ws.id);
  broadcastToParty(code, { type: "member_left", id: ws.id, username: ws.username });

  console.log(`[-] ${ws.username || "?"} a quitté la party ${code}`);

  // Si la party est vide, on la supprime
  if (party.members.size === 0) {
    parties.delete(code);
    console.log(`[x] Party ${code} supprimée (vide)`);
  }

  ws.partyCode = null;
}

function handleMuteState(ws, msg) {
  if (!ws.partyCode) return;
  broadcastToParty(ws.partyCode, {
    type: "mute_state",
    id: ws.id,
    muted: !!msg.muted,
  }, ws.id);
}

// Relais binaire : réémet le paquet audio à tous les autres membres de la party
// (fonctionne pour les clients WebSocket ET TCP brut)
function handleAudioPacket(sock, buffer) {
  if (!sock.partyCode) return;
  const party = parties.get(sock.partyCode);
  if (!party) return;

  for (const [memberId, memberSock] of party.members) {
    if (memberId === sock.id) continue;

    if (memberSock.isTcp) {
      if (!memberSock.destroyed) tcpSendAudio(memberSock, sock.id, buffer);
    } else if (memberSock.readyState === WebSocket.OPEN) {
      const idBuf = Buffer.from(sock.id, "utf8");
      const header = Buffer.from([idBuf.length]);
      memberSock.send(Buffer.concat([header, idBuf, buffer]), { binary: true });
    }
  }
}

// ------------------------------------------------------------
// Nettoyage des party abandonnées (sécurité, au cas où)
// ------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [code, party] of parties) {
    if (party.members.size === 0 && now - party.createdAt > 60000) {
      parties.delete(code);
    }
  }
}, 60000);

// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const TCP_PORT = process.env.TCP_PORT || 3001;

server.listen(PORT, () => {
  console.log(`Party Voice server (WebSocket + HTTP) démarré sur le port ${PORT}`);
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`Party Voice server (TCP brut, pour client PS4) démarré sur le port ${TCP_PORT}`);
});
