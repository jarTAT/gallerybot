import { Env, BotSession } from './types';

const SESSION_KEY = (chatId: number | string) => `bot:session:${chatId}`;

export async function getSession(env: Env, chatId: number | string): Promise<BotSession | null> {
  const raw = await env.KV.get(SESSION_KEY(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BotSession;
  } catch {
    return null;
  }
}

export async function setSession(env: Env, chatId: number | string, session: BotSession): Promise<void> {
  // 24h TTL so stale sessions expire naturally
  await env.KV.put(SESSION_KEY(chatId), JSON.stringify(session), { expirationTtl: 86400 });
}

export async function clearSession(env: Env, chatId: number | string): Promise<void> {
  await env.KV.delete(SESSION_KEY(chatId));
}