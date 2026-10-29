
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["JERUNG HD", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Scan QR WhatsApp ini:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("JERUNG HD berjaya disambungkan!");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        startBot();
      } else {
        console.log("WhatsApp logged out. Pair semula diperlukan.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const content = msg.message;
      const doc = content.documentMessage;
      const video = content.videoMessage;

      const isVideoDocument =
        doc && (doc.mimetype || "").startsWith("video/");

      if (!isVideoDocument && !video) continue;

      let filePath;

      try {
        await sock.sendMessage(jid, {
          text: "🦈 JERUNG HD menerima video. Sedang memproses...",
        });

        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock.updateMediaMessage,
          }
        );

        filePath = `jerung-${Date.now()}.mp4`;
        fs.writeFileSync(filePath, buffer);

        await sock.sendMessage(jid, {
          video: fs.readFileSync(filePath),
          mimetype: doc?.mimetype || video?.mimetype || "video/mp4",
          caption: "🦈 JERUNG HD — siap!",
        });
      } catch (error) {
        console.error("Gagal memproses video:", error);
        await sock.sendMessage(jid, {
          text: "Maaf, video gagal diproses. Cuba hantar fail MP4 sebagai Document.",
        }).catch(() => {});
      } finally {
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }
  });
}

startBot().catch(console.error);
