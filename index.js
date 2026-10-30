
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// ========================================
// JERUNG HD CONFIGURATION
// ========================================

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

const activeChats = new Set();
const processingChats = new Set();

const WELCOME_MESSAGE =
  "SELAMAT DATANG KE JERUNG HD !\n\n" +
  "now letak video dalam bentuk document bukan dari gallery";

const GALLERY_REMINDER =
  "salah ni bray, tekan foto/video dari document dan pilih kat situ bray";

const SIZE_REMINDER =
  "Reminder bray! Pastikan video tidak melebihi 100MB supaya tidak berlaku error.";

const MIME_BY_EXTENSION = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".ogv": "video/ogg",
};

// ========================================
// HELPER FUNCTIONS
// ========================================

function getFileExtension(fileName, mimetype) {
  const extension = path.extname(fileName || "").toLowerCase();

  if (extension && /^[a-z0-9.]+$/.test(extension)) {
    return extension;
  }

  const mime = (mimetype || "").toLowerCase();

  for (const [ext, type] of Object.entries(MIME_BY_EXTENSION)) {
    if (type === mime) return ext;
  }

  return null;
}

function getFileSize(value) {
  if (value === undefined || value === null) return 0;

  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }

  const size = Number(value);
  return Number.isFinite(size) ? size : 0;
}

function unwrapMessage(message) {
  let content = message;

  while (content) {
    const wrapper =
      content.ephemeralMessage ||
      content.viewOnceMessage ||
      content.viewOnceMessageV2 ||
      content.documentWithCaptionMessage;

    if (!wrapper?.message) break;

    content = wrapper.message;
  }

  return content;
}

function getMessageText(content) {
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    ""
  );
}

async function sendText(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

// ========================================
// FFmpeg STREAM COPY
// ========================================

async function processVideo(inputPath, outputPath) {
  console.log("[JERUNG HD] Starting FFmpeg stream copy...");

  await execFileAsync(
    FFMPEG_PATH,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", inputPath,
      "-map", "0:v?",
      "-map", "0:a?",
      "-c", "copy",
      outputPath,
    ],
    {
      timeout: 15 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  const outputStat = await fsp.stat(outputPath);

  if (!outputStat.size) {
    throw new Error("FFmpeg produced an empty output file.");
  }

  console.log("[JERUNG HD] Stream copy completed.");
  console.log("[JERUNG HD] Output size:", outputStat.size, "bytes");

  return outputStat;
}

// ========================================
// DOWNLOAD VIDEO DOCUMENT
// ========================================

async function downloadVideo(documentMessage, inputPath) {
  const mediaStream = await downloadContentFromMessage(
    documentMessage,
    "document"
  );

  let downloadedBytes = 0;

  const sizeLimiter = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;

      if (downloadedBytes > MAX_FILE_SIZE) {
        const error = new Error("FILE_TOO_LARGE");
        callback(error);
        return;
      }

      callback(null, chunk);
    },
  });

  await pipeline(
    mediaStream,
    sizeLimiter,
    fs.createWriteStream(inputPath)
  );

  return downloadedBytes;
}

// ========================================
// SEND VIDEO AS WHATSAPP VIDEO MESSAGE
// ========================================

async function sendVideo(sock, jid, outputPath, mimetype) {
  console.log("[JERUNG HD] Sending playable WhatsApp video...");

  await sock.sendMessage(jid, {
    video: {
      url: outputPath,
    },
    mimetype,
    ptv: false,
  });

  console.log("[JERUNG HD] Video successfully sent.");
}

