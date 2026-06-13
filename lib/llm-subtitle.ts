import { Mutex } from "./mutex";
import { splitText } from "./resegment";

const OLLAMA = process.env.OLLAMA_URL ?? "http://ollama:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e4b";

const ollamaLock = new Mutex();

const DEFAULT_MAX_CHARS = 30;
const DEFAULT_MIN_CHARS = 6;

export interface WordTimestamp {
  word: string;
  start?: number;
  end?: number;
  speaker?: string | null;
}

export interface SegmentTimestamp {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  speaker?: string | null;
  words?: WordTimestamp[];
}

const SYSTEM_PROMPT = `你是一個專業的字幕編輯助手。請將輸入的字幕片段進行錯字修正與斷句切分。

# 任務規則：
1. **錯字修正**：
   - 修正字幕中的錯字（例如同音錯字「因該」->「應該」）。
   - 修正品牌名稱或專有名詞（例如「微軟」->「Microsoft」或「微軟」、「哀鳳」->「iPhone」等）。
   - 請由上下文自己判斷常見該修正的詞，但**絕對不可隨意更改原本的句型、語氣或增加/減少原本的語意內容**。
2. **字幕分段（斷句切分）**：
   - 如果某個字幕片段太長（通常大於 12-15 個字，或者有多個子句），請在適當的語意中斷處將其切分成多個簡短的子片段（sub_segments）。
   - 每個子片段理想長度為 6-12 個字。
   - 如果片段本身很短，或沒有適合的切分點，則不需要切分（sub_segments 中只會有一個元素）。
3. **輸出格式**：
   - 必須輸出一個 JSON 物件，其格式必須符合下述的 JSON 範例。
   - 絕對不要包含任何 Markdown 格式標記（例如 \`\`\`json），也不要有任何多餘的解釋或說明文字。
   - 請嚴格保持輸出 ID 與輸入 ID 一致。

# 輸入格式範例：
{
  "segments": [
    { "id": "seg-1", "text": "我們今天因該要去微軟的發表會" },
    { "id": "seg-2", "text": "那裡聽說會展示很多好玩的新科技還有介紹最新的哀鳳系統喔" }
  ]
}

# 輸出格式範例：
{
  "results": [
    {
      "id": "seg-1",
      "sub_segments": [
        "我們今天應該要去微軟的發表會"
      ]
    },
    {
      "id": "seg-2",
      "sub_segments": [
        "那裡聽說會展示很多好玩的新科技",
        "還有介紹最新的iOS系統喔"
      ]
    }
  ]
}`;

/**
 * 呼叫 Ollama，若有失敗則進行重試，持續失敗則拋出明確錯誤
 */
const MAX_LLM_RETRIES = 5;
const BACKOFF_BASE_MS = 1500;

async function callOllamaWithRetry(inputData: any): Promise<any> {
  let release: (() => void) | null = null;
  try {
    release = await ollamaLock.acquire();

    const body = {
      model: MODEL,
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
        top_p: 0.9,
        num_ctx: 16384,
      },
      keep_alive: "10m",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(inputData) },
      ],
    };

    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      try {
        const response = await fetch(`${OLLAMA}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const resData = await response.json();
        const content = resData.message?.content ?? "";

        const parsed = JSON.parse(content);
        if (!parsed.results || !Array.isArray(parsed.results)) {
          throw new Error("回傳的 JSON 缺少 'results' 欄位或格式不合");
        }
        return parsed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === MAX_LLM_RETRIES) {
          throw new Error(`Ollama 連續 ${MAX_LLM_RETRIES} 次失敗 (Model: ${MODEL}): ${msg}`);
        }
        const delay = BACKOFF_BASE_MS * attempt;
        console.warn(`[LLM Subtitle] attempt ${attempt}/${MAX_LLM_RETRIES} failed: ${msg} — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } finally {
    if (release) release();
  }
}

/**
 * 核心 LLM 錯字修正、分段、波形對齊流程
 */
