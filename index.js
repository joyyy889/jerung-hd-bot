
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage
} from '@whiskeysockets/baileys';

import pino from 'pino';
import qrcode from 'qrcode-terminal';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

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

// Supported formats
const ALLOWED_EXTENSIONS = ['.mp4', '.mov'];

// Prevent duplicate message processing
const processedMessages = new Set();

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
    else if (mime === 'video/quicktime') format = '.mov';
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
  document,
  processingKey,
  videoDetails
) {
  const jid = message.key.remoteJid;

  let workDir;

  try {
    // Create temporary storage
    workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'jerung-hd-')
    );

    const inputPath = path.join(
      workDir,
      `original${videoDetails.extension}`
    );

    // Download original WhatsApp document
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
      throw new Error('Video download failed or empty.');
    }

    await fs.writeFile(inputPath, videoBuffer);

    console.log(
      `[${BOT_NAME}] Downloaded: ${videoBuffer.length} bytes`
    );

    // Read original file without modifying it
    const originalVideo = await fs.readFile(inputPath);

    // Edit the SAME processing message
    await sock.sendMessage(jid, {
      text: UPLOADING_MESSAGE,
      edit: processingKey
    });

    console.log(`[${BOT_NAME}] Sending original video...`);

    // Send as playable video, NOT document
    await sock.sendMessage(jid, {
      video: originalVideo,
      mimetype: videoDetails.mimetype,
      fileName: videoDetails.filename,
      caption: FINAL_CAPTION
    });

    console.log(
      `[${BOT_NAME}] Original video delivered successfully.`
    );

    console.log(
      `[${BOT_NAME}] Original size: ${originalVideo.length} bytes`
    );

  } catch (error) {
    console.error(
      `[${BOT_NAME}] Processing failed:`,
      error
    );

    await sock.sendMessage(jid, {
      text: 'Maaf, video gagal dihantar. Sila cuba sekali lagi.'
    }).catch(() => {});

  } finally {
    // Delete temporary files after delivery or failure
    if (workDir) {
      await fs.rm(workDir, {
        recursive: true,
        force: true
      }).catch(error => {
        console.error(
          `[${BOT_NAME}] Cleanup error:`,
          error
        );
      });
    }

    console.log(
      `[${BOT_NAME}] Temporary files deleted.`
    );
  }
}

async function handleMessage(sock, message) {
  if (!message.message) return;
  if (message.key.fromMe) return;

  const jid = message.key.remoteJid;

  if (!jid || jid === 'status@broadcast') return;

  const messageId = message.key.id;

  if (!messageId || processedMessages.has(messageId)) {
    return;
  }

  processedMessages.add(messageId);

  if (processedMessages.size > 5000) {
    processedMessages.clear();
  }

  const content = getMessageContent(message.message);
  const text = getText(message);

  // COMMAND: HD
  if (text.toUpperCase() === 'HD') {
    await sock.sendMessage(jid, {
      text: WELCOME_MESSAGE
    });

    return;
  }

  // REJECT GALLERY VIDEOS
  if (content.videoMessage) {
    await sock.sendMessage(jid, {
      text: GALLERY_MESSAGE
    });

    return;
  }

  // ACCEPT DOCUMENT ONLY
  const document = content.documentMessage;

  if (!document) return;

  const videoDetails = getVideoDetails(document);

  if (!videoDetails) {
    return;
  }

  console.log(
    `[${BOT_NAME}] Accepted ${videoDetails.extension} document from ${jid}`
  );

  // Send processing message
  const processingMessage = await sock.sendMessage(jid, {
    text: PROCESSING_MESSAGE
  });

  // Download and send original video
  await processVideo(
    sock,
    message,
    document,
    processingMessage.key,
    videoDetails
  );
}

async function startBot() {
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

      console.log(
        '[JERUNG HD] Connection closed:',
        statusCode
      );

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('[JERUNG HD] Reconnecting...');

        setTimeout(() => {
          startBot().catch(console.error);
        }, 3000);
      } else {
        console.log(
          '[JERUNG HD] Logged out. Please scan QR again.'
        );
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        await handleMessage(sock, message);
      } catch (error) {
        console.error(
          '[JERUNG HD] Message handler error:',
          error
        );
      }
    }
  });
}

console.log('Starting JERUNG HD...');

startBot().catch(console.error);
