"use client";

import { useEffect, useRef, useState } from "react";
import SegmentPlayer from "@/components/SegmentPlayer";
import videos from "@/data/videos.json";

// キャッシュ済み動画（字幕事前取得済み = ここから選べば確実に出題できる）
const CACHED_VIDEOS = videos as {
  id: string;
  title: string;
  origin?: string;
}[];

const LOADING_MSGS = [
  "字幕を解析しています…",
  "出題する区間を選んでいます…",
  "設問を作成しています…",
  "日本語訳を生成しています…",
];

interface Question {
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
}
interface Quiz {
  videoId: string;
  start: number;
  end: number;
  transcript: string;
  transcriptJa: string;
  questions: Question[];
  cost?: {
    inputTokens: number;
    outputTokens: number;
    usd: number;
    jpy: number;
  };
}

// 出身の編集UIはローカル(npm run dev)でのみ表示。本番は保存できないので隠す。
const IS_DEV = process.env.NODE_ENV === "development";

// お気に入り（生成した問題を丸ごと保存して後で再現）。
// 本番はサーバーにファイル保存できないので localStorage（=この端末/ブラウザのみ）に保存する。
const FAV_KEY = "yt-listening-favorites";
// 解きかけの問題（出題中の状態）。リロードで消えないように保存する。
const CUR_KEY = "yt-listening-current";
const titleOf = (id: string) =>
  CACHED_VIDEOS.find((v) => v.id === id)?.title || id;
const favKeyOf = (q: Quiz) =>
  `${q.videoId}:${Math.round(q.start)}-${Math.round(q.end)}`;
const fmtTime = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

interface Favorite {
  key: string;
  title: string;
  savedAt: number;
  quiz: Quiz;
}

