# Summer Music

Windows 同机部署的私人音乐空间。以本地文件夹为索引，支持原音播放、封面、播放队列、收藏、歌单和 DeepSeek 推荐。PC 与手机共享同一网页。

## 运行

已配置环境可在 PowerShell 执行：

```powershell
.\start.ps1
```

默认本机地址 `http://localhost:8765`，本机所在局域网地址 `http://192.168.0.233:8765`。登录用户名为 `.env` 的 `APP_USERNAME`，密码为 `APP_PASSWORD`。初始密码随机生成，不与 WebDAV 密码复用。

首次建立索引会逐步显示歌曲，不必等全部扫描完成。后续启动核对文件清单，仅对新增、变化、失败的文件重新解析。文件监听防抖 3 秒，每小时补偿核对，管理页可扫描全库，文件夹页可扫描当前目录。程序中断后保留已提交索引；目录暂时离线不移除曲目。缺失文件保留曲目与歌单引用，并标记不可用。

首次安装或迁移：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# 编辑 .env，至少设置 APP_PASSWORD
Set-Location frontend
npm ci
npm run build
Set-Location ..
.\start.ps1
```

生产模式使用 FastAPI 提供构建后的网页，不需要额外启动 Node.js。前端改动后重新 `npm run build`；后端改动后重启服务。

开发模式分别运行：

```powershell
.\start.ps1 -Dev
# 另一个终端
Set-Location frontend
npm run dev
```

开发网页通常为 `http://localhost:5173`，Vite 将 `/api` 代理到后端 8765。

## 播放与“无损”

- **原音**：直接返回源文件，不进行编码、重采样或音量处理；支持 HTTP Range、HEAD、进度拖动。音频文件通过歌曲 ID 查询，客户端不能指定任意磁盘路径。
- **CUE 原音**：保留源镜像，按 CUE 的 INDEX 01 时间边界生成单轨 FLAC 缓存；75 帧/秒的 CUE 时间转为秒。支持多 FILE、UTF-8 和自动检测的旧编码。源曲目在虚拟轨道可用时隐藏，删除 CUE 后重新显示。
- **兼容 FLAC**：按需转换容器/编码。对于 PCM 无损源不主动改采样率；超过 24 bit 的源不转换为 FLAC，需使用原音。MP3 转为 FLAC 不会恢复丢失的音质。
- **MP3 320/192/128k**：按需转码到临时缓存，限制并发为 2，默认缓存上限 10 GB；近期正在使用的缓存保留。首次生成可能需要等待，后续复用，缓存包含文件大小、修改时间、CUE 边界和编码档位。
- **DSD/DSF**：原文件保持不变，浏览器通常需选择兼容 PCM 或 MP3 播放；这涉及 DSD 到 PCM 的转换，不能视为原生 DSD 输出。

浏览器不支持原音编码时，网页提示并切换到 MP3 320k。底部可选择音质，歌曲详情展示源文件参数。网页原音直出不代表操作系统/声卡一定以 bit-perfect 模式输出；浏览器播放链与硬件输出需独立验证。

本项目借鉴 Gonic / Navidrome 的目录索引、源文件直出、按需转码设计，自行实现面向 AI 的网页与 API，不直接复制其代码。当前不提供 Subsonic 协议或 Roon RAAT；网页不提供设备独占输出，Windows PC 客户端另行支持 WASAPI/ASIO。当前播放器顺序切歌，不承诺采样级无缝衔接。

## AI 与联网资料

DeepSeek 密钥、接口地址、模型和每日请求上限在 `.env` 配置。每次对话先调用 API 规划检索，再将限定候选集交给 API 推荐排序，不上传音频或整个曲库。对话上下文由页面携带；刷新网页不会恢复聊天记录。

AI 歌单以建议形式显示，点击“保存歌单”或“应用到歌单”才持久化。歌单支持手动排序、增删、重命名、版本冲突检查与撤销。播放队列保存在浏览器本地存储，与已保存歌单分开。

管理页可为下一批 60 首补全 AI 标签，单曲详情可单独生成。标签保留 `source`、`basis`、置信度、版本及推断依据，不改写源文件。AI 不能仅凭文字元数据测量 BPM、调性或听感，相关未知字段不会伪装成测量值。失败批次可重试，成功响应缓存；每日额度按 API 请求次数统计，含失败尝试。

“联网资料”优先查询 MusicBrainz 并展示候选，不自动覆盖标签。`MUSICBRAINZ_CONTACT_URL` 默认使用本项目网址，也可设置为你的联系地址。MusicBrainz 连接失败时自动改用 DeepSeek 联网搜索，展示网页链接与摘要，明确标识为未完成权威匹配的资料；搜索消耗 DeepSeek 配额。两种来源都失败时在歌曲详情内显示具体错误，不影响相似推荐面板。封面目前来自音频内嵌图片或目录图片，尚未实现联网封面自动匹配。

