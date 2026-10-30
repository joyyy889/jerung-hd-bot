
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

import pino from 'pino';
import qrcode from 'qrcode-terminal';

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

// ========================================
// JERUNG HD CONFIGURATION
// ========================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_NAME = 'JERUNG HD';
const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');
const TEMP_FOLDER = path.join(__dirname, 'temp_videos');

const WELCOME_MESSAGE =
  'welkem tu jerung HD , sila letak video dalam bentuk document';

const GALLERY_MESSAGE =
  'Pastikan video dalam bentuk document bukan dari gallery';

const PROCESSING_MESSAGE = 'processing , please wait';
const UPLOADING_MESSAGE = 'video sedang otww';

const FINAL_CAPTION =
  'selesai , foward terus ke status utk menjaga kualiti penuh';

const ERROR_MESSAGE =
  'Maaf, video gagal dihantar. Sila cuba sekali lagi.';

const logger = pino({ level: 'silent' });

const processedMessages = new Set();
let reconnecting = false;

// ========================================
// HELPERS
// ========================================

async function prepareFolders() {
  await fs.mkdir(TEMP_FOLDER, { recursive: true });
}

function unwrapMessage(message) {
  let content = message;

  while (content) {
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
      continue;
    }

    if (content.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
      continue;
    }

    if (content.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
      continue;
    }

    if (content.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
      continue;
    }

    break;
  }

  return content;
}

function getText(content) {
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    ''
  ).trim();
}

function getVideoDetails(document) {
  const filename = document.fileName || '';
  const extension = path.extname(filename).toLowerCase();

  if (extension === '.mp4') {
    return {
      filename,
      mimetype: 'video/mp4',
      extension: '.mp4'
    };
  }

  if (extension === '.mov') {
    return {
      filename,
      mimetype: 'video/quicktime',
      extension: '.mov'
    };
  }

  return null;
}

async function editMessage(sock, jid, key, text) {
  if (!key) return;

  try {
    await sock.sendMessage(jid, {
      text,
      edit: key
    });
  } catch (error) {
    console.error(`[${BOT_NAME}] Failed to edit message:`, error.message);
  }
}

// ========================================
// VIDEO DIAGNOSTICS
// ========================================

function logVideoDiagnostics(sentMessage) {
  const media = sentMessage?.message?.videoMessage;

  console.log(`[${BOT_NAME}] VIDEO DIAGNOSTIC:`, {
    hasVideoMessage: Boolean(media),
    hasMediaKey: Boolean(media?.mediaKey),
    hasDirectPath: Boolean(media?.directPath),
    hasFileSha256: Boolean(media?.fileSha256),
    hasFileEncSha256: Boolean(media?.fileEncSha256),
    mimetype: media?.mimetype || null,
    seconds: media?.seconds ?? null,
    fileLength: media?.fileLength?.toString() || null,
    hasThumbnail: Boolean(media?.jpegThumbnail)
  });
}

// ========================================
// PROCESS VIDEO DOCUMENT
// ========================================

