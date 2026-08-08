import { Env, Photo, PhotoImage, DraftRecord } from './types';

// Key formats must match the gallery app (src/lib/kv.ts and src/lib/r2.ts)
const KEYS = {
  photo: (id: string) => `photo:${id}`,
  photoIndex: 'index:photos',
};

const R2_PHOTO_PREFIX = 'photos/';
const R2_THUMB_PREFIX = 'thumbnails/';

export async function createPhotoRecord(
  env: Env,
  draft: DraftRecord
): Promise<Photo> {
  const photoId = crypto.randomUUID();
  const now = new Date().toISOString();

  const photo: Photo = {
    id: photoId,
    name: draft.name,
    price: draft.price,
    tags: draft.tags,
    city: draft.city,
    district: draft.district,
    contact: draft.contact,
    link: draft.link,
    album_id: '',
    images: [],
    cover_index: 0,
    is_pinned: false,
    created_at: now,
  };

  await env.KV.put(KEYS.photo(photoId), JSON.stringify(photo));
  await addToIndex(env, photoId);
  return photo;
}

export async function addImageToPhoto(
  env: Env,
  photoId: string,
  buffer: ArrayBuffer,
  contentType: string
): Promise<void> {
  const raw = await env.KV.get(KEYS.photo(photoId));
  if (!raw) throw new Error('Photo record not found');

  const photo = JSON.parse(raw) as Photo;

  const imageId = crypto.randomUUID();
  const { key, thumb_key } = await uploadBoth(env, photoId, imageId, buffer, contentType);

  if (!photo.images) photo.images = [];
  photo.images.push({ key, thumb_key });
  await env.KV.put(KEYS.photo(photoId), JSON.stringify(photo));
}

export async function getPhoto(env: Env, photoId: string): Promise<Photo | null> {
  const raw = await env.KV.get(KEYS.photo(photoId));
  if (!raw) return null;
  return JSON.parse(raw) as Photo;
}

async function uploadBoth(
  env: Env,
  photoId: string,
  imageId: string,
  buffer: ArrayBuffer,
  contentType: string
): Promise<{ key: string; thumb_key: string }> {
  const key = `${R2_PHOTO_PREFIX}${photoId}/${imageId}`;
  const thumbKey = `${R2_THUMB_PREFIX}${photoId}/${imageId}`;

  await env.R2.put(key, buffer, {
    httpMetadata: { contentType },
    customMetadata: { photoId, imageId },
  });
  // thumbnail uses same bytes (gallery does not re-encode)
  await env.R2.put(thumbKey, buffer, {
    httpMetadata: { contentType },
    customMetadata: { photoId, imageId },
  });

  return { key, thumb_key: thumbKey };
}

async function addToIndex(env: Env, photoId: string): Promise<void> {
  const raw = await env.KV.get(KEYS.photoIndex);
  const index: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  if (!index.includes(photoId)) {
    index.push(photoId);
    await env.KV.put(KEYS.photoIndex, JSON.stringify(index));
  }
}

export async function listPhotos(env: Env): Promise<Photo[]> {
  const raw = await env.KV.get(KEYS.photoIndex);
  const index: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  const photos: Photo[] = [];
  for (const id of index) {
    const photo = await getPhoto(env, id);
    if (photo) photos.push(photo);
  }
  return photos;
}

// Returns existing records whose name or contact matches the draft
// (case-insensitive exact match, trimmed).
export async function findExistingByDraft(
  env: Env,
  draft: DraftRecord
): Promise<Photo[]> {
  const name = (draft.name || '').trim().toLowerCase();
  const contact = (draft.contact || '').trim().toLowerCase();
  if (!name && !contact) return [];

  const photos = await listPhotos(env);
  return photos.filter((p) => {
    const pName = (p.name || '').trim().toLowerCase();
    const pContact = (p.contact || '').trim().toLowerCase();
    return (name && pName === name) || (contact && pContact === contact);
  });
}