首版不运行本地模型，不生成伪向量。当前使用结构化标签、关键词与 AI 二次排序；独立远程嵌入服务尚未接入。

## 配置与数据

主要配置见 `.env.example`：

| 配置 | 用途 |
| --- | --- |
| MUSIC_ROOT | 音乐库根目录，只读 |
| DATA_DIR | SQLite、封面与转码缓存 |
| HOST / PORT | 默认 0.0.0.0:8765 |
| APP_USERNAME / APP_PASSWORD | 单用户登录 |
| COOKIE_SECURE | HTTPS 公网部署设为 true |
| DEEPSEEK_API_KEY / BASE_URL / MODEL | 远程 AI |
| AI_DAILY_REQUEST_LIMIT | 默认每日 200 次请求 |
| FFMPEG_PATH / FFPROBE_PATH | 可指定可执行文件绝对路径 |
| TRANSCODE_CACHE_GB | 默认 10 GB，临时任务与近期缓存可能短暂超限 |
| SCAN_ON_START / RECONCILE_MINUTES | 启动扫描与定期校验 |
| WEBDAV_MODE | auto / http / https |
| WEBDAV_MUSIC_PATH | 音乐在 DAV 根目录下的挂载子路径，如 PC/Music；直接挂载音乐根目录时留空 |
| PUBLIC_HTTPS | 公网 HTTPS 模式 |

WebDAV 账号仅留在服务端。实际播放优先使用磁盘；本地文件无法访问时，完整原音可由后端通过 WebDAV 备用读取并转发 Range/206。内网请求选择 LAN 地址，外网 HTTP 请求选择 HTTP 地址，HTTPS 请求或显式 `PUBLIC_HTTPS=true` 使用 HTTPS 地址；自动模式连接失败时可尝试外网 HTTPS。远程备用读取暂不支持转码和 CUE 切片，也不进行远程曲库扫描。外网浏览器仍访问应用的同源播放接口，不接触 DAV 密码。

当前已确认音乐挂载路径为 `/dav/NAS/Media/Music`，因此 `.env` 的 `WEBDAV_MUSIC_PATH=NAS/Media/Music`。三种网络地址共用这一子路径。

源目录中的 `.git`、`.agents`、`.claude`、`_logs`、`_scripts`、`_TMP`、`_Videos`、`_Originals_ToReview` 等管理目录不纳入索引；其余音乐分类保留原目录层级。不会执行曲库中的脚本、整理文件名或删除音乐。

数据文件位于 `data/`，实际配置 `.env`、数据库、日志、缓存和虚拟环境均由 `.gitignore` 排除。请勿上传真实 `.env`。页面设置接口只返回配置状态，不返回密钥与密码。

## 后续软路由公网映射

保持后端同一端口，用路由器或反向代理将你的 HTTPS 域名转发到 `192.168.0.233:8765`，保留 Host 头和 `/api` 路径，允许 Range/206 响应。使用同一域名提供前端与 API，避免跨域登录。

启用公网 HTTPS 时：

1. 在代理处安装证书，HTTP 跳转 HTTPS。
2. `.env` 设置 `COOKIE_SECURE=true`、`PUBLIC_HTTPS=true`，然后重启；之后通过 HTTPS 地址登录。
3. 设置转码请求读取超时至少 600 秒。不要把源目录、`.env`、SQLite 或 DAV 凭据直接暴露到公网。
4. 本服务默认不信任转发头；登录来源校验使用浏览器 Origin 与代理保留的 Host。未修改系统防火墙、软路由或端口映射。

### Windows 开机启动

运行 `powershell -ExecutionPolicy Bypass -File scripts/service-control.ps1 -Action Install`，接受管理员确认后注册 `MusicSmartend` 计划任务。任务以 SYSTEM 身份在开机后延迟 30 秒运行，无需登录；异常退出每分钟重试，最多 10 次。项目和音源盘必须是本机可访问磁盘，不支持仅当前用户可见的映射网络盘。

桌面 `Music-Start.cmd`、`Music-Stop.cmd` 分别启动、停止服务，会请求管理员权限。停止不会禁用下次开机启动；修改 `.env` 后先停止再启动。不要同时用 `start.ps1` 启动第二个实例。日志位于 `data/service.log` 与 `data/service-error.log`，每次启动覆盖。取消自启可在管理员 PowerShell 执行 `Disable-ScheduledTask -TaskName MusicSmartend`。