// ========================================
// HANDLE INCOMING MESSAGES
// ========================================

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  if (!jid || jid === "status@broadcast") return;

  const content = unwrapMessage(msg.message);
  const text = getMessageText(content).trim();

  // --------------------------------------
  // STEP 1: BOT ACTIVATION
  // --------------------------------------

  if (text.toLowerCase() === "jerung hd") {
    activeChats.add(jid);

    await sendText(sock, jid, WELCOME_MESSAGE);

    console.log("[JERUNG HD] Activated for:", jid);

    return;
  }

  // Ignore messages until activation
  if (!activeChats.has(jid)) return;

  // --------------------------------------
  // STEP 2: DETECT GALLERY VIDEO
  // --------------------------------------

  if (content.videoMessage) {
    await sendText(sock, jid, GALLERY_REMINDER);

    console.log("[JERUNG HD] Gallery video rejected.");

    return;
  }

  // --------------------------------------
  // STEP 3: ACCEPT DOCUMENT VIDEO
  // --------------------------------------

  const documentMessage = content.documentMessage;

  if (!documentMessage) return;

  const originalName = documentMessage.fileName || "";
  const originalMime = (
    documentMessage.mimetype || ""
  ).toLowerCase();

  const extension = getFileExtension(
    originalName,
    originalMime
  );

  const isVideo =
    originalMime.startsWith("video/") ||
    (extension && Object.hasOwn(MIME_BY_EXTENSION, extension));

  if (!isVideo || !extension) return;

  // --------------------------------------
  // STEP 4: CHECK FILE SIZE
  // --------------------------------------

  const originalSize = getFileSize(
    documentMessage.fileLength
  );

  if (originalSize > MAX_FILE_SIZE) {
    await sendText(sock, jid, SIZE_REMINDER);
    return;
  }

  // Prevent overlapping jobs in the same chat
  if (processingChats.has(jid)) return;

  processingChats.add(jid);

  let tempDirectory;

  try {
    // ------------------------------------
    // STEP 5: CREATE TEMPORARY FILES
    // ------------------------------------

    tempDirectory = await fsp.mkdtemp(
      path.join(os.tmpdir(), "jerung-hd-")
    );

    const inputPath = path.join(
      tempDirectory,
      `original${extension}`
    );

    const outputPath = path.join(
      tempDirectory,
      `jerung-hd${extension}`
    );

    // ------------------------------------
    // STEP 6: DOWNLOAD ORIGINAL VIDEO
    // ------------------------------------

    console.log("[JERUNG HD] Downloading:", originalName);

    try {
      const downloadedSize = await downloadVideo(
        documentMessage,
        inputPath
      );

      console.log(
        "[JERUNG HD] Downloaded:",
        downloadedSize,
        "bytes"
      );
    } catch (error) {
      if (error.message === "FILE_TOO_LARGE") {
        await sendText(sock, jid, SIZE_REMINDER);
        return;
      }

      throw error;
    }

    // ------------------------------------
    // STEP 7: FFmpeg STREAM COPY
    // ------------------------------------

    await processVideo(inputPath, outputPath);

    // ------------------------------------
    // STEP 8: DETERMINE VIDEO MIME TYPE
    // ------------------------------------

    const outputMime = originalMime.startsWith("video/")
      ? originalMime
      : MIME_BY_EXTENSION[extension];

    if (!outputMime) {
      throw new Error("Unsupported video MIME type.");
    }

    // ------------------------------------
    // STEP 9: SEND PLAYABLE VIDEO
    // ------------------------------------

    await sendVideo(
      sock,
      jid,
      outputPath,
      outputMime
    );

  } catch (error) {
    console.error("[JERUNG HD ERROR]", error);

    try {
      await sendText(
        sock,
        jid,
        "Maaf bray, video gagal diproses atau dihantar. Sila cuba lagi."
      );
    } catch (sendError) {
      console.error("[JERUNG HD] Error sending failure message:", sendError);
    }

  } finally {
    // ------------------------------------
    // STEP 10: CLEAN TEMPORARY FILES
    // ------------------------------------

    if (tempDirectory) {
      await fsp.rm(tempDirectory, {
        recursive: true,
        force: true,
      });
    }

    processingChats.delete(jid);

    console.log("[JERUNG HD] Processing finished.");
  }
}

// ========================================
// START WHATSAPP BOT
// ========================================

async function startBot() {
  try {
    // Verify FFmpeg installation
    await execFileAsync(FFMPEG_PATH, ["-version"]);

    console.log("[JERUNG HD] FFmpeg detected.");

    const { state, saveCreds } =
      await useMultiFileAuthState("auth_info");

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["JERUNG HD", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    // Save WhatsApp authentication
    sock.ev.on("creds.update", saveCreds);

    // QR and connection management
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[JERUNG HD] Scan QR code:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("--------------------------------");
        console.log(" JERUNG HD BOT CONNECTED");
        console.log("--------------------------------");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        console.log("[JERUNG HD] Connection closed.");

        if (shouldReconnect) {
          console.log("[JERUNG HD] Reconnecting...");
          setTimeout(() => startBot(), 3000);
        } else {
          console.log(
            "[JERUNG HD] Logged out. Please authenticate again."
          );
        }
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          await handleMessage(sock, msg);
        } catch (error) {
          console.error("[JERUNG HD MESSAGE ERROR]", error);
        }
      }
    });

  } catch (error) {
    console.error("[JERUNG HD STARTUP ERROR]", error);
    process.exitCode = 1;
  }
}

// ========================================
// RUN BOT
// ========================================

console.log("Starting JERUNG HD...");

startBot();
