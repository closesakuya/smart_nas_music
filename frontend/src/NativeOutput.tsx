import { useEffect, useState } from "react";
import { Speaker, X } from "lucide-react";
import { nativeRequest } from "./nativeAudio";
type Device = { id: string; name: string; kind: string };
export function NativeOutput() {
  const [open, setOpen] = useState(false), [devices, setDevices] = useState<Device[]>([]);
  const [mode, setMode] = useState("shared"), [device, setDevice] = useState("");
  const [message, setMessage] = useState(""), [format, setFormat] = useState("尚未播放"), [busy, setBusy] = useState(false);
  const [safeVolume, setSafeVolume] = useState(false);
  useEffect(() => {
    const update = (event: Event) => setFormat((event as CustomEvent<string>).detail);
    window.addEventListener("native-format", update);
    return () => window.removeEventListener("native-format", update);
  }, []);
  async function refresh() {
    try { setDevices(await nativeRequest<Device[]>("devices")); }
    catch (error) { setMessage((error as Error).message); }
  }
  async function apply() {
    setBusy(true);
    try {
      await nativeRequest("configure", { mode, device, safeVolume });
      setMessage("输出已设置。请点击播放；切换模式会停止当前播放。原生输出不使用网页软件音量。");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="audio-output">
    <button className="icon-button" title="本机 DAC 输出" onClick={() => { setOpen(!open); if (!open) void refresh(); }}><Speaker size={19} /></button>
    {open && <section className="output-popover" role="dialog" aria-label="本机 DAC 输出">
      <div className="panel-title"><h3>PC 原生音频输出</h3><button className="icon-button" aria-label="关闭输出设备" onClick={() => setOpen(false)}><X size={18} /></button></div>
      <label>输出模式<select aria-label="原生输出模式" value={mode} disabled={busy} onChange={e => { setMode(e.target.value); setDevice(""); }}><option value="shared">WASAPI 共享</option><option value="exclusive">WASAPI 独占 · 原采样率</option><option value="asio">ASIO · 厂商驱动</option></select></label>
      <label>DAC / 音频设备<select aria-label="本机 DAC 设备" value={device} disabled={busy} onChange={e => setDevice(e.target.value)}>
        <option value="">{mode === "asio" ? "请选择 ASIO 驱动" : "系统默认输出"}</option>
        {devices.filter(d => d.kind === (mode === "asio" ? "asio" : "wasapi")).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select></label>
      {mode === "asio" && !devices.some(d => d.kind === "asio") && <p>未发现可用的 64 位 ASIO 驱动。请检查厂商驱动安装与 DAC 连接；Windows USB 音频驱动不一定包含 ASIO。</p>}
      <p>原生模式使用 100% 数字电平，请先调低 DAC / 功放硬件音量。独占或 ASIO 会占用设备；不支持的格式将报错，不自动降级。</p>
      <label><input type="checkbox" checked={safeVolume} onChange={e => setSafeVolume(e.target.checked)} /> 我已调低硬件音量，允许原生播放</label>
      <button className="primary" disabled={busy || !safeVolume || (mode === "asio" && !device)} onClick={() => void apply()}>应用输出设置</button>
      <button className="text-button" onClick={() => void refresh()}>刷新设备</button>
      <p>实际输出：{format}</p>{message && <p role="status">{message}</p>}
    </section>}
  </div>;
}
