import { Env, DraftRecord, Photo } from './types';
import {
  sendMessage,
  answerCallbackQuery,
  editMessageText,
  getFile,
  downloadFile,
  InlineKeyboardMarkup,
} from './telegram';
import { extractRecord, extractRecordFromImage } from './ai';
import { createPhotoRecord, addImageToPhoto, getPhoto } from './store';
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

  // --- Idle ---
  // New submission. If the message has a photo, recognize its content via vision;
  // otherwise extract from the text.
  await handleNewSubmission(env, chatId, text || '', message.photo);
}

async function handleNewSubmission(
  env: Env,
  chatId: number | string,
  text: string,
  photo: TelegramPhotoSize[] | undefined
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!text.trim() && !(photo && photo.length > 0)) {
    await sendMessage(token, chatId, '请发送一些文字描述或一张图片，让我整理成记录。');
    return;
  }

  await sendMessage(token, chatId, '正在整理您的信息，请稍候...');

  let draft: DraftRecord;
  try {
    if (photo && photo.length > 0) {
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
      draft = await withTimeout(
        extractRecordFromImage(env.AI, env.AI_VISION_MODEL, buffer, text),
        AI_TIMEOUT_MS,
        'Vision AI timed out'
      );
    } else {
      draft = await withTimeout(
        extractRecord(env.AI, env.AI_MODEL, text),
        AI_TIMEOUT_MS,
        'Text AI timed out'
      );
    }
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
      await answerCallbackQuery(token, cb.id, '已确认，正在保存...');
      const photo = await createPhotoRecord(env, session.draft);
      await setSession(env, chatId, {
        step: 'awaiting_image',
        draft: session.draft,
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