import { createId } from "./id.js";

const SOURCE_KEY = "syncinema:sources";
const ACTIVE_SOURCE_KEY = "syncinema:active-source";

function decodeBase64Json(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("{")) return JSON.parse(raw);
  const normalized = raw.replace(/^kazumi:\/\//i, "").trim();
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function absolutize(url, baseURL) {
  try {
    return new URL(String(url || ""), baseURL).toString();
  } catch {
    return "";
  }
}

function xpathForNode(xpath) {
  const clean = String(xpath || "").trim();
  return clean.startsWith("//") ? `.${clean}` : clean;
}

function nodeTextOrHref(node, baseURL) {
  if (!node) return "";
  const href = node.getAttribute?.("href") || node.getAttribute?.("data-href") || node.getAttribute?.("src");
  if (href) return absolutize(href, baseURL);
  return String(node.textContent || "").trim();
}

function nodeHref(node, baseURL) {
  if (!node) return "";
  const target =
    node.getAttribute?.("href") ||
    node.getAttribute?.("data-href") ||
    node.getAttribute?.("src") ||
    node.querySelector?.("a[href], [data-href], source[src], video[src]")?.getAttribute("href") ||
    node.querySelector?.("a[href], [data-href], source[src], video[src]")?.getAttribute("data-href") ||
    node.querySelector?.("a[href], [data-href], source[src], video[src]")?.getAttribute("src") ||
    "";
  const url = absolutize(target, baseURL);
  return /^https?:\/\//i.test(url) ? url : "";
}

function nodeName(node) {
  return String(node?.textContent || node?.getAttribute?.("title") || node?.getAttribute?.("alt") || "").trim();
}

function directChildTitle(node, fallback = "") {
  const clone = node?.cloneNode?.(true);
  if (!clone) return fallback;
  clone.querySelectorAll?.("a, button, input, script, style").forEach((child) => child.remove());
  return compactText(clone.textContent || "") || fallback;
}

function normalizeForSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function compactText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function cleanResultName(rawName, keyword) {
  const text = compactText(rawName);
  const keywordKey = normalizeForSearch(keyword);
  const lines = text
    .split(/\n|(?=更新至\d)|(?=(?:19|20)\d{2}[\/\s])|(?=主演[:：])|(?=类型[:：])|(?=地区[:：])/)
    .map((line) => compactText(line))
    .filter(Boolean);
  const candidate =
    lines.find((line) => keywordKey && normalizeForSearch(line).includes(keywordKey)) ||
    lines.find((line) => !/^更新至\d|^(?:19|20)\d{2}[\/\s]|^主演[:：]|^类型[:：]|^地区[:：]/.test(line)) ||
    lines[0] ||
    text;

  const cleaned = compactText(candidate)
    .replace(/(?:19|20)\d{2}[\/\s].*$/, "")
    .replace(/更新至\d+集?.*$/, "")
    .replace(/主演[:：].*$/, "")
    .replace(/类型[:：].*$/, "")
    .replace(/地区[:：].*$/, "")
    .replace(/(.*?第[一二三四五六七八九十百\d]+季).*/, "$1")
    .replace(/(.*?第[一二三四五六七八九十百\d]+部).*/, "$1")
    .trim()
    .slice(0, 120);
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && normalizeForSearch(parts[0]) === normalizeForSearch(parts[1])) return parts[0];
  return cleaned;
}

function isRelevantResult(item, keyword) {
  const keywordKey = normalizeForSearch(keyword);
  if (!keywordKey) return true;
  const nameKey = normalizeForSearch(item.name);
  if (!nameKey || nameKey.length < Math.min(2, keywordKey.length)) return false;
  return nameKey.includes(keywordKey);
}

