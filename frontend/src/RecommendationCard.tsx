import { useState } from "react";
import { Play, Plus } from "lucide-react";
export type QueueAction = "next" | "append" | "replace" | "play";
type Song = { id: string; title: string; artist: string };
export function RecommendationCard<T extends Song>({ tracks, onQueue, onSave, onApply, action }: {
  tracks: T[]; onQueue: (tracks: T[], mode: QueueAction) => void; onSave: (tracks: T[]) => void;
  onApply?: () => void; action?: string;
}) {
  const [checked, setChecked] = useState<string[]>([]), [target, setTarget] = useState("all");
  const chosen = target === "all" ? tracks : tracks.filter(t => checked.includes(t.id));
  return <div className="recommendation">
    <span className="eyebrow">{tracks.length} 首 · 为此刻而选</span>
    <div className="recommendation-selection"><select aria-label="推荐操作范围" value={target} onChange={e => setTarget(e.target.value)}><option value="all">全部 {tracks.length} 首</option><option value="selected">已选 {checked.length} 首</option></select>
      <button className="text-button" onClick={() => { setChecked(checked.length === tracks.length ? [] : tracks.map(t => t.id)); setTarget("selected"); }}>{checked.length === tracks.length ? "取消全选" : "全选"}</button></div>
    <div className="recommendation-list">{tracks.map(t => <div className="recommended-item" key={t.id}>
      <input type="checkbox" aria-label={`选择 ${t.title}`} checked={checked.includes(t.id)} onChange={e => { setTarget("selected"); setChecked(ids => e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id)); }} />
      <button className="recommended-track" title={`立即播放 ${t.title}（保留其他队列）`} onClick={() => onQueue([t], "play")}><span><strong>{t.title}</strong><small>{t.artist}</small></span><Play size={14} /></button>
      <select aria-label={`操作 ${t.title}`} value="" onChange={e => { if (e.target.value === "save") onSave([t]); else onQueue([t], e.target.value as QueueAction); }}><option value="" disabled>＋</option><option value="next">插到当前歌曲后</option><option value="append">追加队尾</option><option value="save">加入歌单…</option></select>
    </div>)}</div>
    <div className="recommendation-actions batch-actions">
      <button className="secondary" disabled={!chosen.length} onClick={() => onQueue(chosen, "next")}>插到当前歌曲后</button>
      <button className="secondary" disabled={!chosen.length} onClick={() => onQueue(chosen, "append")}>追加队尾</button>
      <button className="secondary" disabled={!chosen.length} onClick={() => onQueue(chosen, "replace")}>替换队列并播放</button>
      <button className="primary" disabled={!chosen.length} onClick={() => onSave(chosen)}><Plus size={14} />加入歌单…</button>
    </div>
    {onApply && <button className="text-button" onClick={onApply}>{action === "replace" ? "确认 AI 提议：替换目标歌单" : "确认 AI 提议：追加目标歌单"}</button>}
  </div>;
}
