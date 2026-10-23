import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AudioLines,
  Check,
  ChevronRight,
  Disc3,
  Folder,
  Heart,
  History,
  Home,
  Info,
  ListMusic,
  LoaderCircle,
  LogOut,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Send,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Undo2,
  Volume2,
  X,
} from "lucide-react";
import "./style.css";
import { AudioOutput } from "./AudioOutput";
import { NativeOutput } from "./NativeOutput";
import { isNative, bindNativeAudio, nativeError } from "./nativeAudio";
import { RecommendationCard, type QueueAction } from "./RecommendationCard";
import { nextInspirations } from "./inspiration";
import { SimilarityPanel, type SimilarResult } from "./SimilarityPanel";

type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  folder: string;
  path: string;
  format: string;
  duration: number;
  sample_rate: number;
  bit_depth: number;
  bitrate: number;
  channels: number;
  favorite: number;
  cover: string | null;
  genre: string;
  year: string;
  available: number;
  cue_path: string | null;
  tags: Record<string, string>;
  metadata: Record<string, string>;
  ai_tags: Record<string, unknown>;
};
type Album = {
  album: string;
  album_artist: string;
  artist: string;
  cover: string | null;
  count: number;
  year: string;
};
type Playlist = {
  id: string;
  name: string;
  description: string;
  count?: number;
  tracks?: Track[];
  revision?: number;
  cover?: string;
};
type FolderItem = {
  name: string;
  path: string;
  count: number;
  cover: string | null;
};
type Stats = {
  tracks: number;
  albums: number;
  artists: number;
  duration: number;
  favorites: number;
  formats: { format: string; count: number }[];
  ai_configured: boolean;
  ai_usage: { requests: number; input_tokens: number; output_tokens: number };
  scan: {
    running: boolean;
    phase: string;
    visited: number;
    updated: number;
    unchanged: number;
    error_count: number;
    errors: { path: string; error: string }[];
  };
  tags: {
    running: boolean;
    done: number;
    total: number;
    errors: number;
    message: string;
  };
};
type Recommendation = {
  message: string;
  tracks: Track[];
  action: string;
  name: string;
  playlist_id: string | null;
};
type Chat = {
  role: "user" | "assistant";
  content: string;
  result?: Recommendation;
};

