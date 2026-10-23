using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace SummerMusic;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        string Option(string key, string fallback) => args.FirstOrDefault(a => a.StartsWith(key + "="))?[(key.Length + 1)..] ?? fallback;
        var project = Path.GetFullPath(Option("--project", Path.Combine(AppContext.BaseDirectory, "..", "..")));
        if (args.Contains("--diagnose"))
        {
            var report = new { architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(), devices = NativePlayer.Devices() };
            Directory.CreateDirectory(Path.Combine(project, "data"));
            File.WriteAllText(Path.Combine(project, "data", "desktop-devices.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            return;
        }
        if (args.Contains("--self-test"))
        {
            var results = new List<object>();
            var folder = Path.Combine(project, "_TMP", "native-audio-self-test");
            Directory.CreateDirectory(folder);
            using var player = new NativePlayer();
            foreach (var bits in new[] { 16, 24 })
            {
                var file = Path.Combine(folder, $"silent-{bits}.wav");
                try
                {
                    using (var writer = new WaveFileWriter(file, new WaveFormat(44100, bits, 2))) writer.Write(new byte[44100 * (bits / 8) * 2 * 3], 0, 44100 * (bits / 8) * 2 * 3);
                    player.Configure("shared", "", true); player.Open(file); player.Play();
                    for (var n = 0; n < 12; n++) { Application.DoEvents(); Thread.Sleep(50); }
                    if (player.Paused || player.Position <= 0) throw new InvalidOperationException("Playback clock did not advance");
                    player.Pause(); if (!player.Paused) throw new InvalidOperationException("Pause failed");
                    player.Seek(1); if (player.Position < 1) throw new InvalidOperationException("Seek failed");
                    results.Add(new { bits, ok = true, format = player.Format });
                }
                catch (Exception error) { results.Add(new { bits, ok = false, error = error.Message }); }
                finally { player.Close(); File.Delete(file); }
            }
            Directory.CreateDirectory(Path.Combine(project, "data"));
            File.WriteAllText(Path.Combine(project, "data", "desktop-self-test.json"), JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }));
            return;
        }
        try { Application.Run(new PlayerWindow(project, ClientSettings.Load(Option("--server", "")))); }
        catch (Exception error) { MessageBox.Show(error.Message, "Summer Music 启动失败"); }
    }
}
