
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
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const BOT_NAME = "JERUNG HD";
const AUTH_DIR = "auth_info";
const MAX_SIZE = 100 * 1024 * 1024;
const FFMPEG_PATH = "ffmpeg";

const WELCOME_MESSAGE =
  "SELAMAT DATANG KE JERUNG HD !\n\n" +
  "now letak video dalam bentuk document bukan dari gallery";

const GALLERY_MESSAGE =
  "salah ni bray, tekan foto/video dari document dan pilih kat situ bray";

const SIZE_REMINDER =
  "Reminder bray! Pastikan video tidak melebihi 100MB supaya tidak berlaku error.";

const activeChats = new Set();
const processingChats = new Set();

function unwrapMessage(content) {
  if (!content) return {};

  const wrappers = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
  ];

  let current = content;

  for (let i = 0; i < 10; i++) {
    let unwrapped = false;

    for (const wrapper of wrappers) {
      if (current[wrapper]?.message) {
        current = current[wrapper].message;
        unwrapped = true;
        break;
      }
    }

    if (!unwrapped) break;
  }

  return current;
}

function getText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ""
  ).trim();
}

async function sendText(sock, jid, text) {
  return sock.sendMessage(jid, { text });
}

async function downloadVideo(documentMessage, inputPath) {
  const stream = await downloadContentFromMessage(
    documentMessage,
    "document"
  );

  let totalBytes = 0;
  const chunks = [];

  for await (const chunk of stream) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_SIZE) {
      throw new Error("FILE_TOO_LARGE");
    }

    chunks.push(chunk);
  }

  if (totalBytes === 0) {
    throw new Error("EMPTY_VIDEO");
  }

  await fsp.writeFile(inputPath, Buffer.concat(chunks));

  return totalBytes;
}

// Remux every supported input into MP4.
// Video and audio streams are copied without re-encoding.
async function remuxToMp4(inputPath, outputPath) {
  console.log("[JERUNG HD] Starting MP4 remux with stream copy...");

  await execFileAsync(FFMPEG_PATH, [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-map_metadata", "0",
    "-c", "copy",
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath,
  ]);

  const stat = await fsp.stat(outputPath);

  if (!stat.size) {
    throw new Error("EMPTY_OUTPUT");
  }

  console.log("[JERUNG HD] MP4 remux completed:", stat.size, "bytes");
}

