import { DraftRecord } from './types';

export const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const DEFAULT_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const SYSTEM_PROMPT = `你是一名数据整理助手。用户发来一段中文文字（可能是摄影师的信息）。你的任务：不修改、不翻译、不删减、不纠错任何一个字，只按字段要求重新整理成 JSON 结构返回。
只输出 JSON，不要任何解释、不要 markdown 代码块，格式必须为：
{"name": string, "price": number, "tags": string[], "city": string, "district": string, "contact": string, "link": string}

字段规则（一律从原文中逐字复制）：
- name：用户的姓名或昵称，原样复制；没有则 "未命名"
- price：只取数字（如 800）；没有则 0
- tags：从「标签:」后用户列出的内容中，全部逐个复制，不要遗漏、不要重复、不要合并。
- city：城市名原样复制（如 深圳）；没有则 ""
- district：区域原样复制（如 坂田）；没有则 ""
- contact：联系方式原样复制（如 @kkqq12121）；没有则 ""
- link：链接原样复制；没有则 ""

绝对禁止：改写、翻译、猜测、纠正、增删任何中文字符。不确定的字段保留原文或置空，不要发明新词。`;

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
  const result = await ai.run(modelName, {
    messages,
    max_tokens: 1024,
  } as never);

  return extractDraft(result, 'AI returned unparseable response');
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

  return extractDraft(result, 'Vision AI returned unparseable response');
}

function extractDraft(result: unknown, errMsg: string): DraftRecord {
  // 1) If the model returned a structured object (e.g. { response: {...} } or the
  //    whole result already has the fields), normalize it directly.
  const direct = structuredFromAny(result);
  if (direct) return normalize(direct);

  // 2) Otherwise extract the text (choices[0].message.content / response string)
  //    and parse the JSON out of it, handling double-encoding.
  const content = extractText(result);
  const json = tryParseJson(content);
  if (json) return normalize(json);

  console.error(
    'Unparseable response. result=',
    JSON.stringify(result).slice(0, 800),
    'content=',
    JSON.stringify(content.slice(0, 300))
  );
  throw new Error(errMsg);
}

// Take the first object among {response}, {choices[].message.content}, or the
// result itself that carries the DraftRecord fields (name/price/...).
function structuredFromAny(result: unknown): Record<string, unknown> | null {
  if (result == null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;

  const isObj = (v: unknown): v is Record<string, unknown> =>
    v != null && typeof v === 'object' && !Array.isArray(v);

  if (isObj(r.response) && hasDraftFields(r.response)) return r.response as Record<string, unknown>;

  if (Array.isArray(r.choices)) {
    for (const choice of r.choices) {
      const msg = (choice as { message?: unknown })?.message;
      if (isObj(msg)) {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === 'string') {
          const parsed = tryParseJson(content);
          if (parsed && hasDraftFields(parsed)) return parsed;
        }
      }
    }
  }

  return null;
}

function hasDraftFields(obj: Record<string, unknown>): boolean {
  return 'name' in obj || 'price' in obj || 'city' in obj || 'tags' in obj;
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
    tags: tags.slice(0, 30),
    city: asString(json.city),
    district: asString(json.district),
    contact: asString(json.contact),
    link: asString(json.link),
  };
}