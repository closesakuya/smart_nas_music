using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace SummerMusic;

internal sealed class NativePlayer : IDisposable
{
    private IWavePlayer? output;
    private WaveFileReader? reader;
    private MMDevice? endpoint;
    private readonly PlaybackLifecycle lifecycle = new();
    private EventHandler? resetHandler;
    public int Generation => lifecycle.Version;
    public string Mode { get; private set; } = "shared";
    public string Device { get; private set; } = "";
    public bool Armed { get; private set; }
    public string Format { get; private set; } = "尚未播放";
    public bool Paused => output?.PlaybackState != PlaybackState.Playing;
    public double Position => reader?.CurrentTime.TotalSeconds ?? 0;
    public double Duration => reader?.TotalTime.TotalSeconds ?? 0;
    public event Action<int, string?>? Ended;
    public static object[] Devices()
    {
        var result = new List<object>();
        using var enumerator = new MMDeviceEnumerator();
        foreach (var item in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (item) result.Add(new { id = item.ID, name = item.FriendlyName, kind = "wasapi" });
        }
        foreach (var name in AsioOut.GetDriverNames()) result.Add(new { id = name, name, kind = "asio" });
        return result.ToArray();
    }
    public void Configure(string mode, string device, bool armed)
    {
        if (mode is not ("shared" or "exclusive" or "asio")) throw new InvalidOperationException("不支持的输出模式");
        if (!armed) throw new InvalidOperationException("请先调低 DAC 硬件音量，并在输出设置中确认。");
        if (mode == "asio" && !AsioOut.GetDriverNames().Contains(device)) throw new InvalidOperationException("未找到所选 64 位 ASIO 驱动。");
        if (mode != "asio" && device != "") { using var enumerator = new MMDeviceEnumerator(); using var check = enumerator.GetDevice(device); if (check.State != DeviceState.Active) throw new InvalidOperationException("输出设备不可用。"); }
        Close(); Mode = mode; Device = device; Armed = true;
    }
    public void Open(string path)
    {
        if (!Armed) throw new InvalidOperationException("请先点击右下角「本机 DAC 输出」，选择设备并确认硬件音量。");
        Close();
        try
        {
            reader = new WaveFileReader(path);
            var source = reader.WaveFormat;
            var generation = Generation;
            if (Mode == "asio")
            {
                var asio = new AsioOut(Device);
                output = asio;
                if (!asio.IsSampleRateSupported(source.SampleRate)) throw new InvalidOperationException("ASIO 驱动不支持原采样率；未进行重采样或自动降级。");
                if (source.Channels > asio.DriverOutputChannelCount) throw new InvalidOperationException("ASIO 输出通道数量不足。");
                // Do not stop/dispose the driver on its audio callback thread.
                asio.AutoStop = false;
                asio.Init(reader);
                // Init may set sample rate and legitimately reset the driver. Subscribe afterwards.
                resetHandler = (_, _) => { if (ReferenceEquals(output, asio)) lifecycle.RequestReset(generation); };
                asio.DriverResetRequest += resetHandler;
                Format = $"ASIO · {Device} · {source.SampleRate} Hz / PCM {source.BitsPerSample} bit / {source.Channels} ch（驱动缓冲格式由驱动决定）";
            }
            else
            {
                using var enumerator = new MMDeviceEnumerator();
                endpoint = Device == "" ? enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia) : enumerator.GetDevice(Device);
                var shareMode = Mode == "exclusive" ? AudioClientShareMode.Exclusive : AudioClientShareMode.Shared;
                // NAudio can silently find another exclusive format. Reject before Init instead.
                if (shareMode == AudioClientShareMode.Exclusive && !endpoint.AudioClient.IsFormatSupported(shareMode, source))
                    throw new InvalidOperationException($"DAC 不支持 {source.SampleRate} Hz / {source.BitsPerSample} bit / {source.Channels} ch 独占格式；没有自动重采样。可选择共享模式。");
                var wasapi = new WasapiOut(endpoint, shareMode, true, 150);
                output = wasapi;
                wasapi.Init(reader);
                var actual = wasapi.OutputWaveFormat;
                if (shareMode == AudioClientShareMode.Exclusive && (actual.SampleRate != source.SampleRate || actual.BitsPerSample != source.BitsPerSample || actual.Channels != source.Channels))
                    throw new InvalidOperationException("驱动协商格式与源不一致，已拒绝独占播放。");
                Format = $"WASAPI {(Mode == "exclusive" ? "独占" : "共享（系统可能混音）")} · {endpoint.FriendlyName} · {actual.SampleRate} Hz / {actual.BitsPerSample} bit / {actual.Channels} ch";
            }
            var instance = output;
            output.PlaybackStopped += (_, e) => {
                if (output == instance && generation == Generation && (e.Exception != null || Position >= Duration - .1) && lifecycle.Complete(generation))
                    Ended?.Invoke(generation, e.Exception?.Message);
            };
        }
        catch { Close(); throw; }
    }
    public void Play() { if (output == null) throw new InvalidOperationException("请先选择歌曲和输出设备。"); lifecycle.Rearm(); output.Play(); }
    public bool TakeResetRequest() => lifecycle.TakeReset();
    public void PollEnd()
    {
        // ASIO AutoStop=false fills silence at EOF and does not raise PlaybackStopped.
        // Poll the real EOF flag on the UI thread, stop once, then notify the queue.
        if (output is AsioOut asio && asio.PlaybackState == PlaybackState.Playing && asio.HasReachedEnd && lifecycle.Complete(Generation))
        {
            var generation = Generation;
            asio.Stop();
            Ended?.Invoke(generation, null);
        }
    }
    public void Pause() => output?.Pause();
    public void Seek(double seconds)
    {
        if (reader == null || !double.IsFinite(seconds)) return;
        // Pause during repositioning; only decoded PCM is sought, never the original file.
        var playing = !Paused; output?.Pause();
        reader.CurrentTime = TimeSpan.FromSeconds(Math.Clamp(seconds, 0, Duration));
        lifecycle.Rearm();
        if (playing) output?.Play();
    }
    public void Close()
    {
        lifecycle.Advance();
        var old = output; output = null;
        if (old is AsioOut asio && resetHandler != null) asio.DriverResetRequest -= resetHandler;
        resetHandler = null;
        if (old != null) { try { old.Stop(); } finally { old.Dispose(); } }
        reader?.Dispose(); reader = null; endpoint?.Dispose(); endpoint = null;
    }
    public void Dispose() => Close();
}
