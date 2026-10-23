using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SummerMusic;

internal sealed class PlayerWindow : Form
{
    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly NativePlayer player = new();
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 250 };
    private Uri server;
    private readonly Button serverSettings = new() { Text = "服务器设置", AutoSize = true };
    private readonly Button reconnect = new() { Text = "重新连接", AutoSize = true };
    private readonly Label serverLabel = new() { AutoSize = true, Padding = new Padding(10, 7, 0, 0) };
    private readonly Label connectionStatus = new() { Dock = DockStyle.Top, Height = 88, Padding = new Padding(16, 12, 16, 8), BackColor = Color.FromArgb(248, 241, 224), ForeColor = Color.FromArgb(95, 66, 24), Visible = false };
    private string? bridgeScript;
    private readonly string project, cache;
    private CancellationTokenSource? loading;
    private string? pcmPath;
    private string trackId = "";
    private bool wantsPlay, disposed;
    private double pendingSeek;
    private bool recovering;
    private int resetAttempts;
    public PlayerWindow(string project, Uri server)
    {
        if (server.Scheme is not ("http" or "https") || server.AbsolutePath != "/" || server.UserInfo != "" || server.Query != "" || server.Fragment != "") throw new InvalidOperationException("请配置受信任音乐服务的 HTTP/HTTPS 根地址，不允许 URL 凭据或参数。");
        this.project = project; this.server = server;
        cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SummerMusic", "pcm", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(cache);
        Text = "Summer Music · PC Hi-Fi · 0.3.0"; Width = 1440; Height = 950; MinimumSize = new Size(900, 650);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        Controls.Add(web);
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 43, Padding = new Padding(8, 5, 8, 3), BackColor = Color.FromArgb(239, 244, 233), WrapContents = false };
        toolbar.Controls.AddRange([serverSettings, reconnect, serverLabel]);
        Controls.Add(connectionStatus); Controls.Add(toolbar);
        serverLabel.Text = server.GetLeftPart(UriPartial.Authority);
        serverSettings.Enabled = reconnect.Enabled = false;
        serverSettings.Click += async (_, _) => {
            using var dialog = new ServerSettingsDialog(this.server);
            if (dialog.ShowDialog(this) == DialogResult.OK) {
                CancelLoad(); player.Close(); DeletePcm();
                this.server = dialog.SelectedServer;
                if (web.CoreWebView2 == null) await Initialize(); else await ConnectServer();
            }
        };
        reconnect.Click += async (_, _) => { if (web.CoreWebView2 == null) await Initialize(); else await ConnectServer(); };
        Shown += async (_, _) => await Initialize();
        timer.Tick += async (_, _) => {
            if (pcmPath == null || recovering) return;
            try {
                if (player.TakeResetRequest()) { await RecoverAsio(); return; }
                player.PollEnd(); Emit("timeupdate");
            } catch (Exception e) { wantsPlay = false; player.Close(); DeletePcm(); Emit("error", "本机驱动播放失败：" + e.Message); }
        };
        player.Ended += (generation, error) => {
            if (disposed) return;
            BeginInvoke(() => {
                if (disposed || generation != player.Generation || loading != null) return;
                wantsPlay = false;
                if (error != null) { player.Pause(); Emit("error", error); }
                else Emit("ended");
            });
        };
        FormClosed += (_, _) => { disposed = true; timer.Stop(); timer.Dispose(); loading?.Cancel(); player.Dispose(); DeletePcm(); web.Dispose(); TryDeleteDirectory(); };
    }
    private bool Trusted(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri) && uri.GetLeftPart(UriPartial.Authority) == server.GetLeftPart(UriPartial.Authority);
    private async Task RecoverAsio()
    {
        if (pcmPath == null || player.Mode != "asio" || loading != null) return;
        if (++resetAttempts > 2) { if (resetAttempts == 3) { wantsPlay = false; player.Pause(); Emit("error", "ASIO 驱动连续重置，自动恢复已停止。请检查 DAC 连接、驱动设置和其他独占程序。"); } return; }
        var generation = player.Generation;
        var file = pcmPath;
        var position = player.Position;
        recovering = true;
        Emit("waiting");
        try
        {
            await Task.Delay(150);
            if (disposed || generation != player.Generation || pcmPath != file || loading != null) return;
            player.Open(file); player.Seek(position);
            if (wantsPlay) { player.Play(); Emit("play"); Emit("playing"); }
            else Emit("pause");
            Emit("canplay");
        }
        catch (Exception e) { if (!disposed) { wantsPlay = false; player.Pause(); Emit("error", "ASIO 自动恢复失败：" + e.Message); } }
        finally { recovering = false; }
    }
    private async Task Initialize()
    {
        try
        {
            var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SummerMusic", "webview");
            await web.EnsureCoreWebView2Async(await CoreWebView2Environment.CreateAsync(null, profile));
            web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
            web.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
            web.CoreWebView2.NavigationStarting += (_, e) => { if (!Trusted(e.Uri)) e.Cancel = true; else { CancelLoad(); player.Close(); DeletePcm(); } };
            web.CoreWebView2.NavigationCompleted += (_, e) => {
                if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                if (e.IsSuccess) { connectionStatus.Visible = false; web.Visible = true; }
                else ShowConnectionError($"页面加载失败：{e.WebErrorStatus}。可点击「重新连接」或「服务器设置」。");
            };
            web.CoreWebView2.FrameNavigationStarting += (_, e) => e.Cancel = true;
            web.CoreWebView2.NewWindowRequested += (_, e) => {
                e.Handled = true;
                // Source links open only after a real user click, outside the privileged WebView.
                if (e.IsUserInitiated && Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) && target.Scheme is "https" or "http" && target.UserInfo == "" && !target.IsLoopback) {
                    try { Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true }); }
                    catch (Exception error) { MessageBox.Show(this, "无法打开来源链接：" + error.Message); }
                }
            };
            web.CoreWebView2.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            web.CoreWebView2.DownloadStarting += (_, e) => e.Cancel = true;
            web.CoreWebView2.WebMessageReceived += Message;
            timer.Start();
            await ConnectServer();
        }
        catch (Exception e) { if (!disposed) ShowConnectionError("客户端初始化失败，请确认已安装 Microsoft Edge WebView2 Runtime。" + e.Message); }
        finally { if (!disposed) serverSettings.Enabled = reconnect.Enabled = true; }
    }
    private void ShowConnectionError(string message)
    {
        web.Visible = false;
        connectionStatus.Text = $"无法连接音乐服务器：{server.GetLeftPart(UriPartial.Authority)}\n{message}\n请先在这台 PC 的浏览器打开同一地址；若也无法访问，请检查服务器运行状态、局域网及服务器防火墙的 8765 端口。";
        connectionStatus.Visible = true;
    }
    private async Task ConnectServer()
    {
        serverSettings.Enabled = reconnect.Enabled = false;
        CancelLoad(); player.Close(); DeletePcm(); trackId = "";
        web.CoreWebView2.Stop(); web.Visible = false;
        serverLabel.Text = server.GetLeftPart(UriPartial.Authority);
        connectionStatus.Text = "正在检查音乐服务器：" + serverLabel.Text; connectionStatus.Visible = true;
        try
        {
            if (bridgeScript != null) web.CoreWebView2.RemoveScriptToExecuteOnDocumentCreated(bridgeScript);
            bridgeScript = await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync($"if (location.origin === {JsonSerializer.Serialize(server.GetLeftPart(UriPartial.Authority))} && window === top) window.__SUMMER_NATIVE__ = true;");
            using var handler = new HttpClientHandler { AllowAutoRedirect = false };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(6) };
            using var response = await client.GetAsync(new Uri(server, "/api/health"));
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"服务检查返回 HTTP {(int)response.StatusCode}，请确认填写的是音乐服务端口，不是 WebDAV 端口。");
            using var health = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (!health.RootElement.TryGetProperty("status", out var status) || status.GetString() != "ok") throw new InvalidOperationException("此地址不是可用的音乐服务。");
            if (disposed) return;
            web.CoreWebView2.Navigate(server.ToString());
        }
        catch (TaskCanceledException) { if (!disposed) ShowConnectionError("连接超时，请检查服务器 IP 地址是否正确。"); }
        catch (Exception e) { if (!disposed) ShowConnectionError(e.Message); }
        finally { if (!disposed) serverSettings.Enabled = reconnect.Enabled = true; }
    }
    private void Reply(string id, object? result = null, string? error = null)
    {
        if (!disposed && web.CoreWebView2 != null && Trusted(web.Source.ToString())) web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, result, error }));
    }
    private void Emit(string eventName, string? error = null)
    {
        if (!disposed && web.CoreWebView2 != null && Trusted(web.Source.ToString())) web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "audio", trackId, @event = eventName, position = player.Position, duration = player.Duration, paused = player.Paused, error, format = player.Format }));
    }
    private void Message(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Trusted(e.Source) || e.WebMessageAsJson.Length > 4096) return;
        string id = "";
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson); var value = document.RootElement;
            id = value.GetProperty("id").GetString() ?? "";
            switch (value.GetProperty("command").GetString())
            {
                case "devices": Reply(id, NativePlayer.Devices()); break;
                case "configure":
                    CancelLoad(); player.Configure(value.GetProperty("mode").GetString() ?? "", value.GetProperty("device").GetString() ?? "", value.GetProperty("safeVolume").GetBoolean());
                    DeletePcm(); Emit("pause"); Reply(id, true); break;
                case "load":
                    var next = value.GetProperty("trackId").GetString() ?? "";
                    if (!Regex.IsMatch(next, "^[a-f0-9]{24}$")) throw new InvalidOperationException("无效歌曲 ID");
                    CancelLoad(); player.Close(); DeletePcm(); trackId = next; pendingSeek = 0; resetAttempts = 0;
                    loading = new CancellationTokenSource();
                    Reply(id, true); Emit("waiting"); _ = LoadTrack(next, loading); break;
                case "play":
                    if (!player.Armed) throw new InvalidOperationException("请先点击右下角「本机 DAC 输出」并确认硬件音量。");
                    wantsPlay = true;
                    if (loading == null && pcmPath == null && trackId != "") { loading = new CancellationTokenSource(); Emit("waiting"); _ = LoadTrack(trackId, loading); }
                    else if (loading == null) { player.Play(); Emit("play"); Emit("playing"); }
                    Reply(id, true); break;
                case "pause": wantsPlay = false; player.Pause(); Emit("pause"); Reply(id, true); break;
                case "seek": pendingSeek = value.GetProperty("position").GetDouble(); player.Seek(pendingSeek); Emit("timeupdate"); Reply(id, true); break;
                default: throw new InvalidOperationException("不支持的客户端命令");
            }
        }
        catch (Exception error) { Reply(id, error: error.Message); }
    }
    private async Task LoadTrack(string requestedId, CancellationTokenSource operation)
    {
        var token = operation.Token;
        var requestedServer = server;
        var source = Path.Combine(cache, Guid.NewGuid().ToString("N") + ".source");
        var decoded = source + ".wav";
        try
        {
            if (!player.Armed) throw new InvalidOperationException("请先点击右下角「本机 DAC 输出」，选择设备并确认硬件音量。");
            using var handler = new HttpClientHandler { AllowAutoRedirect = false, CookieContainer = new CookieContainer() };
            var cookies = await web.CoreWebView2.CookieManager.GetCookiesAsync(requestedServer.ToString());
            foreach (var cookie in cookies.Where(c => c.Name == "summer_session")) handler.CookieContainer.Add(requestedServer, new Cookie(cookie.Name, cookie.Value, "/"));
            using var client = new HttpClient(handler) { BaseAddress = requestedServer, Timeout = TimeSpan.FromMinutes(15) };
            using var metaResponse = await client.GetAsync("/api/tracks/" + requestedId, token);
            if (!metaResponse.IsSuccessStatusCode) throw new InvalidOperationException("读取歌曲失败，请重新登录并确认歌曲可用。");
            using var meta = JsonDocument.Parse(await metaResponse.Content.ReadAsStringAsync(token));
            var format = meta.RootElement.GetProperty("format").GetString()?.ToUpperInvariant();
            if (format is "DSF" or "DFF") throw new InvalidOperationException("当前客户端仅支持 PCM 播放；原生 DSD / DoP 尚未实现，不会自动转换为 PCM。");
            var bits = meta.RootElement.GetProperty("bit_depth").GetInt32();
            using var response = await client.GetAsync("/api/tracks/" + requestedId + "/stream?quality=original", HttpCompletionOption.ResponseHeadersRead, token);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"原音读取失败 HTTP {(int)response.StatusCode}");
            const long maxBytes = 2L * 1024 * 1024 * 1024;
            if (response.Content.Headers.ContentLength > maxBytes) throw new InvalidOperationException("当前客户端单曲缓存上限为 2 GB。");
            await using (var input = await response.Content.ReadAsStreamAsync(token))
            await using (var output = new FileStream(source, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true))
            {
                var buffer = new byte[81920]; long total = 0; int count;
                while ((count = await input.ReadAsync(buffer, token)) > 0) { total += count; if (total > maxBytes) throw new InvalidOperationException("原音超过单曲缓存上限。"); await output.WriteAsync(buffer.AsMemory(0, count), token); }
            }
            var ffmpeg = ResolveFfmpeg();
            // Probe sample type rather than inferring float/integer from bit depth alone.
            var probeStart = new ProcessStartInfo(ResolveTool("FFPROBE_PATH", "ffprobe.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_fmt,bits_per_raw_sample,bits_per_sample", "-of", "json", source }) probeStart.ArgumentList.Add(arg);
            using var probe = Process.Start(probeStart) ?? throw new InvalidOperationException("FFprobe 无法启动");
            using var cancelProbe = token.Register(() => { try { if (!probe.HasExited) probe.Kill(true); } catch (InvalidOperationException) { } });
            var probeOutput = probe.StandardOutput.ReadToEndAsync(token); var probeError = probe.StandardError.ReadToEndAsync(token);
            await probe.WaitForExitAsync(token); await probeError;
            if (probe.ExitCode != 0) throw new InvalidOperationException("无法确认源音频格式，已拒绝不确定的 PCM 转换。");
            using var probeData = JsonDocument.Parse(await probeOutput);
            var streamInfo = probeData.RootElement.GetProperty("streams")[0];
            var sampleType = streamInfo.GetProperty("sample_fmt").GetString() ?? "";
            if (streamInfo.TryGetProperty("bits_per_raw_sample", out var rawBits) && int.TryParse(rawBits.ToString(), out var exactBits) && exactBits > 0) bits = exactBits;
            if (sampleType.StartsWith("dbl")) throw new InvalidOperationException("当前客户端尚不支持 64 位浮点源，不自动降低精度。");
            var start = new ProcessStartInfo(ffmpeg) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
            // Integer PCM preserves 16/24/32-bit lossless values; no -ar/-ac or volume filter.
            var codec = sampleType.StartsWith("flt") ? "pcm_f32le" : bits > 24 ? "pcm_s32le" : bits > 16 ? "pcm_s24le" : bits > 0 ? "pcm_s16le" : "pcm_s32le";
            foreach (var arg in new[] { "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-c:a", codec, "-fs", maxBytes.ToString(), decoded }) start.ArgumentList.Add(arg);
            using var process = Process.Start(start) ?? throw new InvalidOperationException("FFmpeg 无法启动");
            using var cancel = token.Register(() => { try { if (!process.HasExited) process.Kill(true); } catch (InvalidOperationException) { } });
            var stderr = process.StandardError.ReadToEndAsync(token);
            await process.WaitForExitAsync(token); await stderr;
            if (process.ExitCode != 0) throw new InvalidOperationException("FFmpeg 无法解码此音源；原文件未修改。");
            token.ThrowIfCancellationRequested();
            if (new FileInfo(decoded).Length >= maxBytes) throw new InvalidOperationException("解码 PCM 超过 2 GB，未播放截断音频。");
            if (loading != operation || disposed) return;
            player.Open(decoded); pcmPath = decoded;
            player.Seek(pendingSeek);
            loading = null; Emit("loadedmetadata"); Emit("canplay");
            if (wantsPlay) { player.Play(); Emit("play"); Emit("playing"); }
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (!disposed && !token.IsCancellationRequested && trackId == requestedId && (loading == operation || pcmPath == decoded)) { wantsPlay = false; loading = null; player.Close(); Emit("error", error.Message); } }
        finally { operation.Dispose(); TryDelete(source); if (pcmPath != decoded) TryDelete(decoded); if (disposed) TryDeleteDirectory(); }
    }
    private string ResolveFfmpeg()
        => ResolveTool("FFMPEG_PATH", "ffmpeg.exe");
    private string ResolveTool(string key, string executable)
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, executable);
        if (File.Exists(bundled)) return bundled;
        var configured = File.Exists(Path.Combine(project, ".env")) ? File.ReadLines(Path.Combine(project, ".env")).FirstOrDefault(l => l.StartsWith(key + "="))?[(key.Length + 1)..].Trim().Trim('"', '\'') : null;
        if (!string.IsNullOrEmpty(configured) && Path.IsPathFullyQualified(configured) && File.Exists(configured)) return configured;
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) { var candidate = Path.Combine(directory.Trim('"'), executable); if (File.Exists(candidate)) return candidate; }
        throw new InvalidOperationException($"未找到 {executable}，请在项目 .env 设置 {key} 绝对路径。");
    }
    private void CancelLoad() { wantsPlay = false; loading?.Cancel(); loading = null; }
    private void DeletePcm() { if (pcmPath != null) TryDelete(pcmPath); pcmPath = null; }
    private static void TryDelete(string path) { try { File.Delete(path); } catch (IOException) { } }
    private void TryDeleteDirectory() { try { Directory.Delete(cache); } catch (IOException) { } }
}
