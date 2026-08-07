// Data structures aligned with the gallery app's src/types/index.ts.

export interface PhotoImage {
  key: string;
  thumb_key: string;
}

export interface Photo {
  id: string;
  name: string;
  price: number;
  tags: string[];
  city: string;
  district: string;
  contact: string;
  link: string;
  album_id: string;
  images: PhotoImage[];
  cover_index: number;
  is_pinned: boolean;
  created_at: string;
}

// Fields extracted by the AI from the user's text message.
export interface DraftRecord {
  name: string;
  price: number;
  tags: string[];
  city: string;
  district: string;
  contact: string;
  link: string;
}

// Session state for a chat, stored in KV.
export interface BotSession {
  step: 'idle' | 'awaiting_confirm' | 'awaiting_image';
  draft: DraftRecord | null;
  photoId: string | null; // set after record saved, while awaiting images
  createdAt: number;
}

export interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  AI_MODEL?: string;
  ALLOWED_USERNAMES?: string;
}