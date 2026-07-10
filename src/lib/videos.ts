// AIに「どの動画を選ぶか」やらせるための候補プール。
// 動画リストは src/data/videos.json（単一の真実）。
// 字幕は scripts/fetch-transcripts.mjs でローカル事前取得し src/data/transcripts.json に同梱する。
// （Vercel等のデータセンターIPからはYouTubeに字幕取得をブロックされるため、ライブ取得に頼らない）
import videos from "@/data/videos.json";

export interface VideoEntry {
  id: string; // 11桁の YouTube videoId
  title: string; // 表示用
}

export const VIDEO_POOL: VideoEntry[] = videos as VideoEntry[];

/** プールからランダムに1本選ぶ（AIに渡す前段の単純なランダム選定） */
export function pickRandomVideo(): VideoEntry | null {
  if (VIDEO_POOL.length === 0) return null;
  const i = Math.floor(Math.random() * VIDEO_POOL.length);
  return VIDEO_POOL[i];
}
