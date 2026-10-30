
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
import { spawn } from 'child_process';

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

const ALLOWED_EXTENSIONS = ['.mp4', '.mov'];

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

function getDocumentExtension(document) {
  const filename = document.fileName || '';
  const extension = path.extname(filename).toLowerCase();

  if (ALLOWED_EXTENSIONS.includes(extension)) {
    return extension;
  }

  const mime = (document.mimetype || '').toLowerCase();

  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/mp4') return '.mp4';

  return '';
}

function runFFmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,

      '-map', '0:v:0',
      '-map', '0:a?',

      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',

      '-c:a', 'aac',
      '-b:a', '192k',

      '-movflags', '+faststart',
      '-max_muxing_queue_size', '1024',

      outputPath
    ];

    const ffmpeg = spawn('ffmpeg', args);

    let errorOutput = '';

    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();

      if (errorOutput.length > 12000) {
        errorOutput = errorOutput.slice(-12000);
      }
    });

    ffmpeg.on('error', (error) => {
      reject(new Error(`FFmpeg error: ${error.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`FFmpeg exited with code ${code}: ${errorOutput}`)
        );
      }
    });
  });
}

async function processVideo(sock, message, document) {
  const jid = message.key.remoteJid;

  let workDir;

  try {
    // Create temporary working directory
    workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'jerung-hd-')
    );

    const extension = getDocumentExtension(document);

    const inputPath = path.join(
      workDir,
      `original${extension}`
    );

    const outputPath = path.join(
      workDir,
      'jerung-hd-output.mp4'
    );

    // Download original document
    const videoBuffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger,
        reuploadRequest: sock.updateMediaMessage
      }
    );

    await fs.writeFile(inputPath, videoBuffer);

    console.log(`[${BOT_NAME}] Video downloaded: ${jid}`);

    // Encode video using FFmpeg
    await runFFmpeg(inputPath, outputPath);

    const outputBuffer = await fs.readFile(outputPath);

    if (!outputBuffer.length) {
      throw new Error('Encoded video is empty.');
    }

    console.log(`[${BOT_NAME}] Encoding completed: ${jid}`);

    // Edit the original processing message
    try {
      await sock.sendMessage(jid, {
        text: UPLOADING_MESSAGE,
        edit: message.processingKey
      });
    } catch (error) {
      console.error(
        '[JERUNG HD] Failed to edit processing message:',
        error.message
      );

      throw new Error('Unable to update upload status.');
    }

    // Send the encoded video as a normal playable video
    await sock.sendMessage(jid, {
      video: outputBuffer,
      mimetype: 'video/mp4',
      fileName: 'jerung-hd.mp4',
      caption: FINAL_CAPTION
    });

    console.log(`[${BOT_NAME}] Video delivered: ${jid}`);

  } catch (error) {
    console.error(`[${BOT_NAME}] Processing failed:`, error);

    await sock.sendMessage(jid, {
      text: 'Maaf, video gagal diproses. Sila cuba sekali lagi.'
    }).catch(() => {});

  } finally {
    // Delete all temporary video files
    if (workDir) {
      await fs.rm(workDir, {
        recursive: true,
        force: true
      }).catch((error) => {
        console.error('[JERUNG HD] Cleanup failed:', error);
      });
    }

    console.log(`[${BOT_NAME}] Temporary files cleaned.`);
  }
}

async function handleMessage(sock, message) {
  if (!message.message) return;
  if (message.key.fromMe) return;

  const jid = message.key.remoteJid;

  if (!jid || jid === 'status@broadcast') return;

  const messageId = message.key.id;

  if (processedMessages.has(messageId)) return;

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

  // ACCEPT DOCUMENT VIDEOS ONLY
  const document = content.documentMessage;

  if (!document) return;

  const extension = getDocumentExtension(document);

  const mime = (document.mimetype || '').toLowerCase();

  const isSupportedVideo =
    ALLOWED_EXTENSIONS.includes(extension) &&
    (
      mime.startsWith('video/') ||
      !mime
    );

  if (!isSupportedVideo) {
    return;
  }

  console.log(`[${BOT_NAME}] Document received: ${jid}`);

  // Send initial processing message
  const processingMessage = await sock.sendMessage(jid, {
    text: PROCESSING_MESSAGE
  });

  // Store key for editing the same message later
  message.processingKey = processingMessage.key;

  await processVideo(sock, message, document);
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

  sock.ev.on('connection.update', (update) => {
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

      console.log('WhatsApp connection closed:', statusCode);

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Reconnecting JERUNG HD...');

        setTimeout(() => {
          startBot();
        }, 3000);
      } else {
        console.log('Session logged out. Scan QR again.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        await handleMessage(sock, message);
      } catch (error) {
        console.error('[JERUNG HD] Message error:', error);
      }
    }
  });
}

console.log('Starting JERUNG HD...');
startBot().catch(console.error);