async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 && path !== "/login")
    window.dispatchEvent(new Event("session-expired"));
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : `请求失败 (${response.status})`,
    );
  }
  return response.json();
}
const fmt = (seconds: number) => {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
const sourceQuality = (t: Track) =>
  `${t.format}${t.bit_depth ? " · " + t.bit_depth + " bit" : ""}${t.sample_rate ? " / " + t.sample_rate / 1000 + " kHz" : ""}`;
function Cover({
  cover,
  title = "",
  className = "",
}: {
  cover?: string | null;
  title?: string;
  className?: string;
}) {
  const color = Array.from(title).reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  return (
    <div className={`cover palette-${color} ${className}`}>
      {cover ? (
        <img loading="lazy" src={"/api/covers/" + cover} alt={title} />
      ) : (
        <>
          <span className="cover-orbit" />
          <Disc3 aria-hidden="true" />
          <span className="cover-letter">{title.slice(0, 2)}</span>
        </>
      )}
    </div>
  );
}
function App() {
  const [logged, setLogged] = useState<boolean | null>(null),
    [loginError, setLoginError] = useState(""),
    [loginBusy, setLoginBusy] = useState(false);
  const [view, setView] = useState("home"),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [folder, setFolder] = useState(""),
    [album, setAlbum] = useState<Album | null>(null);
  const [stats, setStats] = useState<Stats | null>(null),
    [tracks, setTracks] = useState<Track[]>([]),
    [total, setTotal] = useState(0),
    [albums, setAlbums] = useState<Album[]>([]),
    [moreAlbums, setMoreAlbums] = useState(false),
    [folders, setFolders] = useState<FolderItem[]>([]),
    [playlists, setPlaylists] = useState<Playlist[]>([]),
    [selected, setSelected] = useState<Playlist | null>(null),
    [loading, setLoading] = useState(false),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [aiOpen, setAiOpen] = useState(window.innerWidth > 1250),
    [mobileNav, setMobileNav] = useState(false),
    [queueOpen, setQueueOpen] = useState(false),
    [queuePage, setQueuePage] = useState(0),
    [detail, setDetail] = useState<Track | null>(null),
    [addTracks, setAddTracks] = useState<Track[] | null>(null),
    [toast, setToast] = useState("");
  const [queue, setQueue] = useState<Track[]>(() => {
      try {
        return JSON.parse(localStorage.getItem("summer-queue") || "[]");
      } catch {
        return [];
      }
    }),
    [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [quality, setQuality] = useState(
      localStorage.getItem("summer-quality") || "original",
    ),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [volume, setVolume] = useState(0.8),
    [repeat, setRepeat] = useState<"all" | "one" | "off">("all"),
    [shuffle, setShuffle] = useState(false),
    [buffering, setBuffering] = useState(false);
  const [messages, setMessages] = useState<Chat[]>([]),
    [input, setInput] = useState(""),
    [chatBusy, setChatBusy] = useState(false),
    [settings, setSettings] = useState<Record<string, unknown> | null>(null),
    [online, setOnline] = useState<unknown>(null);
  const audio = useRef<HTMLAudioElement>(null),
    wantPlay = useRef(false),
    restorePosition = useRef(0),
    chatEnd = useRef<HTMLDivElement>(null),
    scanWasRunning = useRef(false),
    recorded = useRef("");
  const current = queue[index] || null;
  const [inspirations, setInspirations] = useState(() => nextInspirations());
  const [featuredBusy, setFeaturedBusy] = useState(false);
  const [homeRecommendationType, setHomeRecommendationType] = useState("tracks");
  const [similarSeeds, setSimilarSeeds] = useState<{ tracks: Track[]; label: string } | null>(null);
  const setAddTrack = (track: Track | null) => setAddTracks(track ? [track] : null);
  const notify = (text: string) => setToast(text);
  useEffect(() => {
    api("/me")
      .then(() => setLogged(true))
      .catch(() => setLogged(false));
    const expired = () => setLogged(false);
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 280);
    return () => clearTimeout(id);
  }, [search]);
  useEffect(() => {
    if (!logged) return;
    let active = true;
    const load = () =>
      api<Stats>("/stats")
        .then((s) => {
          if (!active) return;
          setStats(s);
          if (scanWasRunning.current && !s.scan.running)
            setRefresh((n) => n + 1);
          scanWasRunning.current = s.scan.running;
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [logged]);
  useEffect(() => {
    if (logged)
      api<Playlist[]>("/playlists")
        .then(setPlaylists)
        .catch((e) => notify(e.message));
  }, [logged, refresh]);
  useEffect(() => {
    if (!logged) return;
    let active = true;
    setLoading(true);
    setOnline(null);
    (async () => {
      if (view === "settings") {
        const s = await api<Record<string, unknown>>("/settings");
        if (active) setSettings(s);
        return;
      }
      if (view.startsWith("playlist:")) {
        const p = await api<Playlist>("/playlists/" + view.slice(9));
        if (active) {
          setSelected(p);
          setTracks(p.tracks || []);
          setTotal(p.tracks?.length || 0);
        }
        return;
      }
      setSelected(null);
      const p = new URLSearchParams({
        q: query,
        offset: String(offset),
        limit: "100",
      });
      if (view === "favorites") p.set("favorite", "true");
      if (view === "recent") p.set("sort", "played");
      if (view === "home") p.set("sort", "random");
      if (view === "folders" && folder) p.set("folder", folder);
      if (view === "album" && album) {
        p.set("album", album.album);
        p.set("album_artist", album.album_artist);
      }
      const result = await api<{ items: Track[]; total: number }>(
        "/tracks?" + p,
      );
      if (active) {
        setTracks(result.items);
        setTotal(result.total);
      }
      if (view === "home" || view === "albums") {
        const a = await api<Album[]>("/albums?q=" + encodeURIComponent(query) + (view === "home" ? "&sort=random" : ""));
        if (active) {
          setAlbums(a);
          setMoreAlbums(a.length === 60);
        }
      }
      if (view === "folders") {
        const f = await api<FolderItem[]>(
          "/folders?parent=" + encodeURIComponent(folder),
        );
        if (active) setFolders(f);
      }
    })()
      .catch((e) => notify(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [logged, view, query, folder, album, offset, refresh]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "summer-queue",
        JSON.stringify(
          queue
            .slice(0, 1000)
            .map((t) => ({ ...t, tags: {}, metadata: {}, ai_tags: {} })),
        ),
      );
    } catch {
      /* Playback remains usable when browser storage is full or disabled. */
    }
  }, [queue]);
  useEffect(() => {
    localStorage.setItem("summer-quality", quality);
  }, [quality]);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume, logged]);
  useEffect(() => {
    if (!current || !audio.current) return;
    setBuffering(wantPlay.current);
    recorded.current = "";
    audio.current.load();
    if (wantPlay.current)
      audio.current.play().catch(() => {
        setPlaying(false);
        setBuffering(false);
        if (!isNative) notify("浏览器暂未允许自动播放，请点击底部播放按钮继续");
      });
  }, [current?.id, quality, logged]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, chatBusy]);
  useEffect(() => {
    if (detail && !stats?.tags.running)
      api<Track>("/tracks/" + detail.id)
        .then(setDetail)
        .catch(() => {});
  }, [detail?.id, stats?.tags.running, stats?.tags.done]);
  useEffect(() => {
    if (!current || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album,
      artwork: current.cover
        ? [
            {
              src: location.origin + "/api/covers/" + current.cover,
              sizes: "900x900",
              type: "image/jpeg",
            },
          ]
        : [],
    });
    navigator.mediaSession.setActionHandler("play", () =>
      audio.current?.play(),
    );
    navigator.mediaSession.setActionHandler("pause", () =>
      audio.current?.pause(),
    );
    navigator.mediaSession.setActionHandler("nexttrack", () => next(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => next(-1));
    navigator.mediaSession.setActionHandler("seekto", (d) => {
      if (audio.current && d.seekTime !== undefined)
        audio.current.currentTime = d.seekTime;
    });
  }, [current?.id, index, queue, shuffle]);
  function navigate(nextView: string) {
    setView(nextView);
    setOffset(0);
    setSearch("");
    setMobileNav(false);
    if (nextView === "folders") setFolder("");
  }
  function play(list: Track[], at = 0) {
    if (!list.length) return;
    wantPlay.current = true;
    restorePosition.current = 0;
    if (list[at]?.id === current?.id) {
      setQueue(list);
      setIndex(at);
      audio.current?.play().catch(() => notify("请点击播放按钮开始播放"));
    } else {
      setQueue(list);
      setIndex(at);
    }
    setQueueOpen(false);
  }
  async function playFeaturedAlbum() {
    return queueAlbum(albums[0], "replace");
  }
  async function queueAlbum(featured: Album | undefined, mode: QueueAction) {
    if (!featured || featuredBusy || loading) return;
    setFeaturedBusy(true);
    try {
      // Use the displayed album identity, not the independent random discovery list.
      const params = new URLSearchParams({ album: featured.album, album_artist: featured.album_artist, limit: "300", sort: "folder" });
      const list: Track[] = [];
      let count = 1;
      while (list.length < count) {
        params.set("offset", String(list.length));
        const result = await api<{ items: Track[]; total: number }>("/tracks?" + params);
        count = result.total;
        if (!result.items.length) break;
        list.push(...result.items);
      }
      if (!list.length) { notify("这张专辑暂时没有可播放的歌曲，请刷新后重试"); return; }
      queueRecommendation(list, mode);
      notify(mode === "replace" ? `正在播放专辑：${featured.album}` : `已将专辑 ${featured.album} 的 ${list.length} 首歌曲加入队列`);
    } catch (error) { notify((error as Error).message); }
    finally { setFeaturedBusy(false); }
  }
  async function playAll() {
    if (selected || view === "home" || total <= tracks.length) {
      play(tracks);
      return;
    }
    notify("正在准备完整播放队列…");
    try {
      const params = new URLSearchParams({ q: query, limit: "300" });
      if (view === "folders" && folder) params.set("folder", folder);
      if (view === "album" && album) {
        params.set("album", album.album);
        params.set("album_artist", album.album_artist);
      }
      if (view === "favorites") params.set("favorite", "true");
      if (view === "recent") params.set("sort", "played");
      const all: Track[] = [];
      for (let start = 0; start < total; start += 300) {
        params.set("offset", String(start));
        const result = await api<{ items: Track[] }>("/tracks?" + params);
        all.push(...result.items);
        if (result.items.length < 300) break;
      }
      play(all);
      notify(`已加入 ${all.length.toLocaleString()} 首歌曲`);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function next(direction = 1) {
    if (!queue.length) return;
    wantPlay.current = true;
    restorePosition.current = 0;
    let n =
      shuffle && direction > 0
        ? Math.floor(Math.random() * queue.length)
        : (index + direction + queue.length) % queue.length;
    if (n === index && queue.length > 1) n = (index + 1) % queue.length;
    if (n === index && audio.current) {
      audio.current.currentTime = 0;
      audio.current.play().catch(() => {});
    } else setIndex(n);
  }
  function toggle() {
    if (!current) {
      play(tracks);
      return;
    }
    wantPlay.current = !playing;
    if (playing) audio.current?.pause();
    else
      audio.current
        ?.play()
        .catch(() => notify("无法开始播放，请检查音源或选择兼容音质"));
  }
  function changeQuality(q: string) {
    restorePosition.current = audio.current?.currentTime || 0;
    wantPlay.current = playing;
    setQuality(q);
  }
  async function favorite(t: Track) {
    try {
      await api("/tracks/" + t.id + "/favorite", "PUT", {
        favorite: !t.favorite,
      });
      const update = (a: Track[]) =>
        a.map((x) =>
          x.id === t.id ? { ...x, favorite: t.favorite ? 0 : 1 } : x,
        );
      setTracks(update);
      setQueue(update);
      setRefresh((n) => n + 1);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function newPlaylist(initial: Track[] = []) {
    const name = window.prompt("给歌单取个名字", "新的音乐时光");
    if (!name?.trim()) return;
    try {
      const p = await api<Playlist>("/playlists", "POST", {
        name,
        track_ids: initial.map((t) => t.id),
      });
      setRefresh((n) => n + 1);
      navigate("playlist:" + p.id);
      notify("歌单已保存");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function savePlaylist(p: Playlist, list: Track[], name = p.name) {
    try {
      const result = await api<Playlist>("/playlists/" + p.id, "PUT", {
        name,
        description: p.description,
        track_ids: list.map((t) => t.id),
        expected_revision: p.revision,
      });
      setSelected(result);
      if (view === "playlist:" + p.id) setTracks(result.tracks || []);
      setRefresh((n) => n + 1);
      notify("歌单已更新，可撤销");
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  }
  async function addTo(p: Playlist, list: Track[]) {
    try {
      const latest = await api<Playlist>("/playlists/" + p.id);
      if (await savePlaylist(latest, [...(latest.tracks || []), ...list])) setAddTracks(null);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function queueRecommendation(list: Track[], mode: QueueAction) {
    if (!list.length) return;
    if (mode === "replace") { play(list); notify(`已替换播放队列，共 ${list.length} 首`); return; }
    if (mode === "play") {
      const at = current ? index + 1 : 0;
      play([...queue.slice(0, at), ...list, ...queue.slice(at)], at);
      return;
    }
    setQueue(q => {
      const at = mode === "next" && current ? index + 1 : q.length;
      return [...q.slice(0, at), ...list, ...q.slice(at)];
    });
    if (!current) { setIndex(0); wantPlay.current = false; }
    notify(`已将 ${list.length} 首${mode === "next" ? "插到当前歌曲后" : "追加队尾"}，未替换原队列`);
  }
  async function send(text = input, autoPlay = false) {
    if (!text.trim() || chatBusy) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setChatBusy(true);
    setAiOpen(true);
    try {
      const result = await api<Recommendation>("/ai/chat", "POST", {
        message: text,
        history: history.slice(-12),
        playlist_id: !autoPlay && view.startsWith("playlist:") ? view.slice(9) : null,
        scope: autoPlay ? { kind: "library" } : recommendationScope,
        exclude_ids: autoPlay ? queue.map(t => t.id).slice(0, 150) : [],
      });
      setMessages((m) => [
        ...m,
        { role: "assistant", content: result.message, result },
      ]);
      if (autoPlay && result.tracks.length) { play(result.tracks); notify("Shuffle 已生成新的播放队列"); }
      else if (autoPlay) notify("没有找到合适的新歌曲，原播放队列保持不变");
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: (e as Error).message },
      ]);
    } finally {
      setChatBusy(false);
    }
  }
  async function applyRecommendation(r: Recommendation) {
    try {
      if ((r.action === "replace" || r.action === "append") && r.playlist_id) {
        const p = await api<Playlist>("/playlists/" + r.playlist_id);
        await savePlaylist(
          p,
          r.action === "append" ? [...(p.tracks || []), ...r.tracks] : r.tracks,
        );
        navigate("playlist:" + p.id);
      } else {
        const p = await api<Playlist>("/playlists", "POST", {
          name: r.name,
          track_ids: r.tracks.map((t) => t.id),
        });
        setRefresh((n) => n + 1);
        navigate("playlist:" + p.id);
        notify("AI 歌单已保存");
      }
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const recommendationScope = view === "album" && album
    ? { kind: "album", album: album.album, album_artist: album.album_artist }
    : view === "folders" && folder ? { kind: "folder", folder }
    : view.startsWith("playlist:") ? { kind: "playlist", playlist_id: view.slice(9) }
    : view === "favorites" ? { kind: "favorites" }
    : view === "recent" ? { kind: "recent" }
    : { kind: "library" };
  const recommendationScopeLabel = recommendationScope.kind === "album" ? `专辑 · ${album?.album}`
    : recommendationScope.kind === "folder" ? `文件夹 · ${folder}（含子目录）`
    : recommendationScope.kind === "playlist" ? `歌单 · ${selected?.name || "当前歌单"}`
    : recommendationScope.kind === "favorites" ? "我喜欢的音乐"
    : recommendationScope.kind === "recent" ? "最近播放" : "整个乐库";
  async function runScan() {
    try {
      await api("/scan", "POST", { folder: view === "folders" ? folder : "" });
      notify("已加入增量扫描队列");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function runTags(ids: string[] = []) {
    try {
      const r = await api<{ queued: number }>("/ai/tags", "POST", {
        track_ids: ids,
      });
      notify(`已加入 ${r.queued} 首歌曲的 AI 标签任务`);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const title =
    view === "home"
      ? "为此刻，找到一首歌。"
      : view === "folders"
        ? folder.split("/").pop() || "文件夹"
        : view === "albums"
          ? "专辑收藏"
          : view === "favorites"
            ? "我喜欢的音乐"
            : view === "recent"
              ? "最近播放"
              : view === "album"
                ? album?.album
                : view === "settings"
                  ? "音乐库管理"
                  : selected?.name || "我的音乐";
  const subtitle =
    view === "home"
      ? "让熟悉的旋律，遇见新的心情。"
      : view === "settings"
        ? "照顾好你的每一份音乐收藏。"
        : `${total.toLocaleString()} 首歌曲 · 属于你的音乐世界`;
  const navItems = [
    { id: "home", icon: Home, label: "发现音乐" },
    { id: "folders", icon: Folder, label: "文件夹" },
    { id: "albums", icon: Disc3, label: "专辑" },
    { id: "favorites", icon: Heart, label: "我喜欢" },
    { id: "recent", icon: History, label: "最近播放" },
  ];
  const trackRows = (list: Track[], compact = false) => (
    <div className={"track-list " + (compact ? "compact" : "")}>
      <div className="table-head">
        <span>#</span>
        <span>歌曲 / 艺术家</span>
        <span className="album-col">专辑</span>
        <span className="quality-col">音源</span>
        <span>时长</span>
        <span />
      </div>
      {list.map((t, i) => (
        <div
          className={
            "track-row " +
            (current?.id === t.id ? "active" : "") +
            (!t.available ? " unavailable" : "")
          }
          key={t.id}
          onDoubleClick={() => play(list, i)}
        >
          <button
            className="row-number icon-button"
            title="播放"
            onClick={() => play(list, i)}
          >
            {current?.id === t.id && playing ? (
              <AudioLines size={17} />
            ) : (
              <>
                <span>{String(i + offset + 1).padStart(2, "0")}</span>
                <Play className="row-play" size={15} fill="currentColor" />
              </>
            )}
          </button>
          <button className="track-main" onClick={() => play(list, i)}>
            <Cover cover={t.cover} title={t.album} />
            <span>
              <strong>{t.title}</strong>
              <small>
                {t.artist || "未知艺术家"}
                {t.cue_path ? " · CUE" : ""}
              </small>
            </span>
          </button>
          <button
            className="album-col text-ellipsis subtle-button"
            onClick={() => {
              setDetail(t);
              setOnline(null);
            }}
          >
            {t.album}
          </button>
          <span className="quality-col">
            <span
              className={
                "format " +
                (["FLAC", "WAV", "AIFF"].includes(t.format) ? "lossless" : "")
              }
            >
              {t.format}
            </span>
          </span>
          <span className="time">{fmt(t.duration)}</span>
          <div className="row-actions">
            <button
              className={"icon-button " + (t.favorite ? "liked" : "")}
              title="收藏"
              onClick={() => favorite(t)}
            >
              <Heart size={16} fill={t.favorite ? "currentColor" : "none"} />
            </button>
            <button
              className="icon-button"
              title="加入歌单"
              onClick={() => setAddTrack(t)}
            >
              <Plus size={17} />
            </button>
            <button
              className="icon-button"
              title="歌曲详情"
              onClick={() => {
                setDetail(t);
                setOnline(null);
              }}
            >
              <MoreHorizontal size={18} />
            </button>
            {selected && (
              <>
                <button
                  className="icon-button"
                  title="上移"
                  disabled={i === 0}
                  onClick={() => {
                    const a = [...list];
                    [a[i - 1], a[i]] = [a[i], a[i - 1]];
                    savePlaylist(selected, a);
                  }}
                >
                  <ArrowUp size={15} />
                </button>
                <button
                  className="icon-button"
                  title="下移"
                  disabled={i === list.length - 1}
                  onClick={() => {
                    const a = [...list];
                    [a[i + 1], a[i]] = [a[i], a[i + 1]];
                    savePlaylist(selected, a);
                  }}
                >
                  <ArrowDown size={15} />
                </button>
                <button
                  className="icon-button"
                  title="从歌单移除"
                  onClick={() =>
                    savePlaylist(
                      selected,
                      list.filter((x) => x.id !== t.id),
                    )
                  }
                >
                  <X size={15} />
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  if (logged === null)
    return (
      <div className="startup">
        <LoaderCircle className="spin" />
        <span>打开你的音乐世界</span>
      </div>
    );
  if (!logged)
    return (
      <div className="login-screen">
        <div className="login-art">
          <div className="login-vinyl" />
          <span className="eyebrow">YOUR MUSIC, YOUR MOMENT.</span>
          <h1>
            每一个夏天，
            <br />
            都有它的声音。
          </h1>
          <p>
            你的收藏，你的心情，
            <br />
            和刚刚好的下一首。
          </p>
        </div>
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoginBusy(true);
            setLoginError("");
            const data = new FormData(e.currentTarget);
            try {
              await api("/login", "POST", {
                username: data.get("username"),
                password: data.get("password"),
              });
              setLogged(true);
            } catch (e) {
              setLoginError((e as Error).message);
            } finally {
              setLoginBusy(false);
            }
          }}
        >
          <div className="brand">
            <span className="brand-icon">
              <AudioLines />
            </span>
            summer<span className="brand-dot">.</span>
          </div>
          <span className="eyebrow">你的私人音乐空间</span>
          <h2>欢迎回来</h2>
          <p className="muted">把音乐留给自己，把下一首交给灵感。</p>
          <label>
            用户名
            <input
              name="username"
              defaultValue="admin"
              autoComplete="username"
              required
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {loginError && <div className="form-error">{loginError}</div>}
          <button className="primary" disabled={loginBusy}>
            {loginBusy ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <ArrowRight size={18} />
            )}
            进入音乐空间
          </button>
          <small className="muted">私人曲库 · 原音播放 · AI 灵感</small>
        </form>
      </div>
    );

  return (
    <div className={"app " + (aiOpen ? "with-ai" : "")}>
      <aside className={"sidebar " + (mobileNav ? "mobile-open" : "")}>
        <div className="brand">
          <span className="brand-icon">
            <AudioLines />
          </span>
          summer<span className="brand-dot">.</span>
          <button
            className="mobile-only icon-button"
            onClick={() => setMobileNav(false)}
            aria-label="关闭菜单"
          >
            <X />
          </button>
        </div>
        <span className="side-caption">我的音乐空间</span>
        <nav>
          {navItems.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "selected" : ""}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={19} />
              {n.label}
              {n.id === "favorites" && !!stats?.favorites && (
                <span className="nav-count">{stats.favorites}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="side-section">
          <span className="side-caption">我的歌单</span>
          <button
            className="icon-button"
            title="新建歌单"
            onClick={() => newPlaylist()}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="playlist-nav">
          {playlists.map((p) => (
            <button
              className={view === "playlist:" + p.id ? "selected" : ""}
              key={p.id}
              onClick={() => navigate("playlist:" + p.id)}
            >
              <ListMusic size={17} />
              <span className="text-ellipsis">{p.name}</span>
              <small>{p.count}</small>
            </button>
          ))}
          {!playlists.length && (
            <button className="empty-playlist" onClick={() => newPlaylist()}>
              <Plus size={16} />
              创建第一张歌单
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="library-status">
            <span className="status-dot" />
            <span>
              {stats?.scan.running ? "正在整理音乐库" : "本地音乐库"}
              <small>
                {stats?.tracks.toLocaleString() || "0"} 首音乐，随时聆听
              </small>
            </span>
          </div>
          <button
            className={view === "settings" ? "selected" : ""}
            onClick={() => navigate("settings")}
          >
            <Settings size={18} />
            音乐库管理
          </button>
          <button
            onClick={() =>
              api("/logout", "POST").then(() => {
                audio.current?.pause();
                setLogged(false);
              })
            }
          >
            <LogOut size={17} />
            退出登录
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            onClick={() => setMobileNav(true)}
            aria-label="打开菜单"
          >
            <Menu />
          </button>
          <div className="location-label">
            我的音乐<span>/</span>
            <span>{view === "home" ? "发现" : title}</span>
          </div>
          <label className="search">
            <Search size={17} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索歌曲、歌手、专辑…"
            />
            {search && (
              <button
                className="icon-button"
                onClick={() => setSearch("")}
                aria-label="清空搜索"
              >
                <X size={14} />
              </button>
            )}
          </label>
          <button
            className={"ai-toggle " + (aiOpen ? "selected" : "")}
            onClick={() => setAiOpen(!aiOpen)}
          >
            <Sparkles size={16} />
            <span>音乐灵感</span>
          </button>
          <span className="avatar">S</span>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {view === "home"
                  ? "A LITTLE SOUNDTRACK FOR YOUR DAY"
                  : "YOUR PERSONAL COLLECTION"}
              </span>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
            {view !== "settings" && (
              <button
                className="icon-button refresh-button"
                title="刷新页面数据"
                disabled={loading || featuredBusy}
                onClick={() => { if (view === "home") setInspirations(previous => nextInspirations(previous)); setRefresh((n) => n + 1); notify(view === "home" ? "正在换一批专辑、歌曲与灵感…" : "正在刷新页面数据…"); }}
              >
                <RefreshCw size={18} className={loading ? "spin" : ""} />
              </button>
            )}
          </div>
          {view === "home" && !query && (
            <>
              <section className="hero">
                <div className="hero-copy">
                  <span className="pill">
                    <span />
                    PRIVATE COLLECTION · ORIGINAL SOUND
                  </span>
                  <h2>
                    好音乐，
                    <br />
                    值得慢慢听。
                  </h2>
                  <p>
                    从你的收藏出发，发现与此刻共鸣的旋律。
                    <br />
                    告诉 AI 你的心情，让下一首恰到好处。
                  </p>
                  <div className="hero-actions">
                    <button className="primary" onClick={playFeaturedAlbum} disabled={loading || featuredBusy || !albums.length} title={albums[0] ? `播放封面专辑：${albums[0].album}` : "等待专辑加载"}>
                      <Play size={16} fill="currentColor" />
                      {featuredBusy ? "正在准备…" : "开始聆听"}
                    </button>
                    <button
                      className="hero-ai"
                      onClick={() => {
                        setAiOpen(true);
                        setInput("从我的曲库推荐一些适合此刻放松的歌曲");
                      }}
                    >
                      <Sparkles size={16} />让 AI 来选
                      <ArrowRight size={16} />
                    </button>
                  </div>
                </div>
                <div className="hero-art">
                  <div className="vinyl">
                    <div />
                  </div>
                  <button className="hero-album" onClick={playFeaturedAlbum} disabled={loading || featuredBusy || !albums.length} aria-label={albums[0] ? `播放封面专辑：${albums[0].album}` : "等待专辑加载"}>
                    <Cover
                      cover={albums[0]?.cover}
                      title={albums[0]?.album || "Summer Session"}
                    />
                    <div>
                      <span>点击聆听这张专辑</span>
                      <strong>
                        {albums[0]?.album || "The sound of summer"}
                      </strong>
                      <small>
                        {albums[0]?.artist || "Made for your moments"}
                      </small>
                    </div>
                  </button>
                  <span className="hero-stamp">
                    LOVE YOUR
                    <br />
                    COLLECTION ↗
                  </span>
                </div>
              </section>
              <div className="collection-stats">
                <span>
                  <strong>{stats?.tracks.toLocaleString() || "—"}</strong>
                  首珍藏音乐
                </span>
                <span>
                  <strong>{stats?.albums.toLocaleString() || "—"}</strong>张专辑
                </span>
                <span>
                  <strong>
                    {Math.round((stats?.duration || 0) / 3600).toLocaleString()}
                  </strong>
                  小时的陪伴
                </span>
                <div>
                  <span className="status-dot" />
                  无损原音，忠于每一个细节
                </div>
              </div>
              <section className="shuffle-inspiration" aria-label="Shuffle 灵感电台">
                <div className="section-title"><div><h2><Shuffle size={19} /> Shuffle 灵感电台</h2><span>从整个乐库发现新歌 · 点击短语生成并播放新队列</span></div>
                  <button className="text-button" title="刷新灵感短语" onClick={() => setInspirations(previous => nextInspirations(previous))}><RefreshCw size={15} />换一批</button></div>
                <div className="shuffle-phrases">{inspirations.map(phrase => <button key={phrase} disabled={chatBusy} onClick={() => void send(`请从我的整个乐库挑选歌曲：${phrase}。不要保存或修改歌单。`, true)}><Sparkles size={16} /><span>{phrase}</span><Play size={14} /></button>)}</div>
                {chatBusy && <p role="status">AI 正在挑选歌曲，原队列仍可继续播放…</p>}
              </section>
              <div className="section-title">
                <div>
                  <h2>封面里的故事</h2>
                  <span>重新遇见你的专辑收藏</span>
                </div>
                <button
                  className="text-button"
                  onClick={() => navigate("albums")}
                >
                  查看全部
                  <ArrowRight size={16} />
                </button>
              </div>
              <div className="album-grid home-albums">
                {albums.slice(0, 5).map((a, i) => (
                  <button
                    className="album-card"
                    key={a.album + a.album_artist + i}
                    onClick={() => {
                      setAlbum(a);
                      navigate("album");
                    }}
                  >
                    <div className="album-art">
                      <Cover cover={a.cover} title={a.album} />
                      <span className="album-play">
                        <Play fill="currentColor" size={21} />
                      </span>
                    </div>
                    <strong>{a.album}</strong>
                    <small>{a.artist || "未知艺术家"}</small>
                  </button>
                ))}
              </div>
              <div className="inspiration-strip">
                <span className="sparkle-box">
                  <Sparkles size={23} />
                </span>
                <div>
                  <strong>今天，想听点什么？</strong>
                  <p>一句话，让你的音乐收藏有新的打开方式。</p>
                </div>
                <button
                  onClick={() => send("从我的曲库挑选适合安静工作的纯音乐")}
                >
                  专注工作
                  <ArrowRight size={14} />
                </button>
                <button onClick={() => send("推荐适合夜晚放松的歌曲")}>
                  夜晚放松
                  <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}
          {view === "folders" && (
            <>
              <div className="breadcrumbs">
                <button onClick={() => setFolder("")}>音乐库</button>
                {folder
                  .split("/")
                  .filter(Boolean)
                  .map((p, i, a) => (
                    <React.Fragment key={i}>
                      <ChevronRight size={14} />
                      <button
                        onClick={() => {
                          setFolder(a.slice(0, i + 1).join("/"));
                          setOffset(0);
                        }}
                      >
                        {p}
                      </button>
                    </React.Fragment>
                  ))}
              </div>
              <div className="folder-grid">
                {folders.map((f) => (
                  <button
                    className="folder-card"
                    key={f.path}
                    onClick={() => {
                      setFolder(f.path);
                      setOffset(0);
                    }}
                  >
                    <Cover cover={f.cover} title={f.name} />
                    <div>
                      <strong>{f.name}</strong>
                      <small>
                        <Folder size={12} />
                        {f.count} 首歌曲
                      </small>
                    </div>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            </>
          )}
          {view === "albums" && (
            <>
              <div className="album-grid">
                {albums.map((a, i) => (
                  <button
                    className="album-card"
                    key={a.album + a.album_artist + i}
                    onClick={() => {
                      setAlbum(a);
                      navigate("album");
                    }}
                  >
                    <div className="album-art">
                      <Cover cover={a.cover} title={a.album} />
                      <span className="album-play">
                        <Play fill="currentColor" size={21} />
                      </span>
                    </div>
                    <strong>{a.album}</strong>
                    <small>
                      {a.artist || "未知艺术家"} · {a.count} 首
                    </small>
                  </button>
                ))}
              </div>
              {moreAlbums && (
                <button
                  className="secondary"
                  onClick={() =>
                    api<Album[]>(
                      "/albums?offset=" +
                        albums.length +
                        "&q=" +
                        encodeURIComponent(query),
                    )
                      .then((a) => {
                        setAlbums((old) => [...old, ...a]);
                        setMoreAlbums(a.length === 60);
                      })
                      .catch((e) => notify(e.message))
                  }
                >
                  加载更多专辑
                </button>
              )}
            </>
          )}
          {view === "album" && album && (
            <section className="album-banner">
              <Cover cover={album.cover} title={album.album} />
              <div>
                <span className="eyebrow">ALBUM</span>
                <h2>{album.album}</h2>
                <p>
                  {album.artist} · {album.year || "年份未知"} · {total} 首歌曲
                </p>
                <button className="primary" onClick={playAll}>
                  <Play size={17} fill="currentColor" />
                  播放专辑
                </button>
              </div>
            </section>
          )}
          {view === "settings" ? (
            <div className="settings-grid">
              <section className="settings-card">
                <span className="setting-icon">
                  <Folder />
                </span>
                <h2>音乐库索引</h2>
                <p className="muted">{String(settings?.music_root || "")}</p>
                <dl>
                  <dt>状态</dt>
                  <dd>{stats?.scan.phase || "等待扫描"}</dd>
                  <dt>核对文件</dt>
                  <dd>{stats?.scan.visited.toLocaleString()}</dd>
                  <dt>重新解析</dt>
                  <dd>{stats?.scan.updated.toLocaleString()}</dd>
                  <dt>保持索引</dt>
                  <dd>{stats?.scan.unchanged.toLocaleString()}</dd>
                  <dt>失败记录</dt>
                  <dd>{stats?.scan.error_count || 0}</dd>
                </dl>
                <button
                  className="primary"
                  onClick={runScan}
                  disabled={stats?.scan.running}
                >
                  <RefreshCw
                    size={16}
                    className={stats?.scan.running ? "spin" : ""}
                  />
                  增量扫描音乐库
                </button>
                <p className="fine-print">
                  原音文件只读。自动监听文件变化，每小时核对清单；未变化的音源不重复提取。
                </p>
                {!!stats?.scan.errors.length && (
                  <details>
                    <summary>查看扫描异常</summary>
                    {stats.scan.errors.map((e, i) => (
                      <p className="error-record" key={i}>
                        {e.path}
                        <br />
                        {e.error}
                      </p>
                    ))}
                  </details>
                )}
              </section>
              <section className="settings-card">
                <span className="setting-icon">
                  <Sparkles />
                </span>
                <h2>AI 音乐助手</h2>
                <p className="muted">
                  {String(settings?.ai_model || "DeepSeek")} ·{" "}
                  {settings?.ai_configured ? "已配置" : "待配置"}
                </p>
                <dl>
                  <dt>今日请求</dt>
                  <dd>
                    {stats?.ai_usage.requests || 0} /{" "}
                    {String(settings?.ai_daily_limit || 200)}
                  </dd>
                  <dt>输入 / 输出 tokens</dt>
                  <dd>
                    {stats?.ai_usage.input_tokens || 0} /{" "}
                    {stats?.ai_usage.output_tokens || 0}
                  </dd>
                  <dt>标签任务</dt>
                  <dd>
                    {stats?.tags.running
                      ? `${stats.tags.done}/${stats.tags.total}`
                      : "空闲"}
                  </dd>
                  <dt>标签任务失败</dt>
                  <dd>{stats?.tags.errors || 0}</dd>
                </dl>
                <button
                  className="primary"
                  onClick={() => runTags()}
                  disabled={stats?.tags.running}
                >
                  <Sparkles size={16} />
                  补全下一批 60 首标签
                </button>
                <p className="fine-print">
                  AI 标签基于元数据推断，保留来源，不覆盖原始标签。每批最多 60
                  首，支持缓存与重试。
                </p>
              </section>
              <section className="settings-card">
                <span className="setting-icon">
                  <AudioLines />
                </span>
                <h2>播放与连接</h2>
                <dl>
                  <dt>原音播放</dt>
                  <dd>源文件直出 + Range</dd>
                  <dt>转码缓存上限</dt>
                  <dd>{String(settings?.cache_limit_gb || 10)} GB</dd>
                  <dt>WebDAV</dt>
                  <dd>
                    {settings?.webdav_configured ? "服务端已配置" : "待配置"}
                  </dd>
                  <dt>部署模式</dt>
                  <dd>
                    {settings?.public_https ? "HTTPS 公网" : "局域网测试"}
                  </dd>
                </dl>
                <button
                  className="secondary"
                  onClick={() =>
                    api<{ mode: string }>("/webdav/check", "POST")
                      .then((r) => notify("WebDAV 连接成功：" + r.mode))
                      .catch((e) => notify(e.message))
                  }
                >
                  检查 WebDAV 连接
                </button>
                <p className="fine-print">
                  同机播放优先使用本地目录。公网映射前请按 README 配置 HTTPS
                  与安全 Cookie。
                </p>
              </section>
              <section className="settings-card">
                <h2>音乐库构成</h2>
                {stats?.formats.map((f) => (
                  <div className="format-stat" key={f.format}>
                    <span className="format">{f.format}</span>
                    <div>
                      <span
                        style={{
                          width: (f.count / (stats.tracks || 1)) * 100 + "%",
                        }}
                      />
                    </div>
                    <span>{f.count.toLocaleString()}</span>
                  </div>
                ))}
              </section>
            </div>
          ) : (
            view !== "albums" && (
              <>
                <div className="section-title">
                  <div>
                    <h2>
                      {view === "home"
                        ? query
                          ? "搜索结果"
                          : "随机发现"
                        : view === "folders"
                          ? "目录中的音乐"
                          : selected
                            ? "歌单曲目"
                            : "歌曲"}
                    </h2>
                    {view === "home" && !query && (
                      <span>刷新换一批，让不常听的收藏也被听见</span>
                    )}
                  </div>
                  <div className="list-toolbar">
                    {view === "home" && !query && <select aria-label="首页推荐类型" value={homeRecommendationType} onChange={e => setHomeRecommendationType(e.target.value)}><option value="tracks">随机歌曲</option><option value="albums">随机专辑</option></select>}
                    <button className="text-button" onClick={playAll} hidden={view === "home" && !query && homeRecommendationType === "albums"}>
                      <Play size={15} />
                      播放{view === "home" ? "" : "全部"}
                    </button>
                    {view === "folders" && (
                      <button
                        className="icon-button"
                        title="重新核对当前目录"
                        onClick={runScan}
                      >
                        <RefreshCw size={16} />
                      </button>
                    )}
                    {selected ? (
                      <>
                        <button
                          className="icon-button"
                          title="撤销歌单修改"
                          onClick={() =>
                            api("/playlists/" + selected.id + "/undo", "POST")
                              .then(() => {
                                setRefresh((n) => n + 1);
                                notify("已撤销修改");
                              })
                              .catch((e) => notify(e.message))
                          }
                        >
                          <Undo2 size={17} />
                        </button>
                        <button
                          className="icon-button"
                          title="重命名歌单"
                          onClick={() => {
                            const n = window.prompt("歌单名称", selected.name);
                            if (n?.trim()) savePlaylist(selected, tracks, n);
                          }}
                        >
                          <Info size={17} />
                        </button>
                        <button
                          className="icon-button"
                          title="删除歌单"
                          onClick={() => {
                            if (
                              window.confirm(
                                "删除歌单“" +
                                  selected.name +
                                  "”？音乐文件会保留。",
                              )
                            )
                              api("/playlists/" + selected.id, "DELETE")
                                .then(() => {
                                  setRefresh((n) => n + 1);
                                  navigate("home");
                                })
                                .catch((e) => notify(e.message));
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    ) : (
                      <button
                        className="text-button"
                        onClick={() => newPlaylist(tracks)}
                        hidden={view === "home" && !query && homeRecommendationType === "albums"}
                      >
                        <Plus size={15} />
                        存为歌单
                      </button>
                    )}
                  </div>
                </div>
                {loading ? (
                  <div className="empty-state">
                    <LoaderCircle className="spin" />
                    正在打开音乐收藏…
                  </div>
                ) : view === "home" && !query && homeRecommendationType === "albums" ? (
                  <div className="album-grid random-albums">{albums.slice(0, 12).map(a => <article className="random-album" key={a.album + "|" + a.album_artist}>
                    <button className="album-card" onClick={() => { setAlbum(a); navigate("album"); }}><Cover cover={a.cover} title={a.album} /><strong>{a.album}</strong><small>{a.artist} · {a.count} 首</small></button>
                    <div><button className="secondary" disabled={featuredBusy} onClick={() => void queueAlbum(a, "replace")}>替换并播放</button><button className="secondary" disabled={featuredBusy} onClick={() => void queueAlbum(a, "append")}>追加队尾</button></div>
                  </article>)}</div>
                ) : tracks.length ? (
                  trackRows(
                    view === "home" && !query ? tracks.slice(0, 12) : tracks,
                  )
                ) : (
                  <div className="empty-state">
                    <Music2 size={34} />
                    <h3>
                      {stats?.scan.running
                        ? "正在发现你的音乐"
                        : "这里还没有歌曲"}
                    </h3>
                    <p>
                      {query
                        ? "试试其他歌曲、歌手或专辑名称。"
                        : selected
                          ? "从音乐库添加歌曲，或让 AI 帮你挑选。"
                          : "首次扫描可能需要几分钟，歌曲会陆续出现。"}
                    </p>
                    {!selected && (
                      <button className="secondary" onClick={runScan}>
                        扫描音乐库
                      </button>
                    )}
                  </div>
                )}
                {total > 100 && view !== "home" && !selected && (
                  <div className="pagination">
                    <button
                      className="secondary"
                      disabled={!offset}
                      onClick={() => setOffset(Math.max(0, offset - 100))}
                    >
                      <ArrowLeft size={15} />
                      上一页
                    </button>
                    <span>
                      {offset + 1}–{Math.min(offset + 100, total)} /{" "}
                      {total.toLocaleString()}
                    </span>
                    <button
                      className="secondary"
                      disabled={offset + 100 >= total}
                      onClick={() => setOffset(offset + 100)}
                    >
                      下一页
                      <ArrowRight size={15} />
                    </button>
                  </div>
                )}
              </>
            )
          )}
          <footer className="page-footer">
            <span>summer. / 给音乐一点自己的时间</span>
            <span>PRIVATE MUSIC SPACE</span>
          </footer>
        </div>
      </main>
      {aiOpen && (
        <aside className="ai-panel">
          <div className="ai-panel-head">
            <span className="sparkle-box">
              <Sparkles size={19} />
            </span>
            <div>
              <strong>音乐灵感</strong>
              <small>由 DeepSeek 提供支持</small>
            </div>
            <button
              className="icon-button"
              onClick={() => setAiOpen(false)}
              aria-label="关闭 AI 面板"
            >
              <X size={18} />
            </button>
          </div>
          <div className="chat-scroll">
            {!messages.length && (
              <div className="ai-welcome">
                <span className="ai-orb">
                  <Sparkles size={29} />
                </span>
                <span className="eyebrow">A SOUNDTRACK JUST FOR YOU</span>
                <h2>
                  你的心情，
                  <br />
                  我来选歌。
                </h2>
                <p>
                  聊聊今天的心情、正在做的事，
                  <br />
                  一起发现收藏里的另一种可能。
                </p>
                {[
                  "想听适合下雨天的日语歌",
                  "选一些安静的钢琴曲陪我工作",
                  "帮我创建一张夜晚放松的歌单",
                ].map((t) => (
                  <button
                    className="prompt-card"
                    key={t}
                    onClick={() => send(t)}
                  >
                    {t}
                    <ArrowUp size={15} />
                  </button>
                ))}
                <div className="ai-note">
                  <Check size={14} />
                  优先从你的本地音乐收藏中推荐
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div className={"message " + m.role} key={i}>
                {m.role === "assistant" && (
                  <span className="message-author">
                    <Sparkles size={13} />
                    SUMMER AI
                  </span>
                )}
                <p>{m.content}</p>
                {m.result && m.result.tracks.length > 0 && (
                  <RecommendationCard tracks={m.result.tracks} onQueue={queueRecommendation} onSave={setAddTracks}
                    action={m.result.action} onApply={["replace", "append"].includes(m.result.action) ? () => applyRecommendation(m.result!) : undefined} />
                )}
              </div>
            ))}
            {chatBusy && (
              <div className="thinking">
                <span />
                <span />
                <span />
                正在翻阅你的音乐收藏
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          <div className="chat-input-area">
            <span className="chat-context" title={recommendationScopeLabel}><Folder size={13} />推荐来源：{recommendationScopeLabel}</span>
            {selected && (
              <span className="chat-context">
                <ListMusic size={13} />
                正在讨论：{selected.name}
              </span>
            )}
            <form
              className="chat-input"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="此刻，你想听什么？"
                rows={2}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div>
                <span>↵ 发送 · Shift ↵ 换行</span>
                <button
                  className="send-button"
                  disabled={chatBusy || !input.trim()}
                  aria-label="发送"
                >
                  <Send size={17} />
                </button>
              </div>
            </form>
            <small>AI 可能出错，歌单修改会在应用后生效。</small>
          </div>
        </aside>
      )}
      <div className="player">
        <div className="now-playing">
          {current ? (
            <>
              <button
                className="cover-button"
                title="歌曲详情"
                onClick={() => {
                  setDetail(current);
                  setOnline(null);
                }}
              >
                <Cover cover={current.cover} title={current.album} />
              </button>
              <div>
                <strong>{current.title}</strong>
                <span>{current.artist || "未知艺术家"}</span>
                <small>{sourceQuality(current)}</small>
              </div>
              <button className="icon-button" title="根据当前歌曲推荐相似音乐" onClick={() => setSimilarSeeds({ tracks: [current], label: current.title + " · " + current.artist })}><Sparkles size={17} /></button>
              <button
                className={"icon-button " + (current.favorite ? "liked" : "")}
                onClick={() => favorite(current)}
                title="收藏"
              >
                <Heart
                  size={18}
                  fill={current.favorite ? "currentColor" : "none"}
                />
              </button>
            </>
          ) : (
            <>
              <Cover title="Summer" />
              <div>
                <strong>让音乐开始吧</strong>
                <span>挑一首喜欢的，或让 AI 来选</span>
              </div>
            </>
          )}
        </div>
        <div className="player-center">
          <div className="transport">
            <button
              className={"icon-button " + (shuffle ? "enabled" : "")}
              title="随机播放"
              onClick={() => setShuffle(!shuffle)}
            >
              <Shuffle size={17} />
            </button>
            <button
              className="icon-button"
              title="上一首"
              onClick={() => next(-1)}
            >
              <SkipBack size={20} fill="currentColor" />
            </button>
            <button
              className="play-button"
              title={playing ? "暂停" : "播放"}
              onClick={toggle}
            >
              {buffering ? (
                <LoaderCircle size={22} className="spin" />
              ) : playing ? (
                <Pause size={21} fill="currentColor" />
              ) : (
                <Play size={21} fill="currentColor" />
              )}
            </button>
            <button
              className="icon-button"
              title="下一首"
              onClick={() => next(1)}
            >
              <SkipForward size={20} fill="currentColor" />
            </button>
            <button
              className={
                "icon-button repeat-button " +
                (repeat !== "off" ? "enabled" : "")
              }
              title={
                "循环：" + { all: "列表", one: "单曲", off: "关闭" }[repeat]
              }
              onClick={() =>
                setRepeat(
                  repeat === "all" ? "one" : repeat === "one" ? "off" : "all",
                )
              }
            >
              <Repeat size={17} />
              {repeat === "one" && <sup>1</sup>}
            </button>
          </div>
          <div className="progress">
            <span>{fmt(position)}</span>
            <input
              aria-label="播放进度"
              type="range"
              min={0}
              max={duration || current?.duration || 1}
              step="0.1"
              value={Math.min(position, duration || current?.duration || 1)}
              style={
                {
                  "--progress": `${(position / (duration || current?.duration || 1)) * 100}%`,
                } as React.CSSProperties
              }
              onChange={(e) => {
                const n = Number(e.target.value);
                if (audio.current) audio.current.currentTime = n;
                setPosition(n);
              }}
            />
            <span>{fmt(duration || current?.duration || 0)}</span>
          </div>
        </div>
        <div className="player-options">
          {isNative ? <NativeOutput /> : <AudioOutput audio={audio} />}
          <select
            aria-label="音源质量"
            disabled={isNative}
            title={isNative ? "PC 客户端始终从原音解码为 PCM，不使用有损转码" : undefined}
            value={isNative ? "original" : quality}
            onChange={(e) => changeQuality(e.target.value)}
          >
            <option value="original">原音</option>
            <option value="lossless">兼容 FLAC</option>
            <option value="320">MP3 · 320k</option>
            <option value="192">MP3 · 192k</option>
            <option value="128">MP3 · 128k</option>
          </select>
          <div className="volume">
            <Volume2 size={17} />
            <input
              aria-label="音量"
              disabled={isNative}
              title={isNative ? "请使用 DAC 或功放的硬件音量" : undefined}
              type="range"
              min="0"
              max="1"
              step=".01"
              value={isNative ? 1 : volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>
          <button
            className={"icon-button " + (queueOpen ? "enabled" : "")}
            title="播放队列"
            onClick={() => {
              setQueuePage(Math.floor(index / 100));
              setQueueOpen(!queueOpen);
            }}
          >
            <ListMusic size={21} />
            <small>{queue.length}</small>
          </button>
        </div>
      </div>
      <audio
        ref={(element) => { audio.current = element; bindNativeAudio(element); }}
        data-track-id={current?.id}
        preload="metadata"
        src={
          !isNative && logged && current
            ? `/api/tracks/${current.id}/stream?quality=${quality}`
            : undefined
        }
        onPlay={() => {
          setPlaying(true);
          wantPlay.current = true;
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={() => {
          const el = audio.current;
          if (el) {
            setPosition(el.currentTime);
            if (
              current &&
              el.currentTime >= Math.min(20, current.duration / 2) &&
              recorded.current !== current.id
            ) {
              recorded.current = current.id;
              api("/tracks/" + current.id + "/played", "POST").catch(() => {});
            }
          }
        }}
        onLoadedMetadata={() => {
          if (audio.current) {
            setDuration(audio.current.duration);
            if (restorePosition.current) {
              audio.current.currentTime = Math.min(
                restorePosition.current,
                audio.current.duration,
              );
              restorePosition.current = 0;
            }
          }
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onEnded={() => {
          if (repeat === "one" && audio.current) {
            audio.current.currentTime = 0;
            audio.current.play().catch(() => {});
          } else if (repeat === "off" && index === queue.length - 1) {
            setPlaying(false);
            wantPlay.current = false;
          } else next(1);
        }}
        onError={() => {
          setBuffering(false);
          setPlaying(false);
          if (isNative) { wantPlay.current = false; notify(nativeError || "本机播放失败，请检查 DAC 和输出设置"); return; }
          if (current && quality === "original") {
            notify("浏览器无法播放此原音，正在尝试 MP3 兼容播放");
            wantPlay.current = true;
            setQuality("320");
          } else notify("音源播放失败，请在管理页检查扫描记录或尝试原音");
        }}
      />
      {queueOpen && (
        <div className="queue-panel">
          <div className="panel-title">
            <h3>
              播放队列 <small>{queue.length} 首</small>
            </h3>
            <button
              className="icon-button"
              onClick={() => setQueueOpen(false)}
              aria-label="关闭队列"
            >
              <X size={18} />
            </button>
          </div>
          <div className="queue-toolbar">
            <button className="text-button" disabled={!queue.length} onClick={() => setSimilarSeeds({ tracks: [...queue], label: "当前播放队列" })}><Sparkles size={15} />相似音乐</button>
            <button className="text-button" onClick={() => newPlaylist(queue)}>
              <Plus size={15} />
              保存为歌单
            </button>
            <button
              className="text-button"
              onClick={() => {
                audio.current?.pause();
                setQueue([]);
                setIndex(0);
                wantPlay.current = false;
              }}
            >
              清空
            </button>
          </div>
          <div className="queue-scroll">
            {queue.slice(queuePage * 100, queuePage * 100 + 100).map((t, j) => {
              const i = queuePage * 100 + j;
              return (
                <div
                  className={"queue-item " + (i === index ? "active" : "")}
                  key={t.id + i}
                >
                  <button onClick={() => play(queue, i)}>
                    <Cover cover={t.cover} title={t.album} />
                    <span>
                      <strong>{t.title}</strong>
                      <small>{t.artist}</small>
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    title="移除"
                    onClick={() => {
                      if (i === index) {
                        audio.current?.pause();
                        wantPlay.current = false;
                      }
                      setQueue(queue.filter((_, n) => n !== i));
                      if (i < index) setIndex(index - 1);
                      else if (index >= queue.length - 1)
                        setIndex(Math.max(0, index - 1));
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
              );
            })}
          </div>
          {queue.length > 100 && (
            <div className="pagination">
              <button
                className="icon-button"
                aria-label="上一页队列"
                disabled={queuePage === 0}
                onClick={() => setQueuePage((p) => p - 1)}
              >
                <ArrowLeft size={16} />
              </button>
              <span>
                {queuePage + 1} / {Math.ceil(queue.length / 100)}
              </span>
              <button
                className="icon-button"
                aria-label="下一页队列"
                disabled={(queuePage + 1) * 100 >= queue.length}
                onClick={() => setQueuePage((p) => p + 1)}
              >
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <section
            className="modal track-detail"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              onClick={() => setDetail(null)}
              aria-label="关闭详情"
            >
              <X />
            </button>
            <div className="detail-top">
              <Cover cover={detail.cover} title={detail.album} />
              <div>
                <span className="eyebrow">TRACK DETAILS</span>
                <h2>{detail.title}</h2>
                <p>{detail.artist || "未知艺术家"}</p>
                <span className="format lossless">{sourceQuality(detail)}</span>
              </div>
            </div>
            <dl>
              <dt>专辑</dt>
              <dd>{detail.album}</dd>
              <dt>流派 / 年份</dt>
              <dd>
                {detail.genre || "未标注"} / {detail.year || "未知"}
              </dd>
              <dt>时长 / 声道</dt>
              <dd>
                {fmt(detail.duration)} / {detail.channels}
              </dd>
              <dt>源文件</dt>
              <dd className="path-value">{detail.path}</dd>
              {detail.cue_path && (
                <>
                  <dt>CUE 索引</dt>
                  <dd>{detail.cue_path}</dd>
                </>
              )}
            </dl>
            <div className="detail-actions">
              <button
                className="primary"
                onClick={() => {
                  play([detail]);
                  setDetail(null);
                }}
              >
                <Play size={16} />
                播放歌曲
              </button>
              <button
                className="secondary"
                onClick={() => runTags([detail.id])}
              >
                <Sparkles size={16} />
                AI 标签
              </button>
              <button
                className="secondary"
                onClick={() =>
                  api("/tracks/" + detail.id + "/online", "POST")
                    .then(setOnline)
                    .catch((e) => notify(e.message))
                }
              >
                联网资料
              </button>
            </div>
            <h3>
              AI 标签 <small>基于元数据推断</small>
            </h3>
            {Object.keys(detail.ai_tags).length ? (
              <div className="tag-cloud">
                {Object.entries(detail.ai_tags)
                  .filter(([k]) => !["source", "version", "basis"].includes(k))
                  .map(([k, v]) => (
                    <span key={k}>
                      {k}: {Array.isArray(v) ? v.join(" / ") : String(v)}
                    </span>
                  ))}
              </div>
            ) : (
              <p className="muted">尚未生成。原始元数据始终保留。</p>
            )}
            {!!online && (
              <details open>
                <summary>联网候选资料（不自动覆盖）</summary>
                <pre>{JSON.stringify(online, null, 2)}</pre>
              </details>
            )}
            <details open>
              <summary>专业音乐信息</summary>
              <dl>
                {Object.entries(detail.metadata || {}).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>
                      {(
                        {
                          composer: "作曲",
                          lyricist: "作词",
                          conductor: "指挥",
                          performer: "演奏",
                          language: "语言",
                          label: "发行厂牌",
                          isrc: "ISRC",
                          copyright: "版权",
                          work: "作品",
                          movement: "乐章",
                          movement_number: "乐章编号",
                          bpm: "BPM（文件标签）",
                          musical_key: "调性（文件标签）",
                          track_total: "总曲数",
                          disc_total: "总碟数",
                          original_date: "原始发行日期",
                          release_type: "发行类型",
                          replaygain_track_gain: "曲目响度增益",
                          replaygain_album_gain: "专辑响度增益",
                          musicbrainz_recording_id: "MusicBrainz 录音",
                          musicbrainz_release_id: "MusicBrainz 发行",
                          comment: "备注",
                          lyrics: "歌词",
                        } as Record<string, string>
                      )[k] || k}
                    </dt>
                    <dd>{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </details>
            <details>
              <summary>全部原始标签</summary>
              <dl>
                {Object.entries(detail.tags).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </details>
          </section>
        </div>
      )}
      {similarSeeds && <SimilarityPanel label={similarSeeds.label} count={similarSeeds.tracks.length} onClose={() => setSimilarSeeds(null)}
        onRecommend={online => {
          const all = [...new Set(similarSeeds.tracks.map(t => t.id))];
          const ids = all.length <= 150 ? all : Array.from({ length: 150 }, (_, i) => all[Math.round(i * (all.length - 1) / 149)]);
          return api<SimilarResult<Track>>("/ai/similar", "POST", { seed_ids: ids, online });
        }} onQueue={queueRecommendation} onSave={setAddTracks} />}
      {addTracks && (
        <div className="modal-backdrop" onClick={() => setAddTrack(null)}>
          <section
            className="modal small-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-title">
              <h3>加入歌单</h3>
              <button
                className="icon-button"
                onClick={() => setAddTrack(null)}
                aria-label="关闭"
              >
                <X />
              </button>
            </div>
            <p className="muted">{addTracks.length === 1 ? addTracks[0].title : `已选择 ${addTracks.length} 首歌曲`} · 追加到已有歌单，不替换原内容</p>
            {playlists.map((p) => (
              <button
                className="playlist-choice"
                key={p.id}
                onClick={() => addTo(p, addTracks)}
              >
                <ListMusic size={18} />
                {p.name}
                <Plus size={17} />
              </button>
            ))}
            <button
              className="secondary"
              onClick={() => {
                newPlaylist(addTracks);
                setAddTrack(null);
              }}
            >
              <Plus size={16} />
              新建歌单
            </button>
            <button
              className="secondary"
              onClick={() => {
                queueRecommendation(addTracks, "append");
                setAddTrack(null);
                notify("已加入播放队列");
              }}
            >
              <ListMusic size={16} />
              加入播放队列
            </button>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Info size={17} />
          {toast}
          <button
            className="icon-button"
            onClick={() => setToast("")}
            aria-label="关闭提示"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
