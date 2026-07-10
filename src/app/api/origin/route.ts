import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

const FILE = path.join(process.cwd(), "src/data/videos.json");

// 出身(origin)の保存/編集。ローカル(npm run dev)専用。
// 本番(Vercel)はファイル書き込み不可なので拒否する。
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "編集はローカル(npm run dev)でのみ可能です。保存後 build → deploy で反映してください。" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    origin?: string;
  };
  if (!body.id) {
    return NextResponse.json({ error: "id が必要です。" }, { status: 400 });
  }

  const raw = await fs.readFile(FILE, "utf8");
  const videos = JSON.parse(raw) as { id: string; origin?: string }[];
  const v = videos.find((x) => x.id === body.id);
  if (!v) {
    return NextResponse.json({ error: "動画が見つかりません。" }, { status: 404 });
  }

  const text = (body.origin || "").trim();
  if (text) v.origin = text;
  else delete v.origin; // 空なら出身を削除

  await fs.writeFile(FILE, JSON.stringify(videos, null, 2) + "\n");
  return NextResponse.json({ ok: true, origin: text });
}
