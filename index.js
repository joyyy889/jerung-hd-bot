
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const os = require("os");
const path = require("path");

const logger = pino({ level: "silent" });
const BOT_NAME = "JERUNG HD BOT";
const AUTH_DIR = "./auth_info_baileys";

function unwrapMessage(message) {
  let current = message;

  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else {
      break;
    }
  }

  return current;
}

function getText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    ""
  ).trim();
}

function getVideoInfo(document) {
  const originalName = path.basename(
    document.fileName || "video"
  );

  const extension = path.extname(originalName).toLowerCase();
  const mime = (document.mimetype || "").toLowerCase();

  if (extension === ".mov" || mime === "video/quicktime") {
    return {
      originalName,
      extension: ".mov",
      mimeType: "video/quicktime",
    };
  }

  if (extension === ".mp4" || mime === "video/mp4") {
    return {
      originalName,
      extension: ".mp4",
      mimeType: "video/mp4",
    };
  }

  return null;
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan QR ini menggunakan WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log(`✅ ${BOT_NAME} berjaya disambungkan!`);
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      console.log("Sambungan terputus. Kod:", statusCode);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("Akaun logout. Pautkan WhatsApp semula.");
        return;
      }

      setTimeout(() => {
        startBot().catch(console.error);
      }, 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;

      if (!chatId || chatId === "status@broadcast") {
        continue;
      }

      const message = unwrapMessage(msg.message);
      const text = getText(message).toLowerCase();

      if (["hi", "hai", "hello", "helo", "start", "menu"].includes(text)) {
await sock.sendMessage(
  chatId,
  {
    video: { url: inputPath },
    mimetype: video.mimeType,
    fileName: video.originalName,
    caption:
      "✅ JERUNG HD\n" +
      "📁 Format asal dikekalkan jika disokong.\n" +
      "🦈 Tiada encoding semula oleh bot."
  },
  { quoted: msg }
);
      const document = message.documentMessage;

      if (!document) {
        if (message.videoMessage) {
          await sock.sendMessage(
            chatId,
            {
              text:
                "📌 Sila hantar video melalui Document / Dokumen " +
                "untuk mengekalkan fail asal.",
            },
            { quoted: msg }
          );
        }
        continue;
      }

      const video = getVideoInfo(document);

      if (!video) {
        await sock.sendMessage(
          chatId,
          {
            text: "❌ Format tidak disokong. Hantar fail MOV atau MP4.",
          },
          { quoted: msg }
        );
        continue;
      }

      let tempDir;

      try {
        await sock.sendMessage(
          chatId,
          { text: "⏳ Memuat turun fail asal. Tiada encoding semula..." },
          { quoted: msg }
        );

        tempDir = await fs.promises.mkdtemp(
          path.join(os.tmpdir(), "jerung-hd-")
        );

        const inputPath = path.join(
          tempDir,
          video.originalName
        );

        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          }
        );

        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          throw new Error("Fail asal kosong atau gagal dimuat turun.");
        }

        await fs.promises.writeFile(inputPath, buffer);

        const stats = await fs.promises.stat(inputPath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        console.log(
          `📦 Fail asal: ${video.originalName} (${sizeMB} MB)`
        );

        // Hantar sebagai dokumen supaya fail asal tidak di-encode
        // sebagai mesej video oleh bot.
        await sock.sendMessage(
          chatId,
          {
            document: { url: inputPath },
            mimetype: video.mimeType,
            fileName: video.originalName,
            caption:
              `✅ ${BOT_NAME}\n` +
              "Fail asal dihantar tanpa encoding semula.\n" +
              `Format: ${video.extension.slice(1).toUpperCase()}\n` +
              `Saiz fail yang diterima bot: ${sizeMB} MB\n\n` +
              "Untuk Status WhatsApp, simpan video ke galeri dahulu jika perlu.",
          },
          { quoted: msg }
        );

        console.log("✅ Fail asal berjaya dihantar.");
      } catch (error) {
        console.error("❌ Ralat video:", error);

        await sock.sendMessage(
          chatId,
          {
            text:
              "❌ Gagal memproses fail.\n" +
              `Sebab: ${error.message || "Ralat tidak diketahui"}`,
          },
          { quoted: msg }
        ).catch(console.error);
      } finally {
        if (tempDir) {
          await fs.promises.rm(tempDir, {
            recursive: true,
            force: true,
          }).catch(console.error);
        }
      }
    }
  });
}

startBot().catch((error) => {
  console.error("❌ Bot gagal dimulakan:", error);
  process.exitCode = 1;
});
