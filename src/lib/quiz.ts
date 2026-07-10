import { GoogleGenAI, Type } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import type { Cue } from "./transcript";
import {
  cuesToTimedText,
  growSegment,
  pickRandomWindows,
  sliceSegment,
} from "./transcript";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Gemini 2.5 Flash の料金（USD / 100万トークン）。モデル変更時はここを合わせる。
const PRICE_IN_PER_M = Number(process.env.PRICE_IN_PER_M) || 0.3; // 入力
const PRICE_OUT_PER_M = Number(process.env.PRICE_OUT_PER_M) || 2.5; // 出力（思考トークン含む）
// USD→JPY 換算レート（環境変数で上書き可。既定は概算）
const USDJPY = Number(process.env.USDJPY_RATE) || 155;

// 1回のリクエストで使ったトークンを積み上げるためのアキュムレータ
interface UsageAcc {
  input: number;
  output: number;
}

/** generateContent のレスポンスからトークン使用量を加算 */
function addUsage(acc: UsageAcc, res: GenerateContentResponse): void {
  const u = res.usageMetadata;
  if (!u) return;
  acc.input += u.promptTokenCount || 0;
  // 出力 = 応答トークン + 思考トークン（thinkingBudget=0でも保険で加算）
  acc.output += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
}

/** 秒を mm:ss 表記に */
function secLabel(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface Question {
  question: string; // 英語の設問
  options: string[]; // 4択（英語）
  answerIndex: number; // 正解の選択肢インデックス(0-3)
  explanation: string; // 日本語の解説
}

export interface Quiz {
  start: number; // 区間開始（秒）
  end: number; // 区間終了（秒）
  transcript: string; // その区間で実際に話されている英文
  transcriptJa: string; // 上記の日本語訳
  questions: Question[]; // 3問
  cost?: Cost; // この問題の生成にかかったAPIコスト
}

export interface Cost {
  inputTokens: number;
  outputTokens: number;
  usd: number; // 米ドル
  jpy: number; // 日本円（概算）
}

// 1段階目: 区間選定だけ（start/end のみ）
// ※ Gemini の responseSchema は additionalProperties 非対応なので付けない
const SELECT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    start: { type: Type.NUMBER, description: "区間の開始秒(絶対値)" },
    end: { type: Type.NUMBER, description: "区間の終了秒(絶対値)" },
  },
  required: ["start", "end"],
};

// 2段階目: 確定スクリプトから設問だけ生成
const QUESTIONS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          answerIndex: { type: Type.INTEGER },
          explanation: { type: Type.STRING },
        },
        required: ["question", "options", "answerIndex", "explanation"],
      },
    },
  },
  required: ["questions"],
};

// 1段階目のシステム: 良い候補を選び、その中の45-60秒の区間を秒で返すだけ
const SELECT_SYSTEM = `You are choosing material for an English listening test from a YouTube video.
You are given SEVERAL candidate excerpts (CANDIDATE 1 / CANDIDATE 2 / …) from different parts of the SAME video. Each line is prefixed with its ABSOLUTE timestamp in seconds, e.g. "[03:14] (194.3s) ...".

Task: Judge which candidate has the better, content-rich, self-contained material for a listening test, then choose ONE segment WITHIN that candidate and return its exact start/end in SECONDS (absolute, taken from the (…s) values shown). The segment MUST:
- be STRICTLY between 45 and 60 seconds long (end minus start),
- be a complete thought, not cut mid-sentence,
- contain substantive content (an explanation, advice, a story, an argument) — NOT a greeting, self-introduction, thank-you, sign-off, sponsor/ad read, or fragmented banter.

Return ONLY the two numbers: start and end (in seconds). Do not write anything else.`;

// 2段階目のシステム: 渡された確定スクリプトだけから設問を作る（表示・音声と完全一致を保証）
const QUESTIONS_SYSTEM = `You are an English listening test author specializing in authentic TOEIC Listening (Part 3/4) questions.
You are given the EXACT transcript of one ~50-second audio segment. Write EXACTLY 3 questions in the real TOEIC Part 3/4 style. Every question and every option MUST be answerable purely from THIS transcript — never use outside knowledge or invent facts not present in the text.

TOEIC question style — IMPORTANT:
- Test gist, purpose, inference, and sequence/cause — NOT trivia.
- Prefer these question types:
  * Main idea / topic: "What is the speaker mainly discussing?"
  * Speaker's purpose: "Why does the speaker mention ___?"
  * Suggestion / recommendation (paraphrased): "What does the speaker recommend?"
  * Inference / implication: "What does the speaker imply about ___?"
  * Sequence / cause: "What happened right after ___?"
  * Detail as PARAPHRASE, not verbatim recall.
- AVOID: questions that require memorizing an exact number, statistic, or niche jargon term.
- The 3 distractors must NOT be eliminable by common sense or context alone (i.e. without
  having listened). Build them from words and closely related concepts that ACTUALLY appear in
  the segment, and keep their plausibility on par with the correct answer, so that a test-taker
  can only choose correctly by having understood the audio — not by general knowledge.
- Options should be plausible paraphrases at a similar level (typical TOEIC distractors),
  not "one obviously right number vs three wrong numbers".

Constraints:
- Each question has EXACTLY 4 options (A-D) in English; exactly one correct; set answerIndex (0-3).
- "explanation" in Japanese, briefly explaining why the answer is correct (you may quote the relevant English phrase).
- Base everything ONLY on the given transcript.`;

export async function generateQuiz(cues: Cue[]): Promise<Quiz> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const usage: UsageAcc = { input: 0, output: 0 }; // 全API呼び出し分を合算

  // ── 1段階目: 区間を確定する（モデルは start/end のみ返す）──
  // 長さが想定外（短すぎ/長すぎ）なら、別のランダム窓で作り直す（最大3回）
  let seg: { start: number; end: number; text: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const windows = pickRandomWindows(cues, 300, 2);
    const timed = windows
      .map((w, i) => {
        const a = Math.floor(w[0].start);
        const b = Math.ceil(w[w.length - 1].end);
        return `=== CANDIDATE ${i + 1} (${secLabel(a)}–${secLabel(b)}) ===\n${cuesToTimedText(w)}`;
      })
      .join("\n\n");

    const res = await ai.models.generateContent({
      model: MODEL,
      contents: `Here are the candidate excerpts. Pick the best candidate and return the start/end (seconds) of a 45-60s segment within it.\n\n${timed}`,
      config: {
        systemInstruction: SELECT_SYSTEM,
        responseMimeType: "application/json",
        responseSchema: SELECT_SCHEMA,
        maxOutputTokens: 200,
        thinkingConfig: { thinkingBudget: 0 }, // 思考オフ（コスト・速度優先）
      },
    });
    addUsage(usage, res);

    const text = res.text;
    if (!text) continue;

    const sel = JSON.parse(text) as { start: number; end: number };
    // モデルが返した秒数で実際の字幕を切り出す（範囲外・デタラメなら空振り→作り直し）
    const s = sliceSegment(cues, Number(sel.start) || 0, Number(sel.end) || 0);
    if (!s) continue;
    seg = s;

    const len = s.end - s.start;
    if (len >= 40 && len <= 72) break; // 適切な長さなら確定、外れたら作り直し
  }

  if (!seg) throw new Error("出題区間を選定できませんでした");

  // 最終保険: 区間が短すぎる場合は前後の字幕を足して45秒以上に伸ばす
  if (seg.end - seg.start < 45) {
    const grown = growSegment(cues, seg.start, seg.end);
    const seg2 = sliceSegment(cues, grown.start, grown.end);
    if (seg2) seg = seg2;
  }

  // ── 2段階目: 確定したスクリプトそのものから設問を作る ──
  //   これにより「表示スクリプト・再生音声・設問」が必ず同じ内容になる。
  const questions = await writeQuestions(ai, seg.text, usage);

  // 日本語訳も同じ確定スクリプトを翻訳 → EN/JA/再生区間/設問が完全一致
  const transcriptJa = await translateToJa(ai, seg.text, usage);

  const quiz = sanitizeQuiz({
    start: seg.start,
    end: seg.end,
    transcript: seg.text,
    transcriptJa,
    questions,
  });
  quiz.cost = computeCost(usage);
  return quiz;
}

/** 積み上げたトークン使用量を USD / JPY のコストに換算 */
function computeCost(usage: UsageAcc): Cost {
  const usd =
    (usage.input / 1_000_000) * PRICE_IN_PER_M +
    (usage.output / 1_000_000) * PRICE_OUT_PER_M;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    usd,
    jpy: usd * USDJPY,
  };
}

/** 確定スクリプトから TOEIC風3問を生成（このテキストだけが根拠） */
async function writeQuestions(
  ai: GoogleGenAI,
  transcript: string,
  usage: UsageAcc,
): Promise<Question[]> {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: `Transcript of the audio segment:\n\n"""\n${transcript}\n"""\n\nWrite exactly 3 TOEIC Part 3/4 style questions answerable only from this transcript.`,
    config: {
      systemInstruction: QUESTIONS_SYSTEM,
      responseMimeType: "application/json",
      responseSchema: QUESTIONS_SCHEMA,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  addUsage(usage, res);

  const text = res.text;
  if (!text) return [];
  const parsed = JSON.parse(text) as { questions: Question[] };
  return parsed.questions || [];
}

/** 切り出した英文を自然な日本語に翻訳（プレーンテキスト出力） */
async function translateToJa(
  ai: GoogleGenAI,
  text: string,
  usage: UsageAcc,
): Promise<string> {
  if (!text.trim()) return "";
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: text,
    config: {
      systemInstruction:
        "Translate the user's English transcript into natural, fluent Japanese. Output ONLY the Japanese translation — no preamble, no notes.",
      maxOutputTokens: 1500,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  addUsage(usage, res);
  return (res.text || "").trim();
}

/** モデル出力を最低限バリデート・整形 */
function sanitizeQuiz(q: Quiz): Quiz {
  const questions = (q.questions || [])
    .filter((x) => Array.isArray(x.options) && x.options.length >= 2)
    .slice(0, 3)
    .map((x) => {
      const options = x.options.slice(0, 4);
      let answerIndex = Number(x.answerIndex);
      if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) {
        answerIndex = 0;
      }
      return {
        question: String(x.question || "").trim(),
        options,
        answerIndex,
        explanation: String(x.explanation || "").trim(),
      };
    });

  return {
    start: Math.max(0, Number(q.start) || 0),
    end: Math.max(Number(q.start) || 0, Number(q.end) || 0),
    transcript: String(q.transcript || "").trim(),
    transcriptJa: String(q.transcriptJa || "").trim(),
    questions,
  };
}
