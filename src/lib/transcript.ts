import { YoutubeTranscript } from "youtube-transcript";
import cache from "@/data/transcripts.json";

export interface Cue {
  start: number; // 秒
  end: number; // 秒
  text: string;
}

const CACHE = cache as Record<string, Cue[]>;

/**
 * 字幕(タイムスタンプ付き)を取得。
 * 1) 同梱キャッシュ(src/data/transcripts.json)にあればそれを使う ← 本番(Vercel)はこちら
 * 2) 無ければライブ取得(ローカル開発・キャッシュ未生成時のフォールバック)
 */
export async function getCues(videoId: string): Promise<Cue[]> {
  const cached = CACHE[videoId];
  if (cached && cached.length > 0) return cached;
  return fetchCuesLive(videoId);
}

/** キャッシュに動画があるか */
export function isCached(videoId: string): boolean {
  return Array.isArray(CACHE[videoId]) && CACHE[videoId].length > 0;
}

/**
 * YouTubeから字幕をライブ取得して秒に正規化。
 * youtube-transcript は字幕フォーマットにより offset/duration が
 * ミリ秒(srv3)と秒(classic)で混在するため正規化する。
 * ※ データセンターIPからはブロックされやすい（Vercel本番では基本キャッシュを使う）。
 */
export async function fetchCuesLive(videoId: string): Promise<Cue[]> {
  const raw = await YoutubeTranscript.fetchTranscript(videoId);
  if (!raw || raw.length === 0) return [];
  return normalize(raw);
}

/** youtube-transcript の生データ → Cue[]（秒）に正規化 */
export function normalize(
  raw: { text: string; duration: number; offset: number }[],
): Cue[] {
  // 1行の字幕が60秒を超えることはまずないので、duration>60ならms単位と判定
  const maxDuration = Math.max(...raw.map((r) => r.duration));
  const div = maxDuration > 60 ? 1000 : 1;
  const cues = raw.map((r) => {
    const start = r.offset / div;
    return {
      start,
      end: start + r.duration / div,
      text: r.text.replace(/\s+/g, " ").trim(),
    };
  });
  return deoverlap(cues);
}

/**
 * 自動生成字幕(ASR)は各行の end が次の行まで大きく重なる(ローリング表示)。
 * end を「次の字幕の開始時刻」でクランプして重なりを除去し、タイムスタンプを
 * 実際の発話に近づける。手作業字幕(重複なし)には影響しない。
 */
export function deoverlap(cues: Cue[]): Cue[] {
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) {
      cues[i].end = Math.max(cues[i].start, cues[i + 1].start);
    }
  }
  return cues;
}

/**
 * 動画内のランダムな窓(既定120秒)を切り出す。
 * 出題位置を冒頭に偏らせず動画全体へ散らすため、モデルに渡す前に区間を絞る。
 */
export function pickRandomWindow(cues: Cue[], windowSec = 120): Cue[] {
  if (cues.length === 0) return cues;
  const total = cues[cues.length - 1].end;
  if (total <= windowSec) return cues; // 短い動画は全体を渡す
  const maxStart = total - windowSec;
  const winStart = Math.random() * maxStart;
  const winEnd = winStart + windowSec;
  const sliced = cues.filter((c) => c.start >= winStart && c.start < winEnd);
  // 念のため空にならないようフォールバック
  return sliced.length > 0 ? sliced : cues;
}

/**
 * 動画内からランダムな窓を複数(既定2つ)切り出す。
 * できるだけ重ならない位置を選ぶ（片方が締め/余談など外れだった時の保険として、AIに良い方を選ばせる）。
 */
export function pickRandomWindows(
  cues: Cue[],
  windowSec = 150,
  count = 2,
): Cue[][] {
  if (cues.length === 0) return [];
  const total = cues[cues.length - 1].end;
  if (total <= windowSec) return [cues]; // 短い動画は1つだけ
  const maxStart = total - windowSec;
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    let s = 0;
    for (let tries = 0; tries < 8; tries++) {
      s = Math.random() * maxStart;
      // 既存の窓と被らない位置を優先
      if (!starts.some((p) => Math.abs(p - s) < windowSec)) break;
    }
    starts.push(s);
  }
  return starts
    .map((s) => cues.filter((c) => c.start >= s && c.start < s + windowSec))
    .filter((w) => w.length > 0);
}

/**
 * 実際の字幕データから [start,end] に重なる行を切り出す。
 * 区間を字幕の行境界にスナップし、{snappedStart, snappedEnd, text} を返す。
 * → 「再生される区間」と「表示するスクリプト」を完全一致させるための関数。
 */
export function sliceSegment(
  cues: Cue[],
  start: number,
  end: number,
): { start: number; end: number; text: string } | null {
  const inc = cues.filter((c) => c.end > start && c.start < end);
  if (inc.length === 0) return null;
  return {
    start: inc[0].start,
    end: inc[inc.length - 1].end,
    text: inc
      .map((c) => c.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

/**
 * 区間が短すぎる場合に、後方（足りなければ前方）の字幕行を足して target 秒程度まで伸ばす。
 * 元の内容を内包したまま広げるので、その区間向けに作った設問はそのまま有効。
 */
export function growSegment(
  cues: Cue[],
  start: number,
  end: number,
  minSec = 45,
  targetSec = 52,
): { start: number; end: number } {
  if (end - start >= minSec) return { start, end };
  const nearest = (val: number, key: "start" | "end") =>
    cues.reduce(
      (best, c, i) =>
        Math.abs(c[key] - val) < Math.abs(cues[best][key] - val) ? i : best,
      0,
    );
  let startIdx = nearest(start, "start");
  let endIdx = nearest(end, "end");
  // まず後方に伸ばす
  while (endIdx < cues.length - 1 && cues[endIdx].end - cues[startIdx].start < targetSec) {
    endIdx++;
  }
  // それでも足りなければ前方に伸ばす
  while (startIdx > 0 && cues[endIdx].end - cues[startIdx].start < targetSec) {
    startIdx--;
  }
  return { start: cues[startIdx].start, end: cues[endIdx].end };
}

/** モデルに渡しやすいよう [mm:ss] テキスト 形式に整形 */
export function cuesToTimedText(cues: Cue[]): string {
  return cues
    .map((c) => {
      const m = Math.floor(c.start / 60);
      const s = Math.floor(c.start % 60);
      const ts = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      return `[${ts}] (${c.start.toFixed(1)}s) ${c.text}`;
    })
    .join("\n");
}
