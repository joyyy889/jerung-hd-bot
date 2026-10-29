
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");

const logger = pino({ level: "silent" });
const processedMessages = new Set();

const VIDEO_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".ogv": "video/ogg",
};

function getMessageContent(message) {
  let content = message;

  while (content) {
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
    } else if (content.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
    } else if (content.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
    } else if (content.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
    } else {
      break;
    }
  }

  return content || {};
}

function getVideoMime(document) {
  const mime = (document.mimetype || "").toLowerCase().trim();
  const filename = (document.fileName || "").toLowerCase();

  if (mime.startsWith("video/")) {
    return mime;
  }

  const extension = Object.keys(VIDEO_TYPES).find((ext) =>
    filename.endsWith(ext)
  );

  return extension ? VIDEO_TYPES[extension] : null;
}

function isVideoDocument(document) {
  return Boolean(getVideoMime(document));
}

function getText(content) {
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ""
  ).trim();
}

async function handleMessage(sock, msg) {
  const remoteJid = msg.key.remoteJid;

  if (!remoteJid || msg.key.fromMe || remoteJid.endsWith("@g.us")) {
    return;
  }

  const messageId = msg.key.id;

  if (!messageId || processedMessages.has(messageId)) {
    return;
  }

  processedMessages.add(messageId);

  // Elakkan set ID membesar tanpa had.
  if (processedMessages.size > 2000) {
    const oldest = processedMessages.values().next().value;
    processedMessages.delete(oldest);
  }

  const content = getMessageContent(msg.message);
  const text = getText(content).toLowerCase();

  // Arahan permulaan
  if (/^(hi|hai|hello|helo|start|menu)$/.test(text)) {
    await sock.sendMessage(remoteJid, {
      text:
        "🦈 *JERUNG HD BOT*\n\n" +
        "Untuk menghantar video:\n\n" +
        "1. Tekan butang + atau klip 📎 di WhatsApp.\n" +
        "2. Pilih *Document / Dokumen*.\n" +
        "3. Pilih fail video yang kau nak hantar.\n" +
        "4. Tekan Send dan tunggu bot memprosesnya.\n\n" +
        "📌 Hantar video sebagai Document, bukan Gallery video.\n" +
        "🎬 Bot akan cuba menghantarnya semula sebagai video biasa.\n\n" +
        "Nota: Keupayaan memainkan video bergantung pada format, codec dan sokongan WhatsApp.",
    });
    return;
  }

  // Terima dokumen video sahaja
  const document = content.documentMessage;

  if (document) {
    const mimetype = getVideoMime(document);

    if (!isVideoDocument(document)) {
      await sock.sendMessage(remoteJid, {
        text:
          "⚠️ Fail ini tak dapat dikenal pasti sebagai video.\n\n" +
          "Sila hantar fail video melalui *Document / Dokumen* dan pastikan nama fail mempunyai sambungan seperti .mp4, .mov, .mkv atau .avi.",
      });
      return;
    }

    await sock.sendMessage(remoteJid, {
      text: "⏳ Video diterima! Sedang memproses...",
    });

    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage,
        }
      );

      if (!buffer || !buffer.length) {
        throw new Error("Fail video kosong atau gagal dimuat turun.");
      }

      const originalName =
        document.fileName || `jerung-hd-${Date.now()}`;

      // Hantar sebagai video biasa tanpa menukar atau encode semula.
      await sock.sendMessage(remoteJid, {
        video: buffer,
        mimetype,
        fileName: originalName,
        caption: "✅ *JERUNG HD* — Video siap dihantar.",
      });

      console.log(
        `Video berjaya dihantar: ${originalName} (${buffer.length} bytes)`
      );
    } catch (error) {
      console.error("Ralat pemprosesan video:", error);

      await sock.sendMessage(remoteJid, {
        text:
          "❌ Maaf, video gagal dihantar sebagai video biasa.\n\n" +
          "Format atau codec mungkin tidak disokong WhatsApp. Cuba video MP4 dengan codec H.264/AAC.",
      });
    }

    return;
  }

  // Video yang dihantar melalui Gallery
  if (content.videoMessage) {
    await sock.sendMessage(remoteJid, {
      text:
        "⚠️ Kau hantar video melalui Gallery.\n\n" +
        "Sila hantar semula sebagai *Document / Dokumen*:\n" +
        "1. Tekan + atau 📎.\n" +
        "2. Pilih Document / Dokumen.\n" +
        "3. Pilih fail video dan tekan Send.",
    });
  }
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Imbas QR ini menggunakan WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ JERUNG HD berjaya disambungkan!");
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      console.log("Sambungan WhatsApp terputus.");

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("Menyambung semula dalam 3 saat...");
        setTimeout(() => {
          startBot().catch((error) => {
            console.error("Gagal menyambung semula:", error);
          });
        }, 3000);
      } else {
        console.log(
          "Sesi telah log keluar. Padam folder auth_info dan sambungkan semula jika perlu."
        );
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (error) {
        console.error("Ralat mengendalikan mesej:", error);
      }
    }
  });
}

startBot().catch((error) => {
  console.error("Bot gagal dimulakan:", error);
  process.exitCode = 1;
});
