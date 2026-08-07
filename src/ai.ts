import { DraftRecord } from './types';

export const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const DEFAULT_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const SYSTEM_PROMPT = `You extract structured photo-record data from a Chinese text message a photographer sends.
Output ONLY a JSON object with no commentary, no markdown fences, matching exactly this shape:
{"name": string, "price": number, "tags": string[], "city": string, "district": string, "contact": string, "link": string}

Rules:
- name: a short descriptive title from the message (e.g. topic/subject/location). If none, use "未命名".
- price: a plain number (Chinese 元/万 -> numeric yuan). If none, 0.
- tags: 2-6 short lowercase topics/labels (e.g. 人像, 街拍, 婚纱, 风光). Empty array if none.
- city: the city mentioned (Chinese). If none, "".
- district: smaller area/district mentioned if any, else "".
- contact: any phone / WeChat / QQ / telegram / email found verbatim. If none, "".
- link: any URL found (e.g. https://...). If none, "".
Preserve the original Chinese values exactly. Do not invent values.`;

const VISION_SYSTEM_PROMPT = `You look at a photo a photographer sends and extract structured photo-record data from the image content and any attached caption.
Output JSON only, no commentary, no markdown fences, exactly:
{"name": string, "price": number, "tags": string[], "city": string, "district": string, "contact": string, "link": string}

Rules:
- name: a short descriptive title describing the work/scene in the image (e.g. subject, genre, location). If none, use "未命名".
- price: a plain number if a price is visible/mentioned, else 0.
- tags: 2-6 short labels for the image content (e.g. 人像, 街拍, 婚纱, 风光). Empty array if none.
- city: the city mentioned if any, else "".
- district: smaller area/district if any, else "".
- contact: any phone / WeChat / QQ / telegram / email found verbatim, else "".
- link: any URL found, else "".
Preserve original Chinese values exactly. Do not invent values.`;

export async function extractRecord(
  ai: Ai,
  model: string | undefined,
  text: string
): Promise<DraftRecord> {
  const prompt = `提取以下图片描述文本中的摄影记录信息：\n"""\n${text}\n"""`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const modelName = model || DEFAULT_MODEL;
  const result = await ai.run(modelName, { messages } as never);

  const content = extractText(result);

  // Try to find the JSON object in the response
  const json = tryParseJson(content);
  if (json) return normalize(json);

  throw new Error('AI returned unparseable response');
}

export async function extractRecordFromImage(
  ai: Ai,
  visionModel: string | undefined,
  image: ArrayBuffer,
  contextText: string
): Promise<DraftRecord> {
  const prompt = contextText.trim()
    ? `这是摄影师发来的照片及文字描述，请识别照片内容并结合描述，提取一条摄影记录信息。\n文字描述：\n"""\n${contextText}\n"""`
    : '这是摄影师发来的照片，请识别照片内容并提取一条摄影记录信息。';

  const modelName = visionModel || DEFAULT_VISION_MODEL;
  const result = await ai.run(modelName, {
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    image: new Uint8Array(image),
    max_tokens: 512,
  } as never);

  const content = extractText(result);
  const json = tryParseJson(content);
  if (json) return normalize(json);

  throw new Error('Vision AI returned unparseable response');
}

function extractText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.map(extractText).join('');
  const r = result as Record<string, unknown>;
  // OpenAI-compatible chat completion: choices[].message.content
  if (Array.isArray(r.choices)) {
    const parts = (r.choices as unknown[])
      .map((choice) => {
        const c = choice as { message?: { content?: unknown }; text?: unknown };
        const content = c.message?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map(extractText).join('');
        if (typeof c.text === 'string') return c.text;
        return '';
      })
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts.join('');
  }
  if (typeof r.response === 'string') return r.response;
  if (Array.isArray(r.response)) return r.response.map(extractText).join('');
  if (typeof r.text === 'string') return r.text;
  if (typeof r.content === 'string') return r.content;
  return JSON.stringify(result);
}

function tryParseJson(content: string): Record<string, unknown> | null {
  const trimmed = content.replace(/```json/gi, '').replace(/```/g, '').replace(/^\s+|\s+$/g, '');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // fall back to extracting first {...}
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalize(json: Record<string, unknown>): DraftRecord {
  const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const price =
    typeof json.price === 'number'
      ? json.price
      : parseFloat(asString(json.price)) || 0;

  let tags: string[] = [];
  if (Array.isArray(json.tags)) {
    tags = json.tags.map((t) => asString(t)).filter(Boolean);
  } else if (typeof json.tags === 'string') {
    tags = (json.tags as string).split(/[,，;；]/).map((t) => t.trim()).filter(Boolean);
  }

  return {
    name: asString(json.name) || '未命名',
    price,
    tags: tags.slice(0, 6),
    city: asString(json.city),
    district: asString(json.district),
    contact: asString(json.contact),
    link: asString(json.link),
  };
}