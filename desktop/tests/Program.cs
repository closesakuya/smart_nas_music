using SummerMusic;

var lifecycle = new PlaybackLifecycle();
var previous = lifecycle.Version;
lifecycle.RequestReset(previous); lifecycle.Advance(); lifecycle.RequestReset(previous);
if (lifecycle.TakeReset() || lifecycle.Complete(previous)) throw new Exception("Stale driver callback accepted");
var active = lifecycle.Version;
lifecycle.RequestReset(active); lifecycle.RequestReset(active);
if (!lifecycle.TakeReset() || lifecycle.TakeReset()) throw new Exception("Reset requests must coalesce");
if (!lifecycle.Complete(active) || lifecycle.Complete(active)) throw new Exception("EOF must fire exactly once");
lifecycle.RequestReset(active);
if (lifecycle.TakeReset()) throw new Exception("Stopping at EOF must not trigger recovery");
lifecycle.Rearm();
if (!lifecycle.Complete(active)) throw new Exception("Repeat/seek must rearm EOF");
Console.WriteLine("PASS stale ASIO callbacks, reset coalescing, EOF once and repeat rearm");

var root = Path.Combine(Path.GetTempPath(), "summer-settings-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var saved = Path.Combine(root, "saved.json"); var bundled = Path.Combine(root, "bundled.json");
try
{
    void Check(bool result, string name) { if (!result) throw new Exception(name); Console.WriteLine("PASS " + name); }
    Check(ClientSettings.Load(null, saved, bundled).Host == "192.168.0.233", "missing config defaults to LAN server, not this PC");
    File.WriteAllText(bundled, "{\"server\":\"http://192.168.0.234:8765\"}");
    Check(ClientSettings.Load(null, saved, bundled).Host == "192.168.0.234", "portable configuration is read");
    File.WriteAllText(saved, "{\"server\":\"https://music.example.test\"}");
    Check(ClientSettings.Load(null, saved, bundled).Host == "music.example.test", "saved per-user address wins");
    Check(ClientSettings.Load("http://localhost:9000", saved, bundled).Port == 9000, "explicit CLI address wins");
    File.WriteAllText(saved, "invalid JSON");
    Check(ClientSettings.Load(null, saved, bundled).Host == "192.168.0.234", "corrupt user settings fall back safely");
    foreach (var invalid in new[] { "file:///C:/", "javascript:alert(1)", "http://user:secret@localhost", "http://localhost/dav", "http://localhost?secret=1", "http://localhost/#x", "" })
    {
        try { ClientSettings.ParseServer(invalid); throw new Exception("Invalid address accepted"); }
        catch (InvalidOperationException) { }
    }
    Console.WriteLine("PASS invalid schemes, paths, credentials and parameters rejected");
}
finally { File.Delete(saved); File.Delete(bundled); Directory.Delete(root); }
