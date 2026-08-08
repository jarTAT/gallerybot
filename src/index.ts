import { Env, DraftRecord, Photo } from './types';
import {
  sendMessage,
  answerCallbackQuery,
  editMessageText,
  getFile,
  downloadFile,
  InlineKeyboardMarkup,
} from './telegram';
import { extractRecord, recognizeImageText } from './ai';
import { createPhotoRecord, addImageToPhoto, getPhoto, findExistingByDraft } from './store';
import { getSession, setSession, clearSession } from './session';

const MAX_IMAGES_PER_RECORD = 10;
const AI_TIMEOUT_MS = 40000;

// Message template sent when AI fails to parse, so the user can copy, fill in,
// and resend a well-formed submission.
const MESSAGE_TEMPLATE = `我没有成功识别您发送的内容。请复制下面的模板，替换成您自己的信息后重新发送：

姓名：（姓名或昵称）
联系方式：（电话 / 微信 / Telegram）
标签：（标签，用空格或逗号分隔）
价格：（数字，如 800）
城市：（城市）
区域：（区/街道）
链接：（作品链接，如 https://...）

示例：
姓名：小美
联系方式：@xiaomei
标签：人像 街拍 逆光
价格：500
城市：深圳
区域：南山
链接：https://example.com`;


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    try {
      const body = (await request.json()) as TelegramUpdate;
      const chatId = body?.message?.chat?.id ?? body?.callback_query?.message?.chat?.id;

      if (chatId === undefined) {
        return new Response('OK', { status: 200 });
      }

      if (!env.TELEGRAM_BOT_TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN is not configured');
        return new Response('MISCONFIGURED', { status: 500 });
      }

      if (!(await isAllowed(env, chatId))) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, '这个机器人仅限白名单用户使用。');
        return new Response('OK', { status: 200 });
      }

      if (body.callback_query) {
        await handleCallback(env, body.callback_query);
      } else if (body.message) {
        await handleMessage(env, body.message);
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Webhook handler error:', error);
      return new Response('ERROR', { status: 500 });
    }
  },
};

async function isAllowed(env: Env, chatId: number | string): Promise<boolean> {
  const allowList = (env.ALLOWED_USERNAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowList.length === 0 || allowList.includes(String(chatId));
}

async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const token = env.TELEGRAM_BOT_TOKEN;
  const session = await getSession(env, chatId);
  const text = (message.text || message.caption || '').trim();
  const photo = message.photo;

  // Commands
  if (text === '/start' || text === '/cancel') {
    await clearSession(env, chatId);
    await sendMessage(
      token,
      chatId,
      '你好！发送一段文字（描述摄影作品的信息），我会帮你整理成记录并请求你确认。之后发送图片即可关联保存。\n发送 /cancel 可随时取消当前操作。'
    );
    return;
  }

  if (text === '/done') {
    if (session?.step === 'awaiting_image') {
      await clearSession(env, chatId);
      await sendMessage(token, chatId, '已完成！图片已保存并关联到记录。可开始新的提交。');
    } else {
      await sendMessage(token, chatId, '当前没有待处理的记录。');
    }
    return;
  }

  // --- Step: awaiting image ---
  if (session?.step === 'awaiting_image' && session.photoId) {
    if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      const info = await getFile(token, largest.file_id);
      if (!info?.file_path) {
        await sendMessage(token, chatId, '无法获取图片文件，请重试。');
        return;
      }
      const buffer = await downloadFile(token, info.file_path);
      if (!buffer) {
        await sendMessage(token, chatId, '图片下载失败，请重试。');
        return;
      }

      const photo = await getPhoto(env, session.photoId);
      const current = photo?.images?.length ?? 0;
      if (current >= MAX_IMAGES_PER_RECORD) {
        await clearSession(env, chatId);
        await sendMessage(token, chatId, `该作品图片已达上限(${MAX_IMAGES_PER_RECORD}张)，已自动完成。可开始新的提交。`);
        return;
      }

      const contentType = detectContentType(info.file_path, largest.mime_type);
      await addImageToPhoto(env, session.photoId, buffer, contentType);
      await sendMessage(
        token,
        chatId,
        `已保存图片 (${current + 1})。可继续发送图片；回复 /done 完成。`
      );
      return;
    }

    // text was sent while awaiting image, ignore unless command
    await sendMessage(token, chatId, '正在等待图片。发送图片即可，或回复 /done 完成。');
    return;
  }

  // --- Step: awaiting confirm ---
  if (session?.step === 'awaiting_confirm' && session.draft) {
    await sendMessage(
      token,
      chatId,
      '前一次提交仍待处理，请点击上方按钮确认/修改/取消，或发送 /cancel。'
    );
    return;
  }

  // --- Step: awaiting duplicate decision ---
  if (session?.step === 'awaiting_dup' && session.draft) {
    await sendMessage(
      token,
      chatId,
      '检测到可能重复的记录，请点击上方按钮选择「⚠️ 仍然保存」或「❌ 取消」。'
    );
    return;
  }

  // --- Idle ---
  // If the message carries a photo, recognize the text inside it via vision AI,
  // reply with that text, and end this round (no confirmation / no saving).
  if (photo && photo.length > 0) {
    await recognizeImageAndReply(env, chatId, photo);
    return;
  }

  // Otherwise extract a draft from the text and request confirmation.
  await handleNewSubmission(env, chatId, text);
}

