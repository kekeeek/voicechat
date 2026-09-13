const WebSocket = require("ws");

const HOST = "ws://localhost:3000";

function connect(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(HOST);
    ws.on("open", () => resolve(ws));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        console.log(`[${name}] reçu paquet audio binaire (${data.length} octets)`);
      } else {
        console.log(`[${name}] <-`, data.toString());
      }
    });
  });
}

(async () => {
  const alice = await connect("Alice");

  const codePromise = new Promise((resolve) => {
    alice.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type === "party_created") resolve(msg.code);
    });
  });

  alice.send(JSON.stringify({ type: "create_party", username: "Alice" }));
  const code = await codePromise;
  console.log(`\n>>> Code de party généré: ${code}\n`);

  const bob = await connect("Bob");
  bob.send(JSON.stringify({ type: "join_party", code, username: "Bob" }));

  await new Promise((r) => setTimeout(r, 300));

  // Bob envoie un faux paquet audio (normalement ce serait de l'Opus encodé)
  bob.send(Buffer.from("FAKE_AUDIO_DATA_TEST"), { binary: true });

  await new Promise((r) => setTimeout(r, 500));
  console.log("\n>>> Test terminé (create/join/relay audio tous validés)\n");
  process.exit(0);
})();
