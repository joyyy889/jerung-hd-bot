
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");
const ffmpegPath = require("ffmpeg-static");

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const logger = pino({ level: "silent" });

const BOT_NAME = "JERUNG HD BOT";
const AUTH_DIR = "./auth_info_baileys";

if (!ffmpegPath) {
  throw new Error(
    "FFmpeg binary not found. Install ffmpeg-static first."
  );
}

// Run FFmpeg and wait for it to finish.
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";

    process.stderr.on("data", (data) => {
      stderr += data.toString();

      // Avoid keeping an unlimited amount of error output in memory.
      if (stderr.length > 20000) {
        stderr = stderr.slice(-20000);
      }
    });

    process.on("error", reject);

    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg exited with code ${code}\n${stderr}`
          )
        );
      }
    });
  });
}

// Unwrap WhatsApp message wrappers.
function unwrapMessage(message) {
  let current = message;

  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (
      current.documentWithCaptionMessage?.message
    ) {
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

  sock.ev.on("connection.update", async (update) => {
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

      console.log(
        "Sambungan WhatsApp terputus. Kod:",
        statusCode
      );

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(
          "Akaun telah logout. Sambungkan semula WhatsApp."
        );
        return;
      }

      console.log("Menyambung semula dalam 3 saat...");

      setTimeout(() => {
        startBot().catch((err) => {
          console.error("Reconnect error:", err);
        });
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

      // Main menu
      if (
        ["hi", "hai", "hello", "helo", "start", "menu"]
          .includes(text)
      ) {
        await sock.sendMessage(chatId, {
          text:
            `🦈 ${BOT_NAME}\n\n` +
            "Untuk menghantar video:\n\n" +
            "1. Tekan + atau klip 📎 di WhatsApp.\n" +
            "2. Pilih Document / Dokumen.\n" +
            "3. Pilih fail video .MOV atau .MP4.\n" +
            "4. Tekan Send dan tunggu proses selesai.\n\n" +
            "📌 Video akan diproses menggunakan FFmpeg " +
            "dan dihantar semula sebagai video MP4.\n\n" +
            "Nota: Proses encoding mungkin mengambil masa " +
            "bergantung pada saiz dan durasi video.",
        }, { quoted: msg });

        continue;
      }

      const document = message.documentMessage;

      // Keep the existing Document-only workflow.
      if (!document) {
        if (message.videoMessage) {
          await sock.sendMessage(chatId, {
            text:
              "📌 Sila hantar video melalui Document / Dokumen, " +
              "bukan Gallery video.",
          }, { quoted: msg });
        }

        continue;
      }

      const originalName = path.basename(
        document.fileName || "video"
      );

      const extension =
        path.extname(originalName).toLowerCase();

      const mimeType = (
        document.mimetype || ""
      ).toLowerCase();

      const isMOV =
        extension === ".mov" ||
        mimeType === "video/quicktime";

      const isMP4 =
        extension === ".mp4" ||
        mimeType === "video/mp4";

      if (!isMOV && !isMP4) {
        await sock.sendMessage(chatId, {
          text:
            "❌ Format tidak disokong.\n\n" +
            "Sila hantar video dalam format MOV atau MP4.",
        }, { quoted: msg });

        continue;
      }

      let tempDir;

      try {
        console.log(`📥 Menerima fail: ${originalName}`);

        await sock.sendMessage(chatId, {
          text:
            "⏳ Video diterima! Sedang memproses...\n\n" +
            "Jangan tutup bot sehingga proses selesai.",
        }, { quoted: msg });

        // Download the original WhatsApp document.
        console.log("📥 Memuat turun video...");

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
          throw new Error("Video download returned an empty buffer.");
        }

        console.log(
          `✅ Download selesai: ${buffer.length} bytes`
        );

        tempDir = await fs.promises.mkdtemp(
          path.join(os.tmpdir(), "jerung-hd-")
        );

        const inputPath = path.join(
          tempDir,
          `input${extension}`
        );

        const outputPath = path.join(
          tempDir,
          "output.mp4"
        );

        await fs.promises.writeFile(inputPath, buffer);

        console.log("📦 Menghantar video tanpa encoding semula...");

await sock.sendMessage(chatId, {
  video: { url: inputPath },
  mimetype: mimeType || "video/mp4",
  fileName: originalName,
  caption: "✅ JERUNG HD — Video sedia untuk disimpan atau dikongsi ke Status."
}, { quoted: msg });

console.log("✅ Video berjaya dihantar.");
        console.log("📤 Menghantar video ke WhatsApp...");

        await sock.sendMessage(
          chatId,
          {
            video: { url: outputPath },
            mimetype: "video/mp4",
            fileName:
              `${path.parse(originalName).name}_JERUNG_HD.mp4`,
            caption:
              "🦈 JERUNG HD\n\n" +
              "✅ Video selesai diproses!\n" +
              "📁 Format: MP4\n" +
              `📦 Saiz output: ${(outputStats.size / 1048576).toFixed(2)} MB`,
          },
          { quoted: msg }
        );

        console.log(
          `✅ Video berjaya dihantar: ${originalName}`
        );
      } catch (error) {
        console.error(
          "❌ VIDEO PROCESSING / SEND ERROR:",
          error
        );

        try {
          await sock.sendMessage(chatId, {
            text:
              "❌ Video gagal diproses atau dihantar.\n\n" +
              "Sila cuba lagi. Jika masalah berulang, " +
              "admin perlu menyemak log bot.",
          }, { quoted: msg });
        } catch (sendError) {
          console.error(
            "❌ Gagal menghantar mesej ralat:",
            sendError
          );
        }
      } finally {
        if (tempDir) {
          await fs.promises.rm(tempDir, {
            recursive: true,
            force: true,
          }).catch((err) => {
            console.error("Gagal membersihkan fail sementara:", err);
          });
        }
      }
    }
  });
}

startBot().catch((error) => {
  console.error("❌ Bot gagal dimulakan:", error);
  process.exitCode = 1;
});
