import { DraftRecord } from './types';

export const DEFAULT_MODEL = '@cf/qwen/qwen1.5-14b-chat-awq';

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

function extractText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.map(extractText).join('');
  const r = result as Record<string, unknown>;
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