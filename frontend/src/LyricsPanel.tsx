import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
export function parseLyrics(text: string) {
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  const timed: { time: number; text: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const match of matches) timed.push({ time: Number(match[1]) * 60 + Number(match[2]) + Number('0.' + (match[3] || '0')) + offset, text: words });
  }
  return timed.sort((a, b) => a.time - b.time);
}
export function LyricsPanel({ id, title, position, onClose }: { id: string; title: string; position: number; onClose: () => void }) {
  const [result, setResult] = useState<{ text: string; source: string; offset: number } | null>(null), [error, setError] = useState('');
  const activeLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setResult(null); setError('');
    fetch(`/api/tracks/${id}/lyrics`, { signal: controller.signal }).then(async r => { if (!r.ok) throw new Error('歌词读取失败，请重新登录或重试'); return r.json(); }).then(setResult).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [id]);
  const lines = useMemo(() => parseLyrics(result?.text || ''), [result?.text]);
  const time = position + (result?.offset || 0);
  const active = lines.findIndex((line, i) => line.time <= time && (!lines[i + 1] || lines[i + 1].time > time));
  useEffect(() => {
    const line = activeLine.current, scroll = line?.parentElement;
    if (line && scroll) scroll.scrollTo({ top: scroll.scrollTop + line.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2 + line.clientHeight / 2, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [active]);
  return <section className="lyrics-panel" aria-label="当前歌曲歌词"><div className="panel-title"><h3>{title}</h3><button className="icon-button" aria-label="关闭歌词" onClick={onClose}><X size={18} /></button></div>
    <small>{result?.source || error || '正在读取歌词…'}</small><div className="lyrics-scroll">
      {lines.length ? lines.map((line, i) => <p key={i} ref={active === i ? activeLine : undefined} className={active === i ? 'active' : ''}>{line.text || '♪'}</p>) : <p className="plain-lyrics">{result?.text || (result ? '此曲暂无歌词。支持音源内嵌歌词、同目录同名 .lrc 文件。' : '')}</p>}
    </div></section>;
}
