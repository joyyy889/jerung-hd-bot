
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage
} from '@whiskeysockets/baileys';

import pino from 'pino';
import qrcode from 'qrcode-terminal';

import fs from 'fs/promises';
import path from 'path';

const logger = pino({ level: 'silent' });

const BOT_NAME = 'JERUNG HD';

const WELCOME_MESSAGE =
  'welkem tu jerung HD , sila letak video dalam bentuk document';

const GALLERY_MESSAGE =
  'Pastikan video dalam bentuk document bukan dari gallery';

const PROCESSING_MESSAGE =
  'processing , please wait';

const UPLOADING_MESSAGE =
  'video sedang otww';

const FINAL_CAPTION =
  'selesai , foward terus ke status utk menjaga kualiti penuh';

const TEMP_DIR = path.join(process.cwd(), 'temp_videos');

const ALLOWED_EXTENSIONS = ['.mp4', '.mov'];

const processedMessages = new Set();

let reconnecting = false;

async function initializeTempFolder() {
  await fs.mkdir(TEMP_DIR, { recursive: true });
}

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
const media = sentMessage.message?.videoMessage;

console.log("[JERUNG HD] VIDEO DIAGNOSTIC:", {

  hasVideoMessage: Boolean(media),

  hasMediaKey: Boolean(media?.mediaKey),

  hasDirectPath: Boolean(media?.directPath),

  hasFileSha256: Boolean(media?.fileSha256),

  hasFileEncSha256: Boolean(media?.fileEncSha256),

  mimetype: media?.mimetype,

  seconds: media?.seconds,

  fileLength: media?.fileLength?.toString(),

  hasThumbnail: Boolean(media?.jpegThumbnail)

});

if (!sentMessage?.key?.id) {

  throw new Error('WhatsApp did not return message ID.');

}
function getText(message) {
  const content = getMessageContent(message.message);

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    ''
  ).trim();
}

function getVideoDetails(document) {
  const filename = document.fileName || '';
  const extension = path.extname(filename).toLowerCase();
  const mime = (document.mimetype || '').toLowerCase();

  let format = extension;

  if (!format) {
    if (mime === 'video/mp4') format = '.mp4';
    if (mime === 'video/quicktime') format = '.mov';
  }

  if (!ALLOWED_EXTENSIONS.includes(format)) {
    return null;
  }

  return {
    extension: format,
    mimetype: format === '.mov'
      ? 'video/quicktime'
      : 'video/mp4',
    filename: filename || `jerung-hd${format}`
  };
}

async function processVideo(
  sock,
  message,
  processingKey,
  videoDetails
) {
  const jid = message.key.remoteJid;

  let inputPath;

  try {
    const uniqueName =
      `${Date.now()}-${message.key.id.replace(/[^a-zA-Z0-9]/g, '')}`;

    inputPath = path.join(
      TEMP_DIR,
      `${uniqueName}${videoDetails.extension}`
    );

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

    await fs.writeFile(inputPath, videoBuffer);

    const fileInfo = await fs.stat(inputPath);

    if (fileInfo.size !== videoBuffer.length) {
      throw new Error('File size verification failed.');
    }

    console.log(`[${BOT_NAME}] Original size: ${fileInfo.size} bytes`);
    console.log(`[${BOT_NAME}] Temporary file retained: ${inputPath}`);

    // Edit existing processing message
    await sock.sendMessage(jid, {
      text: UPLOADING_MESSAGE,
      edit: processingKey
    });

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
    console.log(`[${BOT_NAME}] Temporary file is NOT deleted.`);
    console.log(`[${BOT_NAME}] Original size: ${fileInfo.size} bytes`);

  } catch (error) {
    console.error(`[${BOT_NAME}] Video processing error:`, error);

    await sock.sendMessage(jid, {
      text: 'Maaf, video gagal dihantar. Sila cuba sekali lagi.'
    }).catch(() => {});

    console.log(
      `[${BOT_NAME}] Temporary file retained for troubleshooting:`,
      inputPath || 'File not created'
    );
  }
}

async function handleMessage(sock, message) {
  if (!message.message || message.key.fromMe) return;

  const jid = message.key.remoteJid;

  if (!jid || jid === 'status@broadcast') return;

  const messageId = message.key.id;

  if (!messageId || processedMessages.has(messageId)) return;

  processedMessages.add(messageId);

  if (processedMessages.size > 5000) {
    processedMessages.clear();
  }

  const content = getMessageContent(message.message);
  const text = getText(message);

  // HD command
  if (text.toUpperCase() === 'HD') {
    await sock.sendMessage(jid, {
      text: WELCOME_MESSAGE
    });
    return;
  }

  // Reject gallery videos
  if (content.videoMessage) {
    await sock.sendMessage(jid, {
      text: GALLERY_MESSAGE
    });
    return;
  }

  // Accept MP4/MOV documents only
  const document = content.documentMessage;

  if (!document) return;

  const videoDetails = getVideoDetails(document);

  if (!videoDetails) return;

  console.log(
    `[${BOT_NAME}] Accepted ${videoDetails.extension} document.`
  );

  const processingMessage = await sock.sendMessage(jid, {
    text: PROCESSING_MESSAGE
  });

  await processVideo(
    sock,
    message,
    processingMessage.key,
    videoDetails
  );
}

async function startBot() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['JERUNG HD', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('Scan QR code untuk sambungkan WhatsApp:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        console.log('JERUNG HD BERJAYA DISAMBUNG!');
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log('[JERUNG HD] Connection closed:', statusCode);

        reconnecting = false;

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            startBot().catch(console.error);
          }, 3000);
        } else {
          console.log('[JERUNG HD] Logged out. Scan QR again.');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          await handleMessage(sock, message);
        } catch (error) {
          console.error('[JERUNG HD] Handler error:', error);
        }
      }
    });

    reconnecting = false;

  } catch (error) {
    reconnecting = false;
    console.error('[JERUNG HD] Startup error:', error);

    setTimeout(() => {
      startBot().catch(console.error);
    }, 5000);
  }
}

async function main() {
  await initializeTempFolder();

  console.log('Starting JERUNG HD...');
  console.log('Temporary files will be retained.');

  await startBot();
}

main().catch(console.error);
