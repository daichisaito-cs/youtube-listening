import { NextResponse } from "next/server";
import { parseVideoId } from "@/lib/youtube";
import { getCues, isCached } from "@/lib/transcript";
import { generateQuiz } from "@/lib/quiz";
import { pickRandomVideo } from "@/lib/videos";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY が未設定です。.env.local に設定してください。" },
        { status: 500 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as { url?: string };

    // 1) 動画を決める：URL指定があればそれ、なければプールからランダム
    let videoId: string | null = null;
    if (body.url && body.url.trim()) {
      videoId = parseVideoId(body.url);
      if (!videoId) {
        return NextResponse.json({ error: "YouTubeのURL/IDを認識できませんでした。" }, { status: 400 });
      }
    } else {
      const v = pickRandomVideo();
      if (!v) {
        return NextResponse.json(
          { error: "動画プールが空です。URLを貼るか src/lib/videos.ts に動画を登録してください。" },
          { status: 400 },
        );
      }
      videoId = v.id;
    }

    // 2) 字幕（タイムスタンプ付き）取得：キャッシュ優先、無ければライブ取得
    let cues;
    try {
      cues = await getCues(videoId);
    } catch {
      const hint = isCached(videoId)
        ? "字幕取得に失敗しました。"
        : "この動画はキャッシュに無く、ライブ取得もYouTubeにブロックされました（Vercelのデータセンターからは制限されます）。ローカルで `node scripts/fetch-transcripts.mjs <URL>` を実行して同梱してください。";
      return NextResponse.json({ error: hint }, { status: 502 });
    }
    if (!cues || cues.length === 0) {
      return NextResponse.json({ error: "この動画には字幕がありませんでした。" }, { status: 422 });
    }

    // 3) Gemini に区間選定＋設問生成させる
    const quiz = await generateQuiz(cues);
    if (quiz.questions.length === 0) {
      return NextResponse.json({ error: "設問を生成できませんでした。" }, { status: 502 });
    }

    return NextResponse.json({ videoId, ...quiz });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
