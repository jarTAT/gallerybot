// Thin wrapper around the Telegram Bot API.

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

const API_BASE = 'https://api.telegram.org';

export async function callTelegram<T = unknown>(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<T | null> {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json<{ ok: boolean; result?: T; description?: string }>();
  if (!data.ok) {
    console.error(`Telegram ${method} error:`, data.description);
    return null;
  }
  return data.result ?? null;
}

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
  replyToMessageId?: number
): Promise<unknown | null> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  return callTelegram(token, 'sendMessage', payload);
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  await callTelegram(token, 'answerCallbackQuery', payload);
}

export async function editMessageText(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await callTelegram(token, 'editMessageText', payload);
}

export interface TelegramFileInfo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export async function getFile(token: string, fileId: string): Promise<TelegramFileInfo | null> {
  return callTelegram<TelegramFileInfo>(token, 'getFile', { file_id: fileId });
}

export async function downloadFile(token: string, filePath: string): Promise<ArrayBuffer | null> {
  const url = `${API_BASE}/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error('Download file failed:', res.status);
    return null;
  }
  return res.arrayBuffer();
}