function uniqueResults(items) {
  const seen = new Set();
  const seenNames = new Set();
  return items.filter((item) => {
    const nameKey = normalizeForSearch(item.name);
    if (seenNames.has(nameKey)) return false;
    const key = `${nameKey}|${item.url.split("#")[0]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    seenNames.add(nameKey);
    return true;
  });
}

function scoreResult(item, keyword) {
  const keywordKey = normalizeForSearch(keyword);
  const nameKey = normalizeForSearch(item.name);
  if (!keywordKey) return 0;
  let score = 0;
  if (nameKey === keywordKey) score += 100;
  if (nameKey.startsWith(keywordKey)) score += 40;
  if (nameKey.includes(keywordKey)) score += 20;
  score -= Math.min(20, Math.max(0, item.name.length - keyword.length) / 4);
  return score;
}

function evaluateNodes(doc, xpath, context = doc) {
  if (!xpath) return [];
  const result = doc.evaluate(
    context === doc ? xpath : xpathForNode(xpath),
    context,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  );
  const nodes = [];
  for (let index = 0; index < result.snapshotLength; index += 1) {
    nodes.push(result.snapshotItem(index));
  }
  return nodes;
}

function parseHtml(html) {
  return new DOMParser().parseFromString(String(html || ""), "text/html");
}

function normalizeSourceConfig(config) {
  if (!config?.baseURL || !config?.searchURL) throw new Error("片源规则缺少 baseURL/searchURL");
  return {
    ...config,
    id: createId("source"),
    name: String(config.name || "自定义片源").slice(0, 80),
    baseURL: String(config.baseURL),
    searchURL: String(config.searchURL),
    searchList: String(config.searchList || ""),
    searchName: String(config.searchName || ""),
    searchResult: String(config.searchResult || ""),
    chapterRoads: String(config.chapterRoads || ""),
    chapterResult: String(config.chapterResult || ""),
    referer: String(config.referer || config.baseURL || "")
  };
}

function sourceUrlWithKeyword(source, keyword) {
  const encoded = encodeURIComponent(keyword);
  return String(source.searchURL || "")
    .replaceAll("@keyword", encoded)
    .replaceAll("{keyword}", encoded)
    .replaceAll("%40keyword", encoded);
}

function inferDirectTitle(url) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname);
    return name || parsed.hostname;
  } catch {
    return "网络点播";
  }
}

export class SourceManager {
  constructor(ui, room) {
    this.ui = ui;
    this.room = room;
    this.sources = this.loadSources();
    this.activeSourceId = localStorage.getItem(ACTIVE_SOURCE_KEY) || this.sources[0]?.id || "";
    this.currentResult = null;
    this.syncState();
  }

  syncState(patch = {}) {
    this.ui.setSourceState({
      sources: this.sources,
      activeSourceId: this.activeSourceId,
      ...patch
    });
  }

  loadSources() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SOURCE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  saveSources() {
    localStorage.setItem(SOURCE_KEY, JSON.stringify(this.sources));
  }

  activeSource() {
    return this.sources.find((source) => source.id === this.activeSourceId) || this.sources[0] || null;
  }

  importKazumi(rawValue) {
    const source = normalizeSourceConfig(decodeBase64Json(rawValue));
    this.sources = this.sources.filter((item) => item.name !== source.name || item.baseURL !== source.baseURL);
    this.sources.unshift(source);
    this.activeSourceId = source.id;
    localStorage.setItem(ACTIVE_SOURCE_KEY, source.id);
    this.saveSources();
    this.syncState({ status: `已导入片源：${source.name}` });
    return source;
  }

  deleteSource(sourceId) {
    const source = this.sources.find((item) => item.id === sourceId);
    if (!source) return;
    this.sources = this.sources.filter((item) => item.id !== sourceId);
    if (this.activeSourceId === sourceId) {
      this.activeSourceId = this.sources[0]?.id || "";
      if (this.activeSourceId) localStorage.setItem(ACTIVE_SOURCE_KEY, this.activeSourceId);
      else localStorage.removeItem(ACTIVE_SOURCE_KEY);
    }
    this.saveSources();
    this.syncState({
      searchResults: [],
      chapterGroups: [],
      activeChapterGroupId: "",
      chapters: [],
      status: `已删除片源：${source.name}`
    });
  }

  selectSource(sourceId) {
    if (!this.sources.some((source) => source.id === sourceId)) return;
    this.activeSourceId = sourceId;
    localStorage.setItem(ACTIVE_SOURCE_KEY, sourceId);
    this.syncState({
      searchResults: [],
      chapterGroups: [],
      activeChapterGroupId: "",
      chapters: [],
      status: `已选择片源：${this.activeSource()?.name || ""}`
    });
  }

  async fetchHtml(url, referer = "") {
    const response = await fetch("/api/source/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, referer })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new Error(result?.error || "片源请求失败");
    return result.html;
  }

  async search(keyword) {
    const source = this.activeSource();
    if (!source) throw new Error("请先导入片源");
    const cleanKeyword = String(keyword || "").trim();
    if (!cleanKeyword) return [];

    this.syncState({ busy: true, status: "正在搜索...", searchResults: [], chapterGroups: [], activeChapterGroupId: "", chapters: [] });
    try {
      if (!source.searchList || !source.searchResult) throw new Error("当前片源缺少搜索 XPath");
      const url = sourceUrlWithKeyword(source, cleanKeyword);
      const html = await this.fetchHtml(url, source.referer || source.baseURL);
      const doc = parseHtml(html);
      const items = evaluateNodes(doc, source.searchList);
      const candidates = items
        .map((node) => {
          const nameNode = evaluateNodes(doc, source.searchName, node)[0] || node;
          const resultNode = evaluateNodes(doc, source.searchResult, node)[0] || node;
          const href = nodeHref(resultNode, source.baseURL);
          const rawName = nodeName(nameNode) || nodeName(resultNode) || nodeName(node);
          return {
            name: cleanResultName(rawName, cleanKeyword) || "未命名",
            url: href
          };
        })
        .filter((item) => item.url && isRelevantResult(item, cleanKeyword));
      const results = uniqueResults(candidates)
        .sort((left, right) => scoreResult(right, cleanKeyword) - scoreResult(left, cleanKeyword))
        .slice(0, 50);
      this.syncState({
        busy: false,
        searchResults: results,
        status: results.length ? `找到 ${results.length} 个相关结果` : "没有搜索结果"
      });
      return results;
    } catch (error) {
      this.syncState({ busy: false, status: error.message || "搜索失败" });
      throw error;
    }
  }

  async loadChapters(result) {
    const source = this.activeSource();
    if (!source || !result?.url) return [];
    this.currentResult = result;
    this.syncState({ busy: true, status: `正在读取：${result.name}`, chapterGroups: [], activeChapterGroupId: "", chapters: [] });
    try {
      const html = await this.fetchHtml(result.url, source.referer || source.baseURL);
      const doc = parseHtml(html);
      const roads = evaluateNodes(doc, source.chapterRoads);
      const contexts = roads.length ? roads : [doc];
      const groups = [];
      for (const [groupIndex, context] of contexts.entries()) {
        const chapters = [];
        for (const node of evaluateNodes(doc, source.chapterResult, context)) {
          const url = nodeHref(node, result.url);
          if (!url) continue;
          chapters.push({
            name: nodeName(node) || `第 ${chapters.length + 1} 集`,
            url
          });
        }
        if (chapters.length > 0) {
          const fallbackName = `线路 ${groups.length + 1}`;
          const rawGroupName = directChildTitle(context, fallbackName).slice(0, 24) || fallbackName;
          const groupName = /^线路\s*\d+$/i.test(rawGroupName) ? fallbackName : rawGroupName;
          groups.push({
            id: `road-${groupIndex}`,
            name: groupName,
            chapters
          });
        }
      }
      const activeGroup = groups[0] || { id: "", chapters: [] };
      const chapters = activeGroup.chapters;
      this.syncState({
        busy: false,
        chapterGroups: groups,
        activeChapterGroupId: activeGroup.id,
        chapters,
        status: chapters.length ? `已读取 ${chapters.length} 集${groups.length > 1 ? `，${groups.length} 条线路` : ""}` : "没有读取到选集"
      });
      return chapters;
    } catch (error) {
      this.syncState({ busy: false, status: error.message || "读取选集失败" });
      throw error;
    }
  }

  selectChapterGroup(groupId) {
    const groups = this.ui.state?.source?.chapterGroups || [];
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;
    this.syncState({
      activeChapterGroupId: group.id,
      chapters: group.chapters,
      status: `已切换到${group.name}`
    });
  }

  async resolveChapter(chapter) {
    const source = this.activeSource();
    if (!chapter?.url) throw new Error("没有可播放的选集");
    this.syncState({ busy: true, status: `正在解析：${chapter.name}` });
    try {
      const response = await fetch("/api/source/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: chapter.url,
            referer: chapter.referer || source?.referer || this.currentResult?.url || source?.baseURL || chapter.url
        })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || "解析播放地址失败");
      this.syncState({ busy: false, status: `已解析：${chapter.name}` });
      const fallbackTitle = [this.currentResult?.name, chapter.name].filter(Boolean).join(" - ");
      return {
        ...result,
        title: result.title || fallbackTitle || chapter.name,
        sourceName: source?.name || (result.provider === "bilibili" ? "Bilibili" : "手动直链"),
        pageUrl: chapter.url,
        referer: result.referer || chapter.referer || source?.referer || this.currentResult?.url || source?.baseURL || chapter.url
      };
    } catch (error) {
      this.syncState({ busy: false, status: error.message || "解析播放地址失败" });
      throw error;
    }
  }

  async resolveDirectUrl(rawUrl) {
    const url = String(rawUrl || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("请输入 http/https 开头的播放地址或页面地址");
    this.syncState({ busy: true, status: "正在解析直链..." });
    try {
      const response = await fetch("/api/source/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, referer: url, inspectOnly: true })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || "解析播放地址失败");
      const resolved = {
        ...result,
        title: result.title || inferDirectTitle(url),
        sourceName: "手动直链",
        pageUrl: url,
        referer: result.referer || url
      };
      const chapters = Array.isArray(result.chapters) ? result.chapters : [];
      this.currentResult = { name: resolved.title, url };
      this.syncState({
        busy: false,
        chapters,
        chapterGroups: chapters.length ? [{ id: "bilibili-pages", name: "分P", chapters }] : [],
        activeChapterGroupId: chapters.length ? "bilibili-pages" : "",
        status: chapters.length > 1
          ? `已解析，共 ${chapters.length} 个分P，请选择播放`
          : chapters.length === 1
            ? "已解析，请选择 P1 播放"
            : "直链已解析"
      });
      return resolved;
    } catch (error) {
      this.syncState({ busy: false, status: error.message || "解析播放地址失败" });
      throw error;
    }
  }
}
