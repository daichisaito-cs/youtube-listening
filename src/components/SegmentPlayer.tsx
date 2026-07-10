"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";

// YouTube IFrame Player API をモジュール単位で1回だけロード
let apiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  // すでに利用可能
  // @ts-expect-error YT はAPIが注入するグローバル
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve) => {
    const prev = (window as unknown as { onYouTubeIframeAPIReady?: () => void })
      .onYouTubeIframeAPIReady;
    (window as unknown as { onYouTubeIframeAPIReady: () => void }).onYouTubeIframeAPIReady =
      () => {
        prev?.();
        resolve();
      };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiPromise;
}

interface Props {
  videoId: string;
  start: number; // 秒
  end: number; // 秒
}

export default function SegmentPlayer({ videoId, start, end }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerRef = useRef<any>(null);
  const segmentModeRef = useRef(false);
  const repeatRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [playing, setPlaying] = useState(false); // 区間再生中か
  const [remaining, setRemaining] = useState<number | null>(null); // 残り秒（表示用・整数）
  const [progress, setProgress] = useState(0); // 経過の割合 0..1（バー用・小数で滑らか）
  const [scrubbing, setScrubbing] = useState(false); // バーをドラッグ中か（トランジション制御）
  const scrubbingRef = useRef(false); // 監視ループ側で参照（ドラッグ中は自動更新を止める）
  const trackRef = useRef<HTMLDivElement>(null); // バー実体（座標計算用）

  const total = Math.max(0, end - start); // 区間の総尺（秒）

  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);

  // プレーヤー生成（videoIdが変わったら作り直す）
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    loadYouTubeApi().then(() => {
      if (disposed || !holderRef.current) return;
      // @ts-expect-error グローバルYT
      playerRef.current = new window.YT.Player(holderRef.current, {
        videoId,
        playerVars: {
          start: Math.floor(start), // 初期位置を区間頭に（end は入れない＝全編再生可）
          rel: 0,
          modestbranding: 1,
        },
        events: {
          onReady: () => {
            if (!disposed) setReady(true);
          },
        },
      });

      // 250msごとに区間終端を監視（区間再生モード中のみ作用）
      timer = setInterval(() => {
        const p = playerRef.current;
        if (!p || !segmentModeRef.current || typeof p.getCurrentTime !== "function") return;
        if (scrubbingRef.current) return; // ドラッグ中は監視を止める（バーがカクつかないように）
        const t = p.getCurrentTime();
        // 経過（小数）をそのままバーに、残り秒（整数）をテキストに
        const elapsedRaw = Math.min(total, Math.max(0, t - start));
        setProgress(total > 0 ? elapsedRaw / total : 0);
        setRemaining(Math.ceil(total - elapsedRaw));
        if (t >= end) {
          if (repeatRef.current) {
            p.seekTo(start, true);
          } else {
            p.pauseVideo();
            segmentModeRef.current = false;
            setPlaying(false);
            setRemaining(0);
            setProgress(1);
          }
        }
      }, 250);
    });

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      try {
        playerRef.current?.destroy?.();
      } catch {
        // noop
      }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // 区間（start/end）だけ変わった場合は頭出ししておく
  useEffect(() => {
    const p = playerRef.current;
    if (ready && p?.seekTo) {
      segmentModeRef.current = false;
      setPlaying(false);
      setRemaining(null);
      setProgress(0);
      p.seekTo(Math.floor(start), true);
      p.pauseVideo?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, ready]);

  function playSegment() {
    const p = playerRef.current;
    if (!p?.seekTo) return;
    segmentModeRef.current = true;
    setPlaying(true);
    setRemaining(Math.ceil(total));
    setProgress(0);
    p.seekTo(start, true);
    p.playVideo();
  }

  // ポインタ位置から区間内の割合(0..1)を求める
  function fracFromEvent(e: React.PointerEvent): number {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  // 指定割合の位置へシーク（表示も即時更新）
  function seekToFrac(f: number) {
    const p = playerRef.current;
    if (!p?.seekTo) return;
    segmentModeRef.current = true;
    setProgress(f);
    setRemaining(Math.ceil(total * (1 - f)));
    p.seekTo(start + total * f, true);
  }

  function onScrubStart(e: React.PointerEvent) {
    if (!ready) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    scrubbingRef.current = true;
    setScrubbing(true);
    seekToFrac(fracFromEvent(e));
  }

  function onScrubMove(e: React.PointerEvent) {
    if (!scrubbingRef.current) return;
    seekToFrac(fracFromEvent(e));
  }

  function onScrubEnd(e: React.PointerEvent) {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    setScrubbing(false);
    seekToFrac(fracFromEvent(e));
    setPlaying(true);
    playerRef.current?.playVideo?.(); // 飛んだ位置から再生
  }

  return (
    <div className="space-y-2">
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
        {/* YT.Player がこの div を iframe に置き換える */}
        <div ref={holderRef} className="h-full w-full" />
      </div>
      {/* リスニング用 残り時間タイマー＋プログレスバー */}
      {(() => {
        const rem = remaining ?? total; // 未再生は総尺を表示
        const elapsed = Math.max(0, total - rem);
        const pct = Math.min(100, progress * 100); // バーは小数の経過割合で滑らかに
        const nearEnd = playing && rem <= 5; // ラスト5秒は赤で警告
        return (
          <div className="space-y-1">
            <div className="text-right text-sm">
              <span className={`font-mono text-xs tabular-nums ${nearEnd ? "text-red-600" : "text-gray-400"}`}>
                {fmt(elapsed)} / {fmt(total)}
              </span>
            </div>
            {/* クリック/ドラッグでその位置にシーク。当たり判定を広げるため上下に余白 */}
            <div
              className={`group -my-2 py-2 ${ready ? "cursor-pointer" : "cursor-default"}`}
              onPointerDown={onScrubStart}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubEnd}
              role="slider"
              aria-label="再生位置"
              aria-valuemin={0}
              aria-valuemax={Math.round(total)}
              aria-valuenow={Math.round(total * progress)}
            >
              <div
                ref={trackRef}
                className="relative h-1.5 w-full rounded-full bg-gray-200 group-hover:h-2"
              >
                <div
                  className={`h-full rounded-full ${
                    scrubbing ? "" : "transition-[width] duration-[250ms] ease-linear"
                  } ${nearEnd ? "bg-red-500" : "bg-black"}`}
                  style={{ width: `${pct}%` }}
                />
                {/* つまみ（ホバー/ドラッグ時に表示） */}
                <div
                  className={`pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-gray-400 transition-opacity ${
                    scrubbing ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  } ${nearEnd ? "ring-red-500" : ""}`}
                  style={{ left: `${pct}%` }}
                />
              </div>
            </div>
          </div>
        );
      })()}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={playSegment}
          disabled={!ready}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          ▶ 出題区間を再生（{fmt(start)}〜{fmt(end)}）
        </button>
        <label className="flex items-center gap-1.5 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={repeat}
            onChange={(e) => setRepeat(e.target.checked)}
          />
          🔁 区間をリピート
        </label>
        <span className="text-xs text-gray-400">
          ※ 動画は全編シークできます。ボタンで区間に頭出し＆自動停止。
        </span>
      </div>
    </div>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
