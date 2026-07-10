# 🎧 1分 英語リスニング (TOEIC風)

英語字幕付きのYouTube動画から**約1分の区間をAIが選び**、その区間に対する
**TOEIC風の3問**を自動生成する簡易Webアプリ。動画は**切り出さず**、YouTube IFrame
Player API で「指定区間に頭出し＆区間末で自動停止」して見せます。

本番: https://youtube-listening.vercel.app

## 仕組み

1. 動画を決める（URL貼り付け / サムネ一覧をタップ / 空ならプールからランダム）
2. 字幕（タイムスタンプ付き）を取得（**事前キャッシュ優先**）
3. Claude **Haiku 4.5**（安価・構造化出力）に渡して、150秒窓を2つ提示→良い方から
   45〜60秒の自然な区間＋TOEIC風3問＋日本語訳を生成
4. フロントで区間プレーヤーに埋め込み、出題・採点

## セットアップ

```bash
cp .env.local.example .env.local   # ANTHROPIC_API_KEY を記入
npm install
npm run dev                        # http://localhost:3000
```

`ANTHROPIC_API_KEY` は https://console.anthropic.com で取得。
モデルは `ANTHROPIC_MODEL`（既定 `claude-haiku-4-5`）で変更可。

## 動画を追加する（自分でキャッシュする）

**重要**: YouTubeの字幕取得は Vercel などデータセンターIPからはブロックされる。
だから字幕は**ローカル（家庭回線）で事前取得してアプリに同梱**する。

```bash
# 1本追加（URLでもIDでもOK）。字幕＋タイトルを取得して JSON に自動登録される
node scripts/fetch-transcripts.mjs https://youtu.be/XXXXXXXXXXX

# videos.json 全件を取り直す
node scripts/fetch-transcripts.mjs
```

このコマンド1発で:
- `src/data/transcripts.json` に字幕（秒正規化済み）をキャッシュ
- `src/data/videos.json` に `{id, title}` を登録（タイトルはoEmbedで自動取得）
  → トップのサムネ一覧＆ランダムプールに自動で出てくる

あとはデプロイするだけ:

```bash
npm run build
npx vercel@latest --prod --yes --scope daichi-saitos-projects-113d7b60
```

## 注意・既知の制約

- **字幕が無い／非公開**の動画は不可。英語字幕付き・埋め込み許可の動画を使う。
- 本番（Vercel）では**ライブ字幕取得は基本ブロックされる**。必ず上記の事前キャッシュで同梱する。
- 字幕の `offset/duration` はフォーマットにより**ms/秒が混在**するため、
  取得時に正規化済み（1行が60秒超ならms判定）。

## コスト

Haiku 4.5 = $1 / $5 per 1M tokens。1出題あたり数百〜数千トークン程度で**1円未満**。
