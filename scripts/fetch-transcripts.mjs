// YouTube動画の字幕をローカルで取得してアプリに同梱するスクリプト。
//   - 字幕(タイムスタンプ付き) → src/data/transcripts.json
//   - タイトル(oEmbedで取得)   → src/data/videos.json に自動登録
//
// 使い方:
//   node scripts/fetch-transcripts.mjs <url|id>   # 1本追加（推奨）
//   node scripts/fetch-transcripts.mjs            # videos.json 全件を再取得
//
// ※ ローカル(家庭回線等)で実行すること。VercelのIPからはYouTubeにブロックされる。
import { YoutubeTranscript } from "youtube-transcript";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const videosPath = join(root, "src/data/videos.json");
const cachePath = join(root, "src/data/transcripts.json");

function parseId(s) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).slice(0, 11);
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/(embed|shorts)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[2];
  } catch {}
  return null;
}

function normalize(raw) {
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
  // 自動生成字幕(ASR)のローリング重複を除去: end を次の字幕の開始でクランプ
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) {
      cues[i].end = Math.max(cues[i].start, cues[i + 1].start);
    }
  }
  return cues;
}

// oEmbedで動画タイトルを取得（APIキー不要・公開）
async function fetchTitle(id) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://youtu.be/${id}&format=json`,
    );
    if (!res.ok) return null;
    const j = await res.json();
    return j.title || null;
  } catch {
    return null;
  }
}

const cache = JSON.parse(readFileSync(cachePath, "utf8"));
const videos = JSON.parse(readFileSync(videosPath, "utf8"));

// 取得対象: 引数があればそれ、なければ videos.json 全件
const arg = process.argv[2];
let ids;
if (arg) {
  const id = parseId(arg);
  if (!id) {
    console.error("URL/IDを認識できません:", arg);
    process.exit(1);
  }
  ids = [id];
} else {
  ids = videos.map((v) => v.id);
}

let ok = 0;
for (const id of ids) {
  try {
    const raw = await YoutubeTranscript.fetchTranscript(id);
    if (!raw || raw.length === 0) {
      console.log(`✗ ${id}: 字幕が空`);
      continue;
    }
    cache[id] = normalize(raw);

    // タイトルを取得して videos.json に登録/更新
    const title = (await fetchTitle(id)) || id;
    const idx = videos.findIndex((v) => v.id === id);
    if (idx >= 0) videos[idx].title = title;
    else videos.push({ id, title });

    ok++;
    console.log(`✓ ${id}: ${cache[id].length} cues  「${title}」`);
  } catch (e) {
    console.log(`✗ ${id}: ${e.message}`);
  }
}

writeFileSync(cachePath, JSON.stringify(cache, null, 0) + "\n");
writeFileSync(videosPath, JSON.stringify(videos, null, 2) + "\n");
console.log(
  `\n${ok}/${ids.length} 件をキャッシュしました → transcripts.json / videos.json`,
);
