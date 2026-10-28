
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["JERUNG HD", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Imbas QR ini menggunakan WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("JERUNG HD berjaya disambungkan!");
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      if (code !== DisconnectReason.loggedOut) {
        startBot();
      } else {
        console.log("Sesi WhatsApp tamat. Sambungkan semula.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const jid = msg.key.remoteJid;
      const textMessage =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (textMessage.trim().toLowerCase() === "menu") {
        await sock.sendMessage(jid, {
          text:
            "🦈 *JERUNG HD*\n\n" +
            "Hantar video kepada bot ini untuk mula.\n\n" +
            "Nota: WhatsApp masih boleh memampatkan video. " +
            "Kualiti asal atau 4K tidak dapat dijamin."
        });
        continue;
      }

      const messageContent =
        msg.message.imageMessage ||
        msg.message.videoMessage ||
        msg.message.documentMessage;

      if (!messageContent) continue;

      try {
        await sock.sendMessage(jid, {
          text: "🦈 JERUNG HD menerima fail kau. Sedang menyediakan proses video..."
        });

        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock.updateMediaMessage
          }
        );

        const isVideo = Boolean(msg.message.videoMessage) ||
          (
            msg.message.documentMessage?.mimetype || ""
          ).startsWith("video/");

        const isImage = Boolean(msg.message.imageMessage);

        if (!isVideo && !isImage) {
          await sock.sendMessage(jid, {
            text: "Buat masa ini, hantar video atau gambar sahaja."
          });
          continue;
        }

        const tempDir = path.join(__dirname, "temp");
        fs.mkdirSync(tempDir, { recursive: true });

        const extension = isImage ? "jpg" : "mp4";
        const filePath = path.join(
          tempDir,
          `${Date.now()}.${extension}`
        );

        fs.writeFileSync(filePath, buffer);

        if (isImage) {
          await sock.sendMessage(jid, {
            image: fs.readFileSync(filePath),
            caption: "JERUNG HD — gambar diterima."
          });
        } else {
          await sock.sendMessage(jid, {
            video: fs.readFileSync(filePath),
            mimetype: "video/mp4",
            caption:
              "🦈 JERUNG HD — video dihantar semula. " +
              "WhatsApp mungkin masih memampatkannya."
          });
        }

        fs.unlinkSync(filePath);
      } catch (error) {
        console.error("Ralat memproses media:", error);
        await sock.sendMessage(jid, {
          text: "Maaf, fail tak berjaya diproses. Cuba hantar video yang lebih kecil."
        }).catch(() => {});
      }
    }
  });
}

startBot().catch(console.error);
