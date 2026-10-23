import { useState } from "react";
import { LoaderCircle, Sparkles, X } from "lucide-react";
import { RecommendationCard, type QueueAction } from "./RecommendationCard";

type Song = { id: string; title: string; artist: string };
export type ExternalSong = { title: string; artist: string; album: string; reason: string; sources: { title: string; url: string }[]; playable: false };
export type SimilarResult<T> = { message: string; tracks: T[]; external_tracks: ExternalSong[]; source: "library" | "web"; seed_count: number };
export function SimilarityPanel<T extends Song>({ label, count, onClose, onRecommend, onQueue, onSave }: {
  label: string; count: number; onClose: () => void; onRecommend: (online: boolean) => Promise<SimilarResult<T>>;
  onQueue: (songs: T[], mode: QueueAction) => void; onSave: (songs: T[]) => void;
}) {
  const [online, setOnline] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<SimilarResult<T> | null>(null);
  async function recommend() {
    setBusy(true); setError(""); setResult(null);
    try { setResult(await onRecommend(online)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={onClose}><section className="modal similarity-modal" role="dialog" aria-label="AI 相似音乐" onClick={e => e.stopPropagation()}>
    <div className="panel-title"><h3><Sparkles size={20} /> AI 相似音乐</h3><button className="icon-button" aria-label="关闭相似推荐" onClick={onClose}><X size={19} /></button></div>
    <p className="muted">参考：{label} · {count} 首。使用打开面板时的曲目，不随浏览目录改变。</p>
    <label className="similar-online"><input type="checkbox" checked={online} disabled={busy} onChange={e => { setOnline(e.target.checked); setResult(null); setError(""); }} />网络搜索：寻找音乐库中没有的歌曲（仅信息）</label>
    <p className="muted">{online ? "调用 DeepSeek 网络搜索，显示歌手、专辑、歌曲及来源；不提供音源，不会加入播放队列。" : "默认只从整个本地音乐库挑选相似风格，可播放、加入队列或保存歌单；不自动替换当前播放。"}</p>
    <button className="primary" disabled={busy} onClick={() => void recommend()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{busy ? "正在寻找相似音乐…" : "推荐相似音乐"}</button>
    {error && <p className="similar-error" role="alert">{error}</p>}
    {result && <><p className="similar-summary">{result.message}</p>
      {result.source === "library" && result.tracks.length > 0 && <RecommendationCard tracks={result.tracks} onQueue={onQueue} onSave={onSave} />}
      {result.source === "web" && <div className="external-recommendations">{result.external_tracks.map((song, i) => <article key={song.title + song.artist + i}>
        <span className="eyebrow">网络资料 · 无本地音源</span><h4>{song.title}</h4><p>{song.artist}</p><p>专辑：{song.album || "来源未明确提供"}</p>
        <small>{song.reason}</small><div>{song.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title || "查看来源"} ↗</a>)}</div>
      </article>)}</div>}
    </>}
  </section></div>;
}