局域网其他设备连不上时，检查 Windows 防火墙是否允许本程序/8765 入站，以及是否处在同一网段。可由管理员按需执行限定网段的规则：

```powershell
New-NetFirewallRule -DisplayName 'Summer Music LAN 8765' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -RemoteAddress 192.168.0.0/24 -Profile Private
```

此命令仅供按需使用，项目启动不会自行修改防火墙。

## 验证

### 网页输出与音乐灵感

播放器右下角「输出设备」可选择当前浏览器所在 PC 的音频设备。需要浏览器支持以及 HTTPS 或本机 localhost 安全环境；局域网 HTTP 地址会显示限制说明。部分浏览器需要用户明确点击麦克风授权后才公开更多输出设备，获取列表后立即停止麦克风，不录制或上传音频。网页不提供 ASIO/独占模式；原生客户端见 [desktop/README.md](desktop/README.md)。

音乐灵感的来源随浏览位置变化：单张专辑（含专辑艺术家区分）、当前文件夹及子目录、当前歌单、收藏、最近播放或整个乐库。AI 面板显示范围，后端检索和备用候选都不能越界；不跟随正在播放的专辑。

推荐卡支持单首、多选或全部操作：插到当前歌曲后、追加队尾、替换队列并播放；可追加到已有歌单或新建歌单。普通添加不会打断当前播放，单首立即播放保留其他队列。只有明确点击对应按钮才替换队列或应用 AI 的歌单修改提议。

底部当前歌曲旁提供「加入歌单」快捷按钮。播放队列支持逐首勾选和跨页全选，再追加到已有歌单或新建歌单；保存不改变当前队列和播放状态。

首页 Shuffle 灵感短语可换一批（本地短语库，不消耗 API）；点击短语调用 AI 从整个乐库挑选、排除当前队列前 150 首，然后替换队列并尝试自动播放。请求失败或结果为空保留原队列；若浏览器阻止异步自动播放，点击底部播放按钮即可。首页标题旁刷新同时更新随机专辑、随机歌曲和灵感短语，不修改已保存歌单。

首页大封面及旁边「开始聆听」始终按该封面的专辑名和专辑艺术家查询完整专辑并播放，不再使用下方独立的随机发现列表。刷新后播放的是新封面对应专辑。

首页「随机发现」可切换「随机歌曲 / 随机专辑」。专辑卡提供「替换并播放」和「追加队尾」，按专辑名与专辑艺术家加载完整专辑；追加不会打断当前曲目。

当前歌曲旁的星光按钮，以及播放队列里的「相似音乐」，可按歌曲或队列推荐相似风格。默认从整个本地库检索，排除参考 ID，结果可播放、加入队列、保存歌单，不自动替换队列。长队列均匀选择最多 150 首参考，再均匀抽样最多 24 首元数据交给 AI 分析。联网搜索规划和网页歌曲提取使用非思考模式，避免推理耗尽输出额度；后端拒绝截断结果，并单独提示超时或长度超限。

勾选「网络搜索」后使用 [DeepSeek Search API](https://api-docs.deepseek.com/guides/search/) 实际检索，再按来源提取歌曲信息。每次最多两个查询，搜索结果缓存 24 小时；搜索和模型调用均计入本应用每日请求限额，服务商另按接口计费。只返回有来源包含歌曲名/歌手、且未匹配到本地索引的记录，不包含音源或可播放 ID；未知专辑留空。网络故障不会用模型记忆伪装联网结果。相似理由是 AI 推断，译名/艺名差异可能影响去重。可选 `DEEPSEEK_SEARCH_BASE_URL` 默认沿用 API 基址。

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m scripts.smoke
# 以下额外调用 API，消耗少量额度
.\.venv\Scripts\python.exe -m scripts.smoke --ai --tags
# 已运行服务下的桌面/手机浏览器测试，使用本机 Chrome
Set-Location frontend
node --env-file=../.env ./node_modules/@playwright/test/cli.js test tests/browser.spec.ts --workers=1
```

测试覆盖：增量扫描、改名保留 ID/收藏、封面变化、CUE 虚拟轨道、目录离线保护、原音 Range 字节一致性、登录/来源校验、路径越界、歌单修改与撤销、版本冲突、桌面实际播放、移动端宽度。截图保存在 `data/previews/`。

数据库备份可在停止服务后复制 `data/library.sqlite3`；服务运行时使用 SQLite backup API，不能仅复制主文件并遗漏 WAL。封面与转码缓存均可重建。

运行中可执行 `.\.venv\Scripts\python.exe -m scripts.backup`，一致性备份保存在 `data/backups/`。部署复现可安装 `requirements.lock.txt` 中的精确依赖版本；前端使用已提交的 `package-lock.json` 与 `npm ci`。
