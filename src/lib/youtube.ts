// YouTube URL / ID 関連のユーティリティ

/** さまざまな形式のYouTube URL・IDから 11桁の videoId を取り出す */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  // すでに11桁のIDっぽい
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const url = new URL(s);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1);
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (url.hostname.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      // /embed/xxxx や /shorts/xxxx
      const m = url.pathname.match(/\/(embed|shorts)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    // URLではない
  }
  return null;
}

/** start〜end（秒）の区間だけ再生する埋め込みURL */
export function embedUrl(videoId: string, start: number, end: number): string {
  const s = Math.max(0, Math.floor(start));
  const e = Math.max(s + 1, Math.ceil(end));
  const params = new URLSearchParams({
    start: String(s),
    end: String(e),
    rel: "0",
    modestbranding: "1",
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}
