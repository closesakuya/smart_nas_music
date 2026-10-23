type WebView = { postMessage(message: unknown): void; addEventListener(type: string, handler: (event: MessageEvent) => void): void };
declare global { interface Window { __SUMMER_NATIVE__?: boolean; chrome?: { webview?: WebView }; } }
export const isNative = !!window.__SUMMER_NATIVE__ && !!window.chrome?.webview;
const pending = new Map<string, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let sequence = 0;
export function nativeRequest<T = any>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!isNative) { reject(new Error("不是 PC 客户端")); return; }
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("本机音频引擎响应超时")); }, 20000);
    pending.set(id, { resolve, reject, timer });
    window.chrome!.webview!.postMessage({ id, command, ...args });
  });
}
let bound: HTMLAudioElement | null = null;
let time = 0, duration = 0, paused = true;
export let nativeError = "";
if (isNative) window.chrome!.webview!.addEventListener("message", ({ data }) => {
  if (data.id) {
    const request = pending.get(data.id);
    if (request) { clearTimeout(request.timer); pending.delete(data.id); data.error ? request.reject(new Error(data.error)) : request.resolve(data.result); }
  }
  if (data.type === "audio" && bound && (!data.trackId || data.trackId === bound.dataset.trackId)) {
    time = data.position ?? time;
    duration = data.duration ?? duration;
    paused = data.paused ?? paused;
    nativeError = data.error || "";
    if (data.event) bound.dispatchEvent(new Event(data.event));
    if (data.format) window.dispatchEvent(new CustomEvent("native-format", { detail: data.format }));
  }
});
export function bindNativeAudio(element: HTMLAudioElement | null) {
  if (!isNative || !element || bound === element) return;
  bound = element;
  const report = (error: Error) => { nativeError = error.message; element.dispatchEvent(new Event("error")); };
  Object.defineProperties(element, {
    currentTime: { configurable: true, get: () => time, set: (value: number) => { time = value; void nativeRequest("seek", { position: value }).catch(report); } },
    duration: { configurable: true, get: () => duration },
    paused: { configurable: true, get: () => paused },
    volume: { configurable: true, get: () => 1, set: () => {} },
  });
  element.load = () => { time = 0; duration = 0; paused = true; void nativeRequest("load", { trackId: element.dataset.trackId }).catch(report); };
  element.play = async () => { await nativeRequest("play"); };
  element.pause = () => { void nativeRequest("pause").catch(report); };
}
