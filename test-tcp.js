const net = require("net");

const TYPE_JSON = 0x01;
const TYPE_AUDIO = 0x02;

function sendJSON(sock, obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt32LE(json.length + 1, 0);
  header[4] = TYPE_JSON;
  sock.write(Buffer.concat([header, json]));
}

function sendAudio(sock, buf) {
  const header = Buffer.alloc(5);
  header.writeUInt32LE(buf.length + 1, 0);
  header[4] = TYPE_AUDIO;
  sock.write(Buffer.concat([header, buf]));
}

function makeReader(name) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const len = buffer.readUInt32LE(0);
      const total = 4 + len;
      if (buffer.length < total) break;
      const type = buffer[4];
      const payload = buffer.slice(5, total);
      buffer = buffer.slice(total);
      if (type === TYPE_JSON) {
        console.log(`[${name}] JSON <-`, payload.toString("utf8"));
      } else {
        console.log(`[${name}] AUDIO <- (${payload.length} octets)`);
      }
    }
  };
}

const alice = net.createConnection(3001, "localhost", () => {
  alice.on("data", makeReader("Alice-TCP"));
  sendJSON(alice, { type: "create_party", username: "Alice-TCP" });
});

let bobCode = null;
const readerAlice = (chunk) => {
  makeReader("Alice-TCP")(chunk);
};

alice.on("data", (chunk) => {
  const str = chunk.toString("utf8");
  const match = str.match(/"code":"([A-Z0-9]{6})"/);
  if (match && !bobCode) {
    bobCode = match[1];
    console.log(`\n>>> Code récupéré côté TCP: ${bobCode}\n`);

    const bob = net.createConnection(3001, "localhost", () => {
      bob.on("data", makeReader("Bob-TCP"));
      sendJSON(bob, { type: "join_party", code: bobCode, username: "Bob-TCP" });

      setTimeout(() => {
        sendAudio(bob, Buffer.from("FAKE_TCP_AUDIO_PACKET"));
      }, 300);

      setTimeout(() => {
        console.log("\n>>> Test TCP terminé\n");
        process.exit(0);
      }, 800);
    });
  }
});