async function processVideo(sock, message, document) {
  const jid = message.key.remoteJid;
  const messageId = message.key.id;

  let inputPath = null;
  let processingMessage = null;

  try {
    const videoDetails = getVideoDetails(document);

    if (!videoDetails) {
      return;
    }

    console.log(`[${BOT_NAME}] Accepted ${videoDetails.extension} document.`);

    // Send initial processing message
    processingMessage = await sock.sendMessage(jid, {
      text: PROCESSING_MESSAGE
    });

    // Download original document
    console.log(`[${BOT_NAME}] Downloading original video...`);

    const videoBuffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger,
        reuploadRequest: sock.updateMediaMessage
      }
    );

    if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) {
      throw new Error('Downloaded video is empty.');
    }

    // Create unique temporary file
    const safeFilename = path.basename(videoDetails.filename)
      .replace(/[^a-zA-Z0-9._-]/g, '_');

    inputPath = path.join(
      TEMP_FOLDER,
      `${randomUUID()}_${safeFilename}`
    );

    await fs.writeFile(inputPath, videoBuffer);

    // Verify original file size
    const fileInfo = await fs.stat(inputPath);

    if (fileInfo.size !== videoBuffer.length) {
      throw new Error('File size verification failed.');
    }

    console.log(`[${BOT_NAME}] Original size: ${fileInfo.size} bytes`);
    console.log(`[${BOT_NAME}] Temporary file saved.`);

    // Edit existing processing message
    await editMessage(
      sock,
      jid,
      processingMessage?.key,
      UPLOADING_MESSAGE
    );

    console.log(`[${BOT_NAME}] Uploading original video...`);

    // Send original file without encoding or conversion
    const sentMessage = await sock.sendMessage(jid, {
      video: {
        url: inputPath
      },
      mimetype: videoDetails.mimetype,
      fileName: videoDetails.filename,
      caption: FINAL_CAPTION,
      ptv: false
    });

    if (!sentMessage?.key?.id) {
      throw new Error('WhatsApp did not return message ID.');
    }

    console.log(`[${BOT_NAME}] Video message accepted.`);
    console.log(`[${BOT_NAME}] Message ID: ${sentMessage.key.id}`);

    // Inspect outgoing WhatsApp video metadata
    logVideoDiagnostics(sentMessage);

    console.log(`[${BOT_NAME}] Original size: ${fileInfo.size} bytes`);

  } catch (error) {
    console.error(`[${BOT_NAME}] Video processing error:`, error);

    await editMessage(
      sock,
      jid,
      processingMessage?.key,
      ERROR_MESSAGE
    );

  } finally {
    // Delete temporary file after upload attempt
    if (inputPath) {
      try {
        await fs.unlink(inputPath);
        console.log(`[${BOT_NAME}] Temporary file deleted.`);
      } catch (error) {
        console.error(
          `[${BOT_NAME}] Temporary file cleanup error:`,
          error.message
        );
      }
    }

    processedMessages.delete(messageId);
  }
}

// ========================================
// HANDLE INCOMING MESSAGES
// ========================================

async function handleMessage(sock, message) {
  if (!message.message || message.key.fromMe) return;

  const jid = message.key.remoteJid;

  if (!jid || jid === 'status@broadcast') return;

  const messageId = message.key.id;

  if (!messageId || processedMessages.has(messageId)) return;

  const content = unwrapMessage(message.message);

  if (!content) return;

  // Handle HD text command
  const text = getText(content);

  if (text.toUpperCase() === 'HD') {
    await sock.sendMessage(jid, {
      text: WELCOME_MESSAGE
    });
    return;
  }

  // Handle normal Gallery video
  if (content.videoMessage) {
    await sock.sendMessage(jid, {
      text: GALLERY_MESSAGE
    });
    return;
  }

  // Only accept video sent as WhatsApp Document
  const document = content.documentMessage;

  if (!document) return;

  const videoDetails = getVideoDetails(document);

  if (!videoDetails) return;

  processedMessages.add(messageId);

  await processVideo(sock, message, document);
}

// ========================================
// WHATSAPP CONNECTION
// ========================================

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[${BOT_NAME}] Scan this QR code with WhatsApp:`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnecting = false;
      console.log(`[${BOT_NAME}] Berjaya disambungkan!`);
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut;

      console.log(`[${BOT_NAME}] Connection closed.`);

      if (shouldReconnect && !reconnecting) {
        reconnecting = true;
        console.log(`[${BOT_NAME}] Reconnecting...`);

        setTimeout(() => {
          startBot().catch((error) => {
            console.error(`[${BOT_NAME}] Reconnection error:`, error);
            reconnecting = false;
          });
        }, 3000);
      } else if (!shouldReconnect) {
        console.log(`[${BOT_NAME}] Logged out. Scan a new QR code.`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        await handleMessage(sock, message);
      } catch (error) {
        console.error(`[${BOT_NAME}] Message handler error:`, error);
      }
    }
  });
}

// ========================================
// START JERUNG HD
// ========================================

async function main() {
  await prepareFolders();

  console.log('================================');
  console.log('       JERUNG HD BOT');
  console.log('================================');

  await startBot();
}

main().catch((error) => {
  console.error(`[${BOT_NAME}] Startup error:`, error);
  process.exit(1);
});
