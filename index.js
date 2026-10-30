
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

const MIME_BY_EXTENSION = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".3gp": "video/3gpp",
  ".m4v": "video/x-m4v",
};

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

// MOV -> MP4 container only.
// No video/audio re-encoding.
async function convertMovContainer(inputPath, outputPath) {
  console.log("[JERUNG HD] Remuxing MOV to MP4 without re-encoding...");

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

  console.log("[JERUNG HD] MOV remux completed:", stat.size, "bytes");
}

// Send as a normal playable WhatsApp video message.
async function sendVideo(sock, jid, outputPath) {
  console.log("[JERUNG HD] Sending playable WhatsApp video...");

  const sentMessage = await sock.sendMessage(jid, {
    video: { url: outputPath },
    mimetype: "video/mp4",
    ptv: false,
  });

  if (!sentMessage?.key?.id) {
    throw new Error("WHATSAPP_SEND_FAILED");
  }

  console.log(
    "[JERUNG HD] WhatsApp accepted video message:",
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

  // STEP 3: ACCEPT DOCUMENT VIDEO
  const documentMessage = message.documentMessage;

  if (!documentMessage) return;

  const originalName = documentMessage.fileName || "video";
  const extension = path.extname(originalName).toLowerCase();
  const originalMime = documentMessage.mimetype || "";

  const isVideo =
    originalMime.startsWith("video/") ||
    Object.hasOwn(MIME_BY_EXTENSION, extension);

  if (!isVideo) return;

  if (processingChats.has(jid)) {
    await sendText(sock, jid, "Bray, tunggu video sebelumnya selesai dulu.");
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

    const safeExtension = extension || ".mp4";

    const inputPath = path.join(
      tempDirectory,
      `original${safeExtension}`
    );

    const isMov = safeExtension === ".mov";

    const outputPath = isMov
      ? path.join(tempDirectory, "jerung-hd.mp4")
      : inputPath;

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

    // STEP 6: HANDLE MOV ONLY
    if (isMov) {
      await convertMovContainer(inputPath, outputPath);
    }

    // STEP 7: CHECK OUTPUT
    const outputStat = await fsp.stat(outputPath);

    if (outputStat.size > MAX_SIZE) {
      throw new Error("OUTPUT_TOO_LARGE");
    }

    console.log(
      "[JERUNG HD] Final output:",
      outputStat.size,
      "bytes"
    );

    // STEP 8: SEND PLAYABLE VIDEO
    await sendVideo(sock, jid, outputPath);

    console.log("[JERUNG HD] Video send request completed.");

  } catch (error) {
    console.error("[JERUNG HD ERROR]", error);

    let errorMessage =
      "Maaf bray, video gagal dihantar. Cuba semula.";

    if (error.message === "FILE_TOO_LARGE") {
      errorMessage = SIZE_REMINDER;
    } else if (error.message === "OUTPUT_TOO_LARGE") {
      errorMessage = SIZE_REMINDER;
    } else if (
      error.message === "EMPTY_VIDEO" ||
      error.message === "EMPTY_OUTPUT"
    ) {
      errorMessage = "Video tidak dapat diproses. Cuba fail video lain bray.";
    } else if (error.code === "ENOENT") {
      errorMessage = "FFmpeg tidak dijumpai. Sila periksa pemasangan FFmpeg.";
    }

    try {
      await sendText(sock, jid, errorMessage);
    } catch (sendError) {
      console.error("[JERUNG HD] Failed to send error reply:", sendError);
    }

  } finally {
    // STEP 9: CLEAN UP TEMPORARY FILES
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
