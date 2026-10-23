# Summer Music PC 客户端

![Summer Music 图标](assets/summer-music.png)

客户端 EXE 与窗口使用统一图标：深绿圆角底、米白声波、金色灵感星光。矢量源文件在 `assets/summer-music.svg`，Windows ICO 包含 16/24/32/48/64/128/256 像素版本。修改后可执行 `scripts/build-icon.ps1` 重建 ICO/PNG，再构建客户端。

Windows x64 原生音频客户端，使用 WebView2 复用现有网页界面，NAudio 驱动 WASAPI / ASIO；AI、目录、歌单和收藏继续使用同一服务端。不是把浏览器输出改名为 ASIO。

## 启动

同机双击桌面 `Music-PC.cmd`，或运行项目根目录 `start-desktop.ps1`。无需管理员权限，也不要以 SYSTEM 运行客户端。后台仍由开机任务管理。

在另一台连接 DAC 的 Windows PC 上，解压新版压缩包的 **全部文件**（不要只复制 exe，不要复制 `.env`、数据库或 API Key），安装 Microsoft Edge WebView2 Runtime，双击 `SummerMusic.Desktop.exe` 即可。0.2.1 版便携包默认连接 `http://192.168.0.233:8765`，不再默认访问另一台 PC 自己的 localhost。也可显式指定：

```powershell
.\SummerMusic.Desktop.exe --server=http://192.168.0.233:8765
```

仅连接你信任的音乐服务地址。登录使用音乐网页账号；客户端不保存明文密码。构建产物包含 .NET 运行时和本机已有 FFmpeg/FFprobe，不需另外安装 .NET。不要仅复制 exe。

窗口顶部始终提供「服务器设置」和「重新连接」。设置保存到 `%LOCALAPPDATA%\SummerMusic\client-settings.json`。地址优先级为命令行 `--server`、当前用户已保存地址、便携包 `client-settings.json`、内置局域网地址。重连会停止播放；更换地址只信任新的服务来源，不会把旧服务的登录 cookie 发送到新服务。

启动先检查 `/api/health`。连接失败会显示目标地址、错误和排查提示，仍可修改设置。若另一台 PC 的浏览器也无法打开 `http://192.168.0.233:8765`，请检查同一局域网、服务器是否运行以及 Windows 防火墙入站规则；客户端改地址不能绕过网络或防火墙。此更新没有自动修改防火墙。

首次使用点击播放器右下角「本机 DAC 输出」，选择输出模式与设备，先调低 DAC / 功放硬件音量，再勾选确认并应用。每次客户端启动都需要重新确认。当前版本不使用软件音量衰减，数字电平为 100%，网页音量和有损质量选择会禁用。

## 支持与边界

### 0.3.0 连播修复

ASIO 不在音频回调线程停止驱动，而是在 UI 定时器检查 NAudio 的 `HasReachedEnd`，发送一次曲目结束事件以继续队列。驱动实例关闭后，其迟到的结束/重置回调会被代次标识丢弃；初始化设置采样率期间不订阅重置通知。当前有效实例的重置会尝试恢复当前进度和播放状态，每首最多两次，超过上限明确报错，避免无限重启。修复依据 [NAudio AsioOut 实现](https://github.com/naudio/NAudio/blob/v2.2.1/NAudio.Asio/AsioOut.cs)。

此改动解决自动下一首的事件链路，不是无缝播放；下一曲仍需下载和解码。已验证生命周期状态机与模拟宿主下的自动连播，实体厂商 ASIO 驱动需要在连接 DAC 的 PC 上验收。新客户端也可点击网络推荐的来源链接，在系统默认浏览器打开；外部页面不会进入有原生权限的客户端视图。

- WASAPI 共享：允许系统混音或转换；不能据此承诺 bit-perfect。
- WASAPI 独占：先验证设备是否支持源 PCM 的采样率、位深、通道数；不支持时明确报错，不静默降级或重采样。可能占用设备，影响其他程序发声。
- ASIO：枚举本机 **64 位** ASIO 驱动，由厂商驱动接受采样率并转换缓冲样本格式。不捆绑、不安装 ASIO 驱动；首版使用驱动默认输出通道，未提供多通道路由或控制面板。ASIO 不保证比 WASAPI 音质更好。
- FLAC/WAV/MP3 等从已登录服务下载原音，再解码为 PCM 临时文件；CUE 使用服务端原音分轨接口。保留整数 PCM 位深及采样率，浮点源保持 float32；拒绝 float64 和 DSD/DoP，避免未经说明的精度或格式转换。
- 当前先完成单曲下载、解码再开始播放，大文件会等待；不是流式解码、gapless 或 Roon/RAAT。每首原音/PCM 缓存上限各 2 GB，超限报错，不播放截断文件。
- 临时文件位于当前用户 `%LOCALAPPDATA%\SummerMusic\pcm`，正常切歌或退出会清理本次文件，异常强制终止可能留下缓存。WebView 登录会话位于同目录的 `webview` 子目录。不会改写音乐原文件。
- 窗口只允许导航到启动时指定的服务来源，不提供任意文件访问/命令执行桥接；FFmpeg 参数分离传递，不拼接 shell 命令。

## 构建与诊断

```powershell
.\scripts\build-desktop.ps1
.\desktop\publish\SummerMusic.Desktop.exe --diagnose --project=G:\Workspace\Proj\music_smartend
.\desktop\publish\SummerMusic.Desktop.exe --self-test --project=G:\Workspace\Proj\music_smartend
```

构建需要 .NET 8 SDK；当前工作区 SDK 在 `_TMP/dotnet-sdk`，版本由官方 SHA512 校验。依赖锁定于 `packages.lock.json`。打包脚本复制本机工具，仅供本机/个人使用；对外分发前需审查 FFmpeg 对应构建的许可证及源码提供义务。

诊断输出为 `data/desktop-devices.json`。自测仅播放程序生成的静音 PCM，覆盖 16/24-bit 共享输出、暂停与定位，输出 `data/desktop-self-test.json`；不代表已验证实体 DAC 独占、ASIO、硬件音质或端到端 bit-perfect。远程桌面会话可能只能看到“远程音频”，实体 DAC 必须在目标 PC 本地会话中验证。

本轮验证：客户端构建成功；原生引擎共享静音自测通过；网页桥接在模拟宿主下通过。当前自动化环境未能启动客户端 GUI 做完整端到端验收，首次本地启动仍需确认 WebView2 窗口、登录、DAC 输出以及驱动兼容性。测试脚本 `frontend/tests/desktop-smoke.mjs` 尚未在真实客户端上执行成功，不计入通过的测试。