// お気に入りの書き出し/読み込み用。UTF-8(日本語)を安全にbase64化する。
// 標準base64の "+" は URL/メール/チャットを経由すると空白に化けてコードが壊れるため、
// URL安全な文字集合(-, _)で書き出し、パディングも落とす。
const toB64 = (s: string) =>
  btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64 = (b: string) => {
  // URL安全形式(-,_)か、旧形式(+,/)かを判別する。旧形式に -,_ は現れない。
  const urlSafe = /[-_]/.test(b);
  let t = b
    // iOS/macOS のスマート表記変換は "--"→"–"(en dash)、"---"→"—"(em dash) と
    // 文字数を詰めて置換する。戻すときも同じ数のハイフンに展開する。
    .replace(/—/g, "---")
    .replace(/–/g, "--")
    // 単独で化けるハイフン類（U+2010 ハイフン, U+2212 マイナス, 全角）
    .replace(/[‐−－]/g, "-")
    .replace(/＿/g, "_")
    // ゼロ幅スペース・BOM・ノーブレークスペースを除去
    .replace(/[​‌‍﻿ ]/g, "")
    .replace(/[\r\n\t]/g, ""); // 折り返しで入った改行を除去
  // 旧形式では空白は化けた "+" とみなす。新形式に "+" は無いので単に捨てる。
  t = urlSafe ? t.replace(/ /g, "") : t.replace(/ /g, "+");
  t = t.replace(/-/g, "+").replace(/_/g, "/");

  const bad = [...new Set(t.replace(/[A-Za-z0-9+/=]/g, ""))];
  if (bad.length > 0) {
    const shown = bad
      .map((c) => `${c}(U+${c.codePointAt(0)!.toString(16).toUpperCase()})`)
      .join(" ");
    throw new Error(`コードに使えない文字が含まれています: ${shown}`);
  }

  const body = t.replace(/=+$/, "");
  return decodeURIComponent(
    escape(atob(body + "=".repeat((4 - (body.length % 4)) % 4))),
  );
};
const SYNC_PREFIX = "YTL1:";

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [graded, setGraded] = useState(false);
  const [showEn, setShowEn] = useState(false);
  const [showJa, setShowJa] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);

  // 出身(origin)の編集用。CACHED_VIDEOS を初期値に持ち、編集後その場で反映する。
  const [vids, setVids] = useState(CACHED_VIDEOS);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // お気に入り（localStorage）。マウント時に読み込む。
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (raw) setFavorites(JSON.parse(raw) as Favorite[]);
    } catch {}
  }, []);

  // 解きかけの問題をマウント時に復元（リロードしても続きから解ける）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CUR_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as {
        quiz: Quiz;
        answers?: Record<number, number>;
        graded?: boolean;
      };
      if (s.quiz) {
        setQuiz(s.quiz);
        setAnswers(s.answers || {});
        setGraded(!!s.graded);
      }
    } catch {}
  }, []);

  // 出題中の状態（問題・回答・採点）を保存。初回(復元前)の空状態では保存しない。
  const skipFirstSave = useRef(true);
  useEffect(() => {
    if (skipFirstSave.current) {
      skipFirstSave.current = false;
      return;
    }
    try {
      if (quiz)
        localStorage.setItem(CUR_KEY, JSON.stringify({ quiz, answers, graded }));
      else localStorage.removeItem(CUR_KEY);
    } catch {}
  }, [quiz, answers, graded]);

  function persistFavorites(next: Favorite[]) {
    setFavorites(next);
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(next));
    } catch {}
  }

  // いま表示中の問題をお気に入りに追加/解除
  function toggleFavorite() {
    if (!quiz) return;
    const key = favKeyOf(quiz);
    if (favorites.some((f) => f.key === key)) {
      persistFavorites(favorites.filter((f) => f.key !== key));
    } else {
      const fav: Favorite = {
        key,
        title: titleOf(quiz.videoId),
        savedAt: Date.now(),
        quiz,
      };
      persistFavorites([fav, ...favorites]);
    }
  }

  function removeFavorite(key: string) {
    persistFavorites(favorites.filter((f) => f.key !== key));
  }

  // 削除確認モーダル（誤タップ防止）
  const [confirmDel, setConfirmDel] = useState<{
    key: string;
    title: string;
  } | null>(null);

  // 端末間でお気に入りを移す（書き出しコード ⇔ 読み込み）
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  async function exportFavorites() {
    if (favorites.length === 0) return;
    const code = SYNC_PREFIX + toB64(JSON.stringify(favorites));
    try {
      await navigator.clipboard.writeText(code);
      setSyncMsg(
        `${favorites.length}件をコードにしてコピーしました。もう片方の端末で「読み込み」に貼り付けてください。`,
      );
    } catch {
      // コピーできない環境では下に表示して手動コピーしてもらう
      setShowImport(true);
      setImportText(code);
      setSyncMsg("自動コピーできなかったので下に表示しました。手動でコピーしてください。");
    }
  }

  function importFavorites() {
    try {
      const t = importText.trim().replace(/^YTL1:/, "");
      const arr = JSON.parse(fromB64(t)) as Favorite[];
      if (!Array.isArray(arr)) throw new Error("not array");
      // 既存と統合（key重複は上書き、無いものだけ追加）
      const map = new Map(favorites.map((f) => [f.key, f]));
      let added = 0;
      for (const f of arr) {
        if (f && f.key && f.quiz) {
          if (!map.has(f.key)) added++;
          map.set(f.key, f);
        }
      }
      const merged = Array.from(map.values()).sort(
        (a, b) => b.savedAt - a.savedAt,
      );
      persistFavorites(merged);
      setSyncMsg(
        `読み込み完了：${added}件を追加しました（合計${merged.length}件）。`,
      );
      setImportText("");
      setShowImport(false);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setSyncMsg(
        `コードを読み取れませんでした（${reason}）。コード全体（YTL1:…）が途中で切れていないか確認してください。`,
      );
    }
  }

  // 保存済みの問題を再現（APIを呼ばず保存した内容をそのまま復元）
  function openFavorite(fav: Favorite) {
    setError(null);
    setAnswers({});
    setGraded(false);
    setShowEn(false);
    setShowJa(false);
    setQuiz(fav.quiz);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEditOrigin(v: { id: string; origin?: string }) {
    setEditingId(v.id);
    setDraft(v.origin || "");
  }

  async function saveOrigin(id: string) {
    try {
      const res = await fetch("/api/origin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, origin: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存に失敗しました");
      setVids((arr) =>
        arr.map((x) =>
          x.id === id ? { ...x, origin: data.origin || undefined } : x,
        ),
      );
      setEditingId(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存に失敗しました");
    }
  }

  // 生成中は進行メッセージを巡回（固まって見えないように）
  useEffect(() => {
    if (!loading) return;
    setLoadingStep(0);
    const t = setInterval(
      () => setLoadingStep((s) => (s + 1) % LOADING_MSGS.length),
      1800,
    );
    return () => clearInterval(t);
  }, [loading]);

  // targetUrl 指定でその動画、空ならプールからランダム出題。
  async function generate(targetUrl = "") {
    setLoading(true);
    setError(null);
    setQuiz(null);
    setAnswers({});
    setGraded(false);
    setShowEn(false);
    setShowJa(false);
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "生成に失敗しました");
      setQuiz(data as Quiz);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラー");
    } finally {
      setLoading(false);
    }
  }

  const score =
    quiz && graded
      ? quiz.questions.filter((q, i) => answers[i] === q.answerIndex).length
      : 0;

  const isFav = !!quiz && favorites.some((f) => f.key === favKeyOf(quiz));

  // 設問やスクリプトをクリップボードにコピー（ネット検索用）
  const [copied, setCopied] = useState<string | null>(null);
  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">🎧 1分 英語リスニング</h1>
      <p className="mt-1 text-sm text-gray-500">
        英語字幕付きのYouTube動画から約1分を抽出し、AIがTOEIC風の3問を作成します。
      </p>

      <div className="mt-6">
        <button
          onClick={() => generate()}
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 active:bg-gray-900 disabled:opacity-70 disabled:hover:bg-black sm:w-auto"
        >
          {loading && (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {loading ? "生成中…" : "🎲 ランダムで出題"}
        </button>
      </div>

      {/* 生成中の進行表示（固まって見えないように） */}
      {loading && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-gray-50 px-4 py-3 text-sm text-gray-600">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
          <span>{LOADING_MSGS[loadingStep]}</span>
          <span className="text-xs text-gray-400">（10秒ほどかかることがあります）</span>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* お気に入りの問題（この端末に保存）。出題中は隠す。 */}
      {!quiz && favorites.length > 0 && (
        <div className="mt-8">
          <p className="mb-2 text-xs text-gray-400">
            ⭐ お気に入りの問題（この端末に保存・タップで再現）
          </p>
          <div className="space-y-2">
            {favorites.map((f) => (
              <div
                key={f.key}
                className="flex items-center gap-3 rounded-lg border border-gray-200 p-2 transition hover:border-gray-300 hover:bg-gray-50"
              >
                <button
                  onClick={() => openFavorite(f)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`https://img.youtube.com/vi/${f.quiz.videoId}/mqdefault.jpg`}
                    alt={f.title}
                    loading="lazy"
                    className="h-12 w-20 shrink-0 rounded object-cover"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-xs leading-snug text-gray-700">
                      {f.title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {fmtTime(f.quiz.start)}–{fmtTime(f.quiz.end)} ・ 全
                      {f.quiz.questions.length}問
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => openFavorite(f)}
                  className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
                >
                  解く
                </button>
                <button
                  onClick={() =>
                    setConfirmDel({ key: f.key, title: f.title })
                  }
                  aria-label="お気に入りから削除"
                  className="shrink-0 rounded-md px-2 py-1.5 text-sm text-gray-400 transition hover:bg-red-50 hover:text-red-600"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* お気に入りの端末間コピー（書き出し/読み込みコード）。出題中は隠す。 */}
      {!quiz && (
        <div className="mt-4 rounded-lg border border-dashed border-gray-200 p-3">
          <p className="mb-2 text-[11px] text-gray-400">
            🔄 別の端末とお気に入りを移す（コードで書き出し→貼り付け）
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={exportFavorites}
              disabled={favorites.length === 0}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-40"
            >
              📤 書き出し（{favorites.length}件をコピー）
            </button>
            <button
              onClick={() => setShowImport((s) => !s)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
            >
              📥 読み込み（貼り付け）
            </button>
          </div>
          {showImport && (
            <div className="mt-2 space-y-2">
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={3}
                // iOSの自動修正・スマート表記変換がコードを壊すので全て切る
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                placeholder="ここに別端末で書き出した同期コード（YTL1:…）を貼り付け"
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-gray-500"
              />
              <button
                onClick={importFavorites}
                disabled={!importText.trim()}
                className="rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-800 active:bg-gray-900 disabled:opacity-40 disabled:hover:bg-black"
              >
                読み込む
              </button>
            </div>
          )}
          {syncMsg && (
            <p className="mt-2 text-[11px] text-gray-500">{syncMsg}</p>
          )}
        </div>
      )}

      {/* キャッシュ済み動画の一覧（YouTubeアプリ風サムネ）。出題中は隠す。 */}
      {!quiz && CACHED_VIDEOS.length > 0 && (
        <div className="mt-8">
          <p className="mb-2 text-xs text-gray-400">
            キャッシュ済みの動画（サムネ＝出題・下のバー＝YouTube）
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {vids.map((v) => (
              <div
                key={v.id}
                className="group flex flex-col overflow-hidden rounded-lg border border-gray-200 transition hover:border-gray-400 hover:shadow-sm"
              >
                {/* サムネ＋タイトル＝タップで出題 */}
                <button
                  onClick={() => generate(`https://youtu.be/${v.id}`)}
                  disabled={loading}
                  className="block flex-1 text-left disabled:opacity-60"
                >
                  <div className="relative aspect-video bg-gray-100">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`https://img.youtube.com/vi/${v.id}/mqdefault.jpg`}
                      alt={v.title}
                      loading="lazy"
                      className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                    />
                  </div>
                  <p className="px-2 pt-1.5 text-xs leading-snug text-gray-700 line-clamp-2">
                    {v.title}
                  </p>
                </button>

                {/* 出身（origin）。dev時は編集可、本番は表示のみ */}
                {IS_DEV ? (
                  editingId === v.id ? (
                    <div className="flex items-center gap-1 px-2 pb-1.5 pt-1">
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveOrigin(v.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        placeholder="🇬🇧 ロンドン出身"
                        className="w-full flex-1 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] outline-none focus:border-gray-500"
                      />
                      <button
                        onClick={() => saveOrigin(v.id)}
                        className="shrink-0 rounded bg-gray-900 px-1.5 py-0.5 text-[11px] text-white"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        aria-label="キャンセル"
                        className="shrink-0 rounded px-1 text-[11px] text-gray-400 hover:text-gray-700"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => startEditOrigin(v)}
                      className="px-2 pb-1.5 pt-1 text-left text-[11px]"
                    >
                      {v.origin ? (
                        <span className="text-gray-500">
                          {v.origin}{" "}
                          <span className="text-blue-500">✏️</span>
                        </span>
                      ) : (
                        <span className="text-blue-500">＋ 出身を追加</span>
                      )}
                    </button>
                  )
                ) : (
                  v.origin && (
                    <p className="px-2 pb-1.5 pt-1 text-[11px] text-gray-500">
                      {v.origin}
                    </p>
                  )
                )}

                {/* YouTubeで開く（全幅バー＝指で押しやすい・別タブ） */}
                <a
                  href={`https://www.youtube.com/watch?v=${v.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="YouTubeで開く"
                  className="flex items-center justify-center gap-1.5 border-t border-gray-200 bg-gray-50 py-2.5 text-xs font-medium text-gray-600 transition active:bg-gray-200 hover:bg-red-50 hover:text-red-600"
                >
                  <span className="text-red-600">▶</span> YouTubeで開く
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {quiz && (
        <div className="mt-8 space-y-6">
          {/* 一覧に戻る ＋ お気に入り保存 */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setQuiz(null)}
              className="rounded-md px-2 py-1.5 text-sm text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"
            >
              ← 一覧に戻る
            </button>
            <button
              onClick={toggleFavorite}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${
                isFav
                  ? "border-amber-400 bg-amber-50 text-amber-700"
                  : "border-gray-300 hover:bg-gray-50"
              }`}
            >
              {isFav ? "★ お気に入り済み" : "☆ お気に入りに追加"}
            </button>
          </div>

          {/* 区間プレーヤー（全編再生可＋ワンクリックで区間に頭出し） */}
          <SegmentPlayer
            key={`${quiz.videoId}-${quiz.start}`}
            videoId={quiz.videoId}
            start={quiz.start}
            end={quiz.end}
          />

          {/* この問題の生成にかかったAPIコスト */}
          {quiz.cost && (
            <p className="text-right text-[11px] text-gray-400">
              生成コスト 約{quiz.cost.jpy.toFixed(2)}円
              <span className="ml-1">
                （${quiz.cost.usd.toFixed(4)} / in {quiz.cost.inputTokens.toLocaleString()}・out{" "}
                {quiz.cost.outputTokens.toLocaleString()} tok）
              </span>
            </p>
          )}

          {/* スクリプト / 日本語訳トグル */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setShowEn((s) => !s)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  showEn ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 hover:bg-gray-50"
                }`}
              >
                📜 英語スクリプト
              </button>
              <button
                onClick={() => setShowJa((s) => !s)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  showJa ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 hover:bg-gray-50"
                }`}
              >
                🇯🇵 日本語訳
              </button>
            </div>
            {showEn && (
              <div className="rounded-md bg-gray-50 px-4 py-3">
                <p className="select-text text-sm leading-relaxed text-gray-800">
                  {quiz.transcript}
                </p>
                <button
                  onClick={() => copyText(quiz.transcript, "en")}
                  className="mt-2 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-50"
                >
                  {copied === "en" ? "✓ コピーしました" : "📋 スクリプトをコピー"}
                </button>
              </div>
            )}
            {showJa && (
              <p className="rounded-md bg-amber-50 px-4 py-3 text-sm leading-relaxed text-gray-800">
                {quiz.transcriptJa || "（日本語訳がありません）"}
              </p>
            )}
          </div>

          {/* 設問 */}
          <div className="space-y-6">
            {quiz.questions.map((q, qi) => (
              <div key={qi} className="rounded-lg border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="select-text font-medium">
                    Q{qi + 1}. {q.question}
                  </p>
                  <button
                    onClick={() =>
                      copyText(
                        `Q${qi + 1}. ${q.question}\n` +
                          q.options
                            .map(
                              (o, oi) => `${String.fromCharCode(65 + oi)}. ${o}`,
                            )
                            .join("\n"),
                        `q${qi}`,
                      )
                    }
                    className="shrink-0 rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-50"
                  >
                    {copied === `q${qi}` ? "✓ コピー" : "📋 コピー"}
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {q.options.map((opt, oi) => {
                    const chosen = answers[qi] === oi;
                    const correct = q.answerIndex === oi;
                    let cls = "border-gray-200 hover:border-gray-400 hover:bg-gray-50 active:scale-[0.99]";
                    if (graded && correct) cls = "border-green-500 bg-green-50";
                    else if (graded && chosen && !correct) cls = "border-red-500 bg-red-50";
                    else if (chosen)
                      cls = "border-gray-900 bg-gray-900 font-medium text-white shadow-sm";
                    return (
                      <button
                        key={oi}
                        disabled={graded}
                        onClick={() =>
                          setAnswers((a) => {
                            // 同じ選択肢をもう一度押したら未選択に戻す
                            if (a[qi] === oi) {
                              const next = { ...a };
                              delete next[qi];
                              return next;
                            }
                            return { ...a, [qi]: oi };
                          })
                        }
                        className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition ${cls}`}
                      >
                        <span
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                            chosen && !graded ? "border-white" : "border-gray-300"
                          }`}
                        >
                          {String.fromCharCode(65 + oi)}
                        </span>
                        <span className="select-text">{opt}</span>
                      </button>
                    );
                  })}
                </div>
                {graded && (
                  <p className="mt-3 text-xs text-gray-600">💡 {q.explanation}</p>
                )}
              </div>
            ))}
          </div>

          {!graded ? (
            <button
              onClick={() => setGraded(true)}
              disabled={Object.keys(answers).length < quiz.questions.length}
              className="rounded-md bg-black px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 active:bg-gray-900 disabled:opacity-50 disabled:hover:bg-black"
            >
              採点する
            </button>
          ) : (
            <p className="text-lg font-bold">
              スコア: {score} / {quiz.questions.length}
            </p>
          )}
        </div>
      )}

      {/* お気に入り削除の確認モーダル */}
      {confirmDel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmDel(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium text-gray-900">
              このお気に入りを削除しますか？
            </p>
            <p className="mt-1 line-clamp-2 text-xs text-gray-500">
              {confirmDel.title}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDel(null)}
                className="rounded-md border border-gray-300 px-4 py-1.5 text-sm transition hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={() => {
                  removeFavorite(confirmDel.key);
                  setConfirmDel(null);
                }}
                className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-red-700"
              >
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