async function recognizeImageAndReply(
  env: Env,
  chatId: number | string,
  photo: TelegramPhotoSize[]
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  await sendMessage(token, chatId, '正在识别图片中的文字，请稍候...');

  try {
    const largest = photo[photo.length - 1];
    const info = await getFile(token, largest.file_id);
    if (!info?.file_path) {
      await sendMessage(token, chatId, '无法获取图片文件，请重试。');
      return;
    }
    const buffer = await downloadFile(token, info.file_path);
    if (!buffer) {
      await sendMessage(token, chatId, '图片下载失败，请重试。');
      return;
    }
    const recognized = await withTimeout(
      recognizeImageText(env.AI, env.AI_VISION_MODEL, buffer),
      AI_TIMEOUT_MS,
      'Vision AI timed out'
    );
    if (!recognized) {
      await sendMessage(token, chatId, '未能识别出图片中的文字。');
      return;
    }
    await sendMessage(token, chatId, recognized);
  } catch (error) {
    console.error(
      'OCR failed:',
      error instanceof Error ? error.message : String(error)
    );
    await sendMessage(token, chatId, MESSAGE_TEMPLATE);
  }
}

async function handleNewSubmission(
  env: Env,
  chatId: number | string,
  text: string
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!text.trim()) {
    await sendMessage(token, chatId, '请发送一些文字描述，让我整理成记录。');
    return;
  }

  await sendMessage(token, chatId, '正在整理您的信息，请稍候...');

  let draft: DraftRecord;
  try {
    draft = await withTimeout(
      extractRecord(env.AI, env.AI_MODEL, text),
      AI_TIMEOUT_MS,
      'Text AI timed out'
    );
  } catch (error) {
    console.error(
      'AI extraction failed:',
      error instanceof Error ? error.message : String(error)
    );
    await sendMessage(token, chatId, MESSAGE_TEMPLATE);
    return;
  }

  await setSession(env, chatId, {
    step: 'awaiting_confirm',
    draft,
    photoId: null,
    createdAt: Date.now(),
  });

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '✅ 确认', callback_data: 'confirm' },
        { text: '✏️ 修改', callback_data: 'edit' },
        { text: '❌ 取消', callback_data: 'cancel' },
      ],
    ],
  };

  await sendMessage(token, chatId, formatDraft(draft), keyboard);
}

