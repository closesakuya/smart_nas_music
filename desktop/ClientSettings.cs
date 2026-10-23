using System.Text.Json;

namespace SummerMusic;

internal static class ClientSettings
{
    public const string DefaultServer = "http://192.168.0.233:8765";
    private static string UserFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SummerMusic", "client-settings.json");
    public static Uri ParseServer(string address)
    {
        if (!Uri.TryCreate(address.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.AbsolutePath != "/" || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "")
            throw new InvalidOperationException("请输入音乐服务的 HTTP/HTTPS 根地址，例如 http://192.168.0.233:8765；不要填 WebDAV 地址、账号或密码。");
        return uri;
    }
    public static Uri Load(string? commandLine = null, string? userFile = null, string? bundledFile = null)
    {
        if (!string.IsNullOrWhiteSpace(commandLine)) return ParseServer(commandLine);
        foreach (var file in new[] { userFile ?? UserFile, bundledFile ?? Path.Combine(AppContext.BaseDirectory, "client-settings.json") })
        {
            try
            {
                if (!File.Exists(file)) continue;
                using var json = JsonDocument.Parse(File.ReadAllText(file));
                return ParseServer(json.RootElement.GetProperty("server").GetString() ?? "");
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or KeyNotFoundException or InvalidOperationException) { }
        }
        return ParseServer(DefaultServer);
    }
    public static void Save(Uri server)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(UserFile)!);
        var temporary = UserFile + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(new { server = server.GetLeftPart(UriPartial.Authority) }, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporary, UserFile, true);
    }
}

internal sealed class ServerSettingsDialog : Form
{
    public Uri SelectedServer { get; private set; }
    public ServerSettingsDialog(Uri current)
    {
        SelectedServer = current;
        Text = "音乐服务器设置"; ClientSize = new Size(570, 235); FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent; MaximizeBox = false; MinimizeBox = false;
        var info = new Label { Left = 20, Top = 18, Width = 530, Height = 70, Text = "请输入运行音乐后台的电脑地址（不是 DAC / WebDAV 地址）。\n局域网通常为 http://192.168.0.233:8765\n127.0.0.1 / localhost 只用于客户端与后台在同一台电脑时。" };
        var address = new TextBox { Left = 20, Top = 96, Width = 530, Text = current.GetLeftPart(UriPartial.Authority) };
        var note = new Label { Left = 20, Top = 132, Width = 530, Height = 32, Text = "只连接你信任的服务器；地址会保存在当前 Windows 用户配置中。" };
        var save = new Button { Left = 326, Top = 184, Width = 110, Height = 30, Text = "保存并连接" };
        var cancel = new Button { Left = 446, Top = 184, Width = 104, Height = 30, Text = "取消", DialogResult = DialogResult.Cancel };
        save.Click += (_, _) => {
            try { SelectedServer = ClientSettings.ParseServer(address.Text); ClientSettings.Save(SelectedServer); DialogResult = DialogResult.OK; }
            catch (Exception e) { MessageBox.Show(this, e.Message, "无法保存服务器地址"); }
        };
        Controls.AddRange([info, address, note, save, cancel]); AcceptButton = save; CancelButton = cancel;
    }
}