// Send as normal playable WhatsApp video, never as a document.
async function sendVideo(sock, jid, outputPath) {
  console.log("[JERUNG HD] Sending MP4 video to WhatsApp...");

  const sentMessage = await sock.sendMessage(jid, {
    video: { url: outputPath },
    mimetype: "video/mp4",
    ptv: false,
  });

  if (!sentMessage?.key?.id) {
    throw new Error("WHATSAPP_SEND_FAILED");
  }

  console.log(
    "[JERUNG HD] Video message submitted:",
    sentMessage.key.id
  );

  return sentMessage;
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  if (!jid || jid === "status@broadcast") return;

  const message = unwrapMessage(msg.message);
  const text = getText(message);

  // STEP 1: ACTIVATE BOT
  if (text.toLowerCase() === "jerung hd") {
    activeChats.add(jid);
    await sendText(sock, jid, WELCOME_MESSAGE);

    console.log("[JERUNG HD] Activated for:", jid);
    return;
  }

  if (!activeChats.has(jid)) return;

  // STEP 2: REJECT GALLERY VIDEO
  if (message.videoMessage) {
    await sendText(sock, jid, GALLERY_MESSAGE);
    return;
  }

  // STEP 3: ACCEPT VIDEO DOCUMENT
  const documentMessage = message.documentMessage;

  if (!documentMessage) return;

  const originalName = documentMessage.fileName || "video";
  const originalMime = documentMessage.mimetype || "";

  const isVideo =
    originalMime.startsWith("video/") ||
    /\.(mp4|mov|mkv|avi|webm|3gp|m4v|mpeg|mpg|wmv|flv)$/i.test(
      originalName
    );

  if (!isVideo) return;

  if (processingChats.has(jid)) {
    await sendText(
      sock,
      jid,
      "Bray, tunggu video sebelumnya selesai dulu."
    );
    return;
  }

  const declaredSize = Number(documentMessage.fileLength || 0);

  if (declaredSize > MAX_SIZE) {
    await sendText(sock, jid, SIZE_REMINDER);
    return;
  }

  processingChats.add(jid);

  let tempDirectory;

  try {
    // STEP 4: CREATE TEMPORARY FILES
    tempDirectory = await fsp.mkdtemp(
      path.join(os.tmpdir(), "jerung-hd-")
    );

    const inputExtension =
      path.extname(originalName).toLowerCase() || ".video";

    const inputPath = path.join(
      tempDirectory,
      `original${inputExtension}`
    );

    const outputPath = path.join(
      tempDirectory,
      "jerung-hd.mp4"
    );

    // STEP 5: DOWNLOAD ORIGINAL VIDEO
    console.log("[JERUNG HD] Downloading:", originalName);

    await sendText(sock, jid, "Processing video, please wait...");

    const downloadedSize = await downloadVideo(
      documentMessage,
      inputPath
    );

    console.log(
      "[JERUNG HD] Downloaded:",
      downloadedSize,
      "bytes"
    );

    // STEP 6: REMUX ALL INPUT FORMATS TO MP4
    await remuxToMp4(inputPath, outputPath);

    // STEP 7: CHECK FINAL OUTPUT SIZE
    const outputStat = await fsp.stat(outputPath);

    console.log(
      "[JERUNG HD] Original size:",
      downloadedSize,
      "bytes"
    );

    console.log(
      "[JERUNG HD] Output size:",
      outputStat.size,
      "bytes"
    );

    if (outputStat.size > MAX_SIZE) {
      throw new Error("OUTPUT_TOO_LARGE");
    }

    // STEP 8: SEND PLAYABLE WHATSAPP VIDEO
    await sendVideo(sock, jid, outputPath);

    console.log("[JERUNG HD] Video send request completed.");

  } catch (error) {
    console.error("[JERUNG HD ERROR]", error);

    let errorMessage =
      "Maaf bray, video gagal dihantar. Cuba semula.";

    if (
      error.message === "FILE_TOO_LARGE" ||
      error.message === "OUTPUT_TOO_LARGE"
    ) {
      errorMessage = SIZE_REMINDER;
    } else if (
      error.message === "EMPTY_VIDEO" ||
      error.message === "EMPTY_OUTPUT"
    ) {
      errorMessage =
        "Video tidak dapat diproses. Cuba fail video lain bray.";
    } else if (error.code === "ENOENT") {
      errorMessage =
        "FFmpeg tidak dijumpai. Sila periksa pemasangan FFmpeg.";
    } else if (error.message === "WHATSAPP_SEND_FAILED") {
      errorMessage =
        "WhatsApp gagal menerima video. Cuba semula bray.";
    }

    try {
      await sendText(sock, jid, errorMessage);
    } catch (sendError) {
      console.error(
        "[JERUNG HD] Failed to send error reply:",
        sendError
      );
    }

  } finally {
    // STEP 9: CLEAN TEMPORARY FILES
    if (tempDirectory) {
      await fsp.rm(tempDirectory, {
        recursive: true,
        force: true,
      }).catch((error) => {
        console.error("[JERUNG HD] Cleanup error:", error);
      });
    }

    processingChats.delete(jid);

    console.log("[JERUNG HD] Processing finished.");
  }
}

// START WHATSAPP BOT
async function startBot() {
  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["JERUNG HD", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[JERUNG HD] Scan QR code:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("================================");
        console.log("JERUNG HD BOT CONNECTED");
        console.log("================================");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log("[JERUNG HD] Connection closed.");

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log("[JERUNG HD] Reconnecting...");
          setTimeout(() => startBot(), 3000);
        } else {
          console.log(
            "[JERUNG HD] Logged out. Please scan a new QR code."
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
          console.error("[JERUNG HD MESSAGE ERROR]", error);
        }
      }
    });

  } catch (error) {
    console.error("[JERUNG HD STARTUP ERROR]", error);
    setTimeout(() => startBot(), 5000);
  }
}

console.log("Starting JERUNG HD...");
startBot();