async function handleCallback(env: Env, cb: TelegramCallbackQuery): Promise<void> {
  const chatId = cb.message!.chat.id;
  const messageId = cb.message!.message_id;
  const token = env.TELEGRAM_BOT_TOKEN;
  const session = await getSession(env, chatId);

  if (cb.data === 'done') {
    await answerCallbackQuery(token, cb.id);
    await clearSession(env, chatId);
    await editMessageText(token, chatId, messageId, '已完成，记录与图片均已保存。');
    return;
  }

  if (!session?.draft) {
    await answerCallbackQuery(token, cb.id, '会话已过期，请重新开始。');
    return;
  }

  switch (cb.data) {
    case 'confirm': {
      await answerCallbackQuery(token, cb.id, '正在检查重复记录...');
      const duplicates = await findExistingByDraft(env, session.draft);
      if (duplicates.length > 0) {
        await setSession(env, chatId, {
          step: 'awaiting_dup',
          draft: session.draft,
          photoId: null,
          createdAt: Date.now(),
        });
        await editMessageText(
          token,
          chatId,
          messageId,
          formatDuplicateWarning(session.draft, duplicates),
          {
            inline_keyboard: [
              [{ text: '⚠️ 仍然保存', callback_data: 'dup_confirm' }],
              [{ text: '❌ 取消', callback_data: 'dup_cancel' }],
            ],
          }
        );
        return;
      }
      await saveConfirmedRecord(env, chatId, messageId, session.draft);
      break;
    }
    case 'dup_confirm': {
      await answerCallbackQuery(token, cb.id, '已确认，正在保存...');
      await saveConfirmedRecord(env, chatId, messageId, session.draft);
      break;
    }
    case 'dup_cancel': {
      await answerCallbackQuery(token, cb.id, '已取消。');
      await clearSession(env, chatId);
      await editMessageText(token, chatId, messageId, '已取消本次操作。');
      break;
    }
    case 'edit': {
      await answerCallbackQuery(token, cb.id);
      await clearSession(env, chatId);
      await editMessageText(token, chatId, messageId, '请发送修改后的完整文字描述，将重新整理。');
      break;
    }
    case 'cancel': {
      await answerCallbackQuery(token, cb.id, '已取消。');
      await clearSession(env, chatId);
      await editMessageText(token, chatId, messageId, '已取消本次操作。');
      break;
    }
    default:
      await answerCallbackQuery(token, cb.id, '未知操作。');
  }
}

function formatDraft(draft: DraftRecord): string {
  return [
    '已整理以下信息，请确认：',
    '',
    `📛 名称：${draft.name || '—'}`,
    `💰 价格：${draft.price ? '¥' + draft.price : '—'}`,
    `🏷️ 标签：${draft.tags.length ? draft.tags.join('、') : '—'}`,
    `🏙️ 城市：${draft.city || '—'}    区域：${draft.district || '—'}`,
    `📞 联系方式：${draft.contact || '—'}`,
    `🔗 链接：${draft.link || '—'}`,
  ].join('\n');
}

function formatDuplicateWarning(draft: DraftRecord, duplicates: Photo[]): string {
  const lines: string[] = [
    '⚠️ 检测到可能重复的记录：',
    '',
    `📋 本次信息：${draft.name || '—'}（${draft.contact || '—'}）`,
    '',
    '以下已有记录的「名称」或「联系方式」与本次相同：',
    '',
  ];
  duplicates.forEach((p, i) => {
    const price = typeof p.price === 'number' && p.price > 0 ? '¥' + p.price : '—';
    lines.push(
      `${i + 1}. ${p.name || '—'}｜${p.contact || '—'}｜${p.city || '—'} ${p.district || '—'}｜${price}`
    );
  });
  lines.push('', '如确认仍要保存，请选择「⚠️ 仍然保存」；否则点击「❌ 取消」。');
  return lines.join('\n');
}

async function saveConfirmedRecord(
  env: Env,
  chatId: number | string,
  messageId: number,
  draft: DraftRecord
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const photo = await createPhotoRecord(env, draft);
  await setSession(env, chatId, {
    step: 'awaiting_image',
    draft,
    photoId: photo.id,
    createdAt: Date.now(),
  });
  await editMessageText(
    token,
    chatId,
    messageId,
    `✅ 已保存记录：${photo.name}\n现在请发送该作品的图片（一张或多张）。`
  );
  await sendMessage(
    token,
    chatId,
    '请发送图片，发完回复 /done 或点击下方按钮完成。',
    {
      inline_keyboard: [[{ text: '✅ 已完成', callback_data: 'done' }]],
    }
  );
}

function detectContentType(path: string, mimeType?: string): string {
  if (mimeType) return mimeType;
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// ---- Telegram webhook payload type declarations ----
interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width?: number;
  height?: number;
  mime_type?: string;
}

interface TelegramMessage {
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}