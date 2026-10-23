import { useEffect, useState, type RefObject } from "react";
import { Speaker, X } from "lucide-react";

type SinkAudio = HTMLAudioElement & { setSinkId(id: string): Promise<void>; sinkId: string };
type OutputMedia = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };

export function AudioOutput({ audio }: { audio: RefObject<HTMLAudioElement | null> }) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const supported = window.isSecureContext && "setSinkId" in HTMLMediaElement.prototype && !!navigator.mediaDevices;
  const media = navigator.mediaDevices as OutputMedia | undefined;
  async function refresh() {
    if (!supported) return;
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput");
    setDevices(outputs.filter(d => d.deviceId && d.deviceId !== "default"));
    return outputs;
  }
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const changed = async () => {
      try {
        const outputs = await refresh();
        if (!active) return;
        const el = audio.current as SinkAudio | null;
        if (el?.sinkId && el.sinkId !== "default" && !outputs?.some(d => d.deviceId === el.sinkId)) {
          await el.setSinkId("");
          setSelected("");
          setMessage("输出设备已断开，已切回系统默认输出。");
        }
      } catch { if (active) setMessage("设备列表读取失败，请重新刷新或在系统声音设置中选择输出。"); }
    };
    void changed();
    media?.addEventListener("devicechange", changed);
    return () => { active = false; media?.removeEventListener("devicechange", changed); };
  }, [supported]);
  function errorText(error: unknown) {
    const name = (error as DOMException)?.name;
    return name === "NotAllowedError" ? "未获得设备权限，可重新授权或使用系统声音设置。"
      : name === "NotFoundError" ? "设备未连接或没有可授权的音频设备。"
      : name === "AbortError" ? "设备选择已取消，或设备暂时被占用。"
      : "无法切换输出，请检查设备连接与浏览器权限。";
  }
  async function choose(id: string) {
    const el = audio.current as SinkAudio | null;
    if (!el || !supported) return;
    setBusy(true);
    try { await el.setSinkId(id); setSelected(id); setMessage("输出已切换；音源质量保持不变。"); }
    catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }
  async function authorize() {
    setBusy(true);
    try {
      if (media?.selectAudioOutput) {
        const device = await media.selectAudioOutput();
        await refresh();
        await choose(device.deviceId);
      } else {
        // Chromium may expose additional output devices only after microphone permission.
        // Never request this automatically, retain a stream, record, or upload audio.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach(track => track.stop());
        await refresh();
        setMessage("设备列表已更新，麦克风访问已立即停止。请选择输出设备。");
      }
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  }
  return <div className="audio-output">
    <button className="icon-button" title="输出设备" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void refresh().catch(() => setMessage("无法读取设备列表")); }}><Speaker size={19} /></button>
    {open && <section className="output-popover" role="dialog" aria-label="输出设备">
      <div className="panel-title"><h3>当前 PC 的输出设备</h3><button className="icon-button" aria-label="关闭输出设备" onClick={() => setOpen(false)}><X size={18} /></button></div>
      {!supported ? <p>{!window.isSecureContext ? "当前局域网 HTTP 地址不允许网页访问音频设备。请使用 HTTPS；若浏览器就在服务器这台 PC 上，也可访问 http://localhost:8765。" : "此浏览器不支持网页切换输出，请在 Windows 音量混合器中选择浏览器的输出设备。"}</p> : <>
        <label>播放至<select aria-label="播放输出设备" disabled={busy} value={selected} onChange={e => void choose(e.target.value)}>
          <option value="">系统默认输出</option>
          {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `音频输出 ${i + 1}`}</option>)}
        </select></label>
        {!media?.selectAudioOutput && <p>显示更多设备可能需要麦克风授权，仅用于获取设备列表，授权后立即释放，不录音、不上传。</p>}
        <button className="primary" disabled={busy} onClick={() => void authorize()}>{busy ? "处理中…" : media?.selectAudioOutput ? "授权并选择设备" : "授权显示更多设备"}</button>
        <button className="text-button" disabled={busy} onClick={() => void refresh().catch(error => setMessage(errorText(error)))}>刷新设备</button>
        <p>网页模式使用浏览器音频链路，不是 WASAPI 独占或 ASIO。设备选择仅保留在本次页面会话中。</p>
      </>}
      {message && <p role="status">{message}</p>}
    </section>}
  </div>;
}
