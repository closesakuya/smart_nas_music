import { useState } from "react";
import { LoaderCircle } from "lucide-react";

type Result = { source: string; message?: string; matches: unknown[]; sources?: { title: string; url: string; text: string }[] };
export function OnlineMetadata({ load }: { load: () => Promise<Result> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  return <div className="online-metadata">
    <button className="secondary" disabled={busy} onClick={async () => {
      setBusy(true); setError(""); setResult(null);
      try { setResult(await load()); } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? "正在查询联网资料…" : "联网资料"}</button>
    {error && <p role="alert" className="similar-error">歌曲联网资料：{error}</p>}
    {result && <div className="online-results"><p className="muted">{result.message || "MusicBrainz 匹配结果（未自动修改标签）"}</p>
      {result.sources?.map(s => <article key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || "查看来源"} ↗</a><p>{s.text.slice(0, 600)}</p></article>)}
      {result.source === "web" && !result.sources?.length && <p>未找到可用的网页资料。</p>}
      {result.source === "musicbrainz" && <details open><summary>录音匹配 · {result.matches.length} 条</summary><pre>{JSON.stringify(result.matches, null, 2)}</pre></details>}
    </div>}
  </div>;
}