export async function correctAndResegmentWithLLM(
  rawSegments: SegmentTimestamp[],
  onProgress?: (done: number, total: number) => void
): Promise<SegmentTimestamp[]> {
  if (!rawSegments || rawSegments.length === 0) return [];

  // One segment per LLM call. Sending multiple segments at once gave the
  // model the freedom to move text from one segment into the next "for
  // smoother flow", which corrupted timing and produced duplicates at
  // segment boundaries. Single-segment input makes that structurally
  // impossible — the model can't move what it can't see.
  const BATCH_SIZE = 1;
  const batches: SegmentTimestamp[][] = [];
  for (let i = 0; i < rawSegments.length; i += BATCH_SIZE) {
    batches.push(rawSegments.slice(i, i + BATCH_SIZE));
  }

  // Report 0/total up front so the client can show a determinate bar the
  // moment correction starts, instead of an indeterminate placeholder.
  onProgress?.(0, batches.length);

  const resultSegments: SegmentTimestamp[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const llmInput = {
      segments: batch.map((s) => ({
        id: String(s.id),
        text: (s.text ?? "").trim(),
      })),
    };

    const responseJson = await callOllamaWithRetry(llmInput);

    for (const originalSeg of batch) {
      const origId = String(originalSeg.id);
      const llmResult = responseJson?.results?.find((r: any) => String(r.id) === origId);

      let subTexts: string[] =
        llmResult?.sub_segments && Array.isArray(llmResult.sub_segments)
          ? llmResult.sub_segments.map((s: string) => s.trim())
          : [originalSeg.text ?? ""];

      // 保險機制：如果 LLM 切出來的句子中，依然有句子長度大於 DEFAULT_MAX_CHARS，則再用現有邏輯切一次
      const finalSubTexts: string[] = [];
      for (const subText of subTexts) {
        if (subText.length > DEFAULT_MAX_CHARS) {
          const splitResult = splitText(subText, DEFAULT_MAX_CHARS, DEFAULT_MIN_CHARS);
          finalSubTexts.push(...splitResult);
        } else {
          finalSubTexts.push(subText);
        }
      }

      const cleanSubs = finalSubTexts.map((s) => s.trim()).filter(Boolean);
      if (cleanSubs.length === 0) continue;

      const segStart = originalSeg.start ?? 0;
      const segEnd = Math.max(originalSeg.end ?? segStart, segStart + 0.05);

      // Split the segment's [start,end] window proportionally by character
      // count. This uses the segment-level timing that Whisper reports
      // reliably, so captions always track playback correctly.
      const timed = proportionalSplit(cleanSubs, segStart, segEnd);

      for (let i = 0; i < timed.length; i++) {
        resultSegments.push({
          id: originalSeg.id ? Number(`${originalSeg.id}${i}`) : undefined,
          start: timed[i].start,
          end: timed[i].end,
          text: timed[i].text,
          speaker: originalSeg.speaker,
        });
      }
    }

    // One Ollama round-trip == one batch. Report after each so the client
    // bar advances in real, observable steps rather than sitting flat.
    onProgress?.(batchIdx + 1, batches.length);
  }

  return sanitizeTimeline(resultSegments);
}

/**
 * Split a list of sub-segments across [segStart, segEnd] proportionally by
 * character count. Times come straight from the reliable segment-level window,
 * so they always advance with playback.
 */
function proportionalSplit(
  subs: string[],
  segStart: number,
  segEnd: number
): { text: string; start: number; end: number }[] {
  const duration = Math.max(0.05, segEnd - segStart);
  const totalLen = subs.reduce((n, s) => n + s.length, 0) || 1;
  const out: { text: string; start: number; end: number }[] = [];
  let acc = 0;
  for (let i = 0; i < subs.length; i++) {
    const start = segStart + duration * (acc / totalLen);
    acc += subs[i].length;
    const end =
      i === subs.length - 1 ? segEnd : segStart + duration * (acc / totalLen);
    out.push({ text: subs[i], start, end: Math.max(end, start + 0.05) });
  }
  return out;
}

/**
 * The char-level Levenshtein aligner can occasionally hand back overlapping
 * or out-of-order time windows (a short sub-segment matching characters that
 * recur later in the timeline, or a failed alignment falling back to a wide
 * window). Two consequences the user sees:
 *   - overlapping windows → two captions are "current" at the same instant,
 *     so currentSegment() picks one and the other looks like a duplicate;
 *   - a first segment whose start drifted late → the opening caption appears
 *     to lag the audio.
 * This pass enforces monotonic, non-overlapping windows in speaking order and
 * drops/merges exact-duplicate neighbours, without reordering speech.
 */
function sanitizeTimeline(segs: SegmentTimestamp[]): SegmentTimestamp[] {
  const out: SegmentTimestamp[] = [];
  for (const seg of segs) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;

    let start = typeof seg.start === "number" ? seg.start : 0;
    let end = typeof seg.end === "number" ? seg.end : start;
    const prev = out[out.length - 1];

    if (prev) {
      const prevEnd = prev.end ?? 0;
      // Monotonic starts: never let a window begin before the previous one.
      if (start < prevEnd) start = prevEnd;
      // Trim the previous window so it can't bleed past this one's start.
      if ((prev.end ?? 0) > start) prev.end = start;
      // Collapse a neighbour that repeats the same text over an overlapping
      // window — that's the visible "重複的句子".
      if (prev.text?.trim() === text && (prev.end ?? 0) >= start) {
        prev.end = Math.max(prev.end ?? 0, end);
        continue;
      }
    }

    if (end < start + 0.05) end = start + 0.05;
    out.push({ ...seg, text, start, end });
  }
  return out;
}
