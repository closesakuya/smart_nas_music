namespace SummerMusic;

// Driver callbacks may arrive after disposal. Only the active generation can signal.
internal sealed class PlaybackLifecycle
{
    private readonly object gate = new();
    private int version;
    private bool pendingReset, completed;
    public int Version { get { lock (gate) return version; } }
    public void Advance() { lock (gate) { version++; pendingReset = completed = false; } }
    public void RequestReset(int sourceVersion) { lock (gate) { if (sourceVersion == version && !completed) pendingReset = true; } }
    public bool TakeReset() { lock (gate) { var result = pendingReset; pendingReset = false; return result; } }
    public bool Complete(int sourceVersion) { lock (gate) { if (sourceVersion != version || completed) return false; completed = true; return true; } }
    public void Rearm() { lock (gate) completed = false; }
}
