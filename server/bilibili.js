const BILIBILI_REFERER = "https://www.bilibili.com/";
const BILIBILI_LIVE_REFERER = "https://live.bilibili.com/";

function bilibiliHeaders(referer = BILIBILI_REFERER) {
  return {
    Accept: "application/json, text/plain, */*",
    Referer: referer,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  };
}

function isBilibiliUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const host = url.hostname.toLowerCase();
    return host === "b23.tv" || host === "bilibili.com" || host.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}

function parseBilibiliTarget(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  const path = decodeURIComponent(url.pathname);
  const liveMatch = url.hostname.toLowerCase().startsWith("live.") && path.match(/\/(?:blanc\/)?(\d+)/i);
  if (liveMatch) return { type: "live", roomId: liveMatch[1] };

  const episodeMatch = path.match(/\/bangumi\/play\/ep(\d+)/i);
  if (episodeMatch) return { type: "episode", episodeId: episodeMatch[1] };

  const bvidMatch = path.match(/\/(BV[0-9A-Za-z]{10})(?:\/|$)/i);
  const aidMatch = path.match(/\/av(\d+)(?:\/|$)/i);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("p") || "1", 10) || 1);
  if (bvidMatch) return { type: "video", bvid: bvidMatch[1], page };
  if (aidMatch) return { type: "video", aid: aidMatch[1], page };
  return null;
}

async function fetchJson(url, referer, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: bilibiliHeaders(referer),
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`bilibili-http-${response.status}`);
  const payload = await response.json();
  if (Number(payload?.code || 0) !== 0) {
    throw new Error(payload?.message || payload?.msg || `bilibili-api-${payload?.code}`);
  }
  return payload.data ?? payload.result;
}

async function expandBilibiliUrl(rawUrl, fetchImpl = fetch) {
  const url = new URL(String(rawUrl || ""));
  if (url.hostname.toLowerCase() !== "b23.tv") return url.toString();
  const response = await fetchImpl(url, {
    headers: bilibiliHeaders(),
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`bilibili-short-url-${response.status}`);
  return response.url;
}

function selectDurl(playData) {
  const item = Array.isArray(playData?.durl) ? playData.durl.find((entry) => entry?.url) : null;
  if (!item) throw new Error("bilibili-play-url-unavailable");
  return item.url;
}

function collectDurlCandidates(playData) {
  const item = Array.isArray(playData?.durl) ? playData.durl.find((entry) => entry?.url) : null;
  if (!item) return [];
  return Array.from(new Set([item.url, ...(Array.isArray(item.backup_url) ? item.backup_url : [])].filter(Boolean)));
}

const QUALITY_LABELS = new Map([
  [127, "8K"],
  [126, "杜比视界"],
  [125, "HDR"],
  [120, "4K"],
  [116, "1080P60"],
  [112, "1080P+"],
  [80, "1080P"],
  [74, "720P60"],
  [64, "720P"],
  [32, "480P"],
  [16, "360P"]
]);

function qualityLabel(quality, fallback = "") {
  return QUALITY_LABELS.get(Number(quality)) || fallback || `清晰度 ${quality}`;
}

function collectVideoQualities(playData) {
  const values = Array.isArray(playData?.accept_quality) ? playData.accept_quality : [];
  const descriptions = Array.isArray(playData?.accept_description) ? playData.accept_description : [];
  const qualities = values.map((value, index) => ({
    value: String(value),
    quality: Number(value),
    label: qualityLabel(value, descriptions[index])
  }));
  const actual = Number(playData?.quality || 0);
  if (actual && !qualities.some((item) => item.quality === actual)) {
    qualities.push({ value: String(actual), quality: actual, label: qualityLabel(actual) });
  }
  return qualities.sort((left, right) => right.quality - left.quality);
}

async function resolveBilibiliStream({ bvid, cid, episodeId, quality = 80, referer = "" }, fetchImpl = fetch) {
  const qn = Math.max(16, Math.min(127, Number(quality) || 80));
  let playData;
  if (episodeId) {
    const sourceReferer = referer || `https://www.bilibili.com/bangumi/play/ep${episodeId}`;
    playData = await fetchJson(
      `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${encodeURIComponent(episodeId)}&qn=${qn}&fnval=0&fnver=0&fourk=1`,
      sourceReferer,
      fetchImpl
    );
  } else {
    const params = new URLSearchParams({
      bvid: String(bvid || ""),
      cid: String(cid || ""),
      qn: String(qn),
      fnval: "0",
      fnver: "0",
      fourk: "1"
    });
    const sourceReferer = referer || `https://www.bilibili.com/video/${bvid}`;
    playData = await fetchJson(
      `https://api.bilibili.com/x/player/playurl?${params.toString()}`,
      sourceReferer,
      fetchImpl
    );
  }
  return {
    mediaUrl: selectDurl(playData),
    mediaUrls: collectDurlCandidates(playData),
    quality: Number(playData?.quality || qn),
    qualities: collectVideoQualities(playData)
  };
}

async function resolveVideo(target, sourceUrl, fetchImpl = fetch, options = {}) {
  const viewParams = target.bvid ? `bvid=${encodeURIComponent(target.bvid)}` : `aid=${encodeURIComponent(target.aid)}`;
  const view = await fetchJson(
    `https://api.bilibili.com/x/web-interface/view?${viewParams}`,
    sourceUrl,
    fetchImpl
  );
  const pages = Array.isArray(view?.pages) ? view.pages : [];
  const page = pages[Math.min(pages.length - 1, Math.max(0, target.page - 1))] || pages[0];
  if (!page?.cid) throw new Error("bilibili-video-page-unavailable");

  const part = String(page.part || "").trim();
  const titleAlreadyContainsPart = part && String(view.title || "").includes(part);
  const title = part && part !== view.title && !titleAlreadyContainsPart ? `${view.title} - ${part}` : view.title;
  const bvid = view.bvid || target.bvid;
  const chapters = pages.map((item, index) => {
    const pageNumber = Number(item?.page || index + 1);
    const pageTitle = String(item?.part || `P${pageNumber}`).trim();
    return {
      name: pages.length > 1 ? `P${pageNumber} ${pageTitle}` : pageTitle,
      url: `https://www.bilibili.com/video/${bvid}?p=${pageNumber}`,
      page: pageNumber,
      duration: Number(item?.duration || 0)
    };
  });

  if (options.inspectOnly) {
    return {
      provider: "bilibili",
      live: false,
      title,
      kind: "video",
      referer: sourceUrl,
      bvid,
      cid: String(page.cid),
      duration: Number(page.duration || view.duration || 0),
      selectedPage: Number(page.page || target.page || 1),
      chapters,
      inspectOnly: true
    };
  }

  const playParams = new URLSearchParams({
    cid: String(page.cid),
    qn: "80",
    fnval: "0",
    fnver: "0",
    fourk: "1"
  });
  if (view.bvid || target.bvid) playParams.set("bvid", view.bvid || target.bvid);
  else playParams.set("avid", String(view.aid || target.aid));
  const playData = await fetchJson(`https://api.bilibili.com/x/player/playurl?${playParams.toString()}`, sourceUrl, fetchImpl);
  return {
    provider: "bilibili",
    live: false,
    title,
    mediaUrl: selectDurl(playData),
    mediaUrls: collectDurlCandidates(playData),
    kind: "video",
    referer: sourceUrl,
    quality: Number(playData?.quality || 0),
    qualities: collectVideoQualities(playData),
    bvid,
    cid: String(page.cid),
    duration: Number(page.duration || view.duration || 0),
    selectedPage: Number(page.page || target.page || 1),
    chapters
  };
}

async function resolveEpisode(target, sourceUrl, fetchImpl = fetch) {
  const season = await fetchJson(
    `https://api.bilibili.com/pgc/view/web/season?ep_id=${encodeURIComponent(target.episodeId)}`,
    sourceUrl,
    fetchImpl
  );
  const episode = (season?.episodes || []).find((item) => String(item?.id) === String(target.episodeId));
  const playData = await fetchJson(
    `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${encodeURIComponent(target.episodeId)}&qn=80&fnval=0&fnver=0&fourk=1`,
    sourceUrl,
    fetchImpl
  );
  const episodeTitle = [episode?.title, episode?.long_title].filter(Boolean).join(" ").trim();
  return {
    provider: "bilibili",
    live: false,
    title: episodeTitle ? `${season?.title || "Bilibili"} - ${episodeTitle}` : season?.title || "Bilibili",
    mediaUrl: selectDurl(playData),
    mediaUrls: collectDurlCandidates(playData),
    kind: "video",
    referer: sourceUrl,
    quality: Number(playData?.quality || 0),
    qualities: collectVideoQualities(playData),
    episodeId: String(target.episodeId),
    duration: Number(episode?.duration || 0) / 1000
  };
}

function collectLiveStreams(playurl) {
  const result = [];
  for (const stream of playurl?.stream || []) {
    for (const format of stream?.format || []) {
      for (const codec of format?.codec || []) {
        if (codec?.codec_name !== "avc") continue;
        for (const info of codec?.url_info || []) {
          if (!info?.host || !codec?.base_url) continue;
          result.push({
            url: `${info.host}${codec.base_url}${info.extra || ""}`,
            protocol: stream.protocol_name,
            format: format.format_name,
            quality: Number(codec.current_qn || 0),
            acceptQualities: Array.isArray(codec.accept_qn) ? codec.accept_qn.map(Number) : []
          });
        }
      }
    }
  }
  return result;
}

async function resolveLive(target, sourceUrl, fetchImpl = fetch, desiredQuality = 10000) {
  const playInfo = await fetchJson(
    `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${encodeURIComponent(target.roomId)}` +
      `&protocol=0,1&format=0,1,2&codec=0,1&qn=${encodeURIComponent(desiredQuality)}&platform=web&ptype=8`,
    sourceUrl,
    fetchImpl
  );
  if (Number(playInfo?.live_status) !== 1) throw new Error("bilibili-live-offline");
  const roomId = String(playInfo.room_id || target.roomId);
  const roomInfo = await fetchJson(
    `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`,
    sourceUrl,
    fetchImpl
  ).catch(() => null);
  const streams = collectLiveStreams(playInfo?.playurl_info?.playurl);
  const selected = streams.find((item) => item.protocol === "http_stream" && item.format === "flv") ||
    streams.find((item) => item.protocol === "http_hls" && item.format === "ts") ||
    streams.find((item) => item.protocol === "http_hls" && item.format === "fmp4") ||
    streams.find((item) => item.protocol === "http_hls") ||
    streams[0];
  if (!selected) throw new Error("bilibili-live-stream-unavailable");
  const liveLines = streams
    .filter((item) =>
      item.protocol === selected.protocol &&
      item.format === selected.format &&
      item.quality === selected.quality
    )
    .filter((item, index, values) => {
      try {
        const host = new URL(item.url).hostname;
        return values.findIndex((candidate) => new URL(candidate.url).hostname === host) === index;
      } catch {
        return false;
      }
    })
    .slice(0, 8)
    .map((item, index) => ({
      id: String(index),
      host: new URL(item.url).hostname,
      url: item.url,
      quality: item.quality
    }));
  return {
    provider: "bilibili",
    live: true,
    roomId,
    title: roomInfo?.title || `Bilibili Live ${roomId}`,
    mediaUrl: selected.url,
    kind: selected.format === "flv" ? "flv" : selected.protocol === "http_hls" ? "hls" : "video",
    referer: `https://live.bilibili.com/${roomId}`,
    quality: selected.quality,
    liveLines,
    qualities: Array.from(new Set(selected.acceptQualities || [selected.quality]))
      .map((quality) => ({ value: String(quality), quality, label: qualityLabel(quality) }))
      .sort((left, right) => right.quality - left.quality)
  };
}

async function resolveBilibiliUrl(rawUrl, fetchImpl = fetch, options = {}) {
  const sourceUrl = await expandBilibiliUrl(rawUrl, fetchImpl);
  const target = parseBilibiliTarget(sourceUrl);
  if (!target) throw new Error("unsupported-bilibili-url");
  if (target.type === "live") return resolveLive(target, sourceUrl, fetchImpl, options.quality || 10000);
  if (target.type === "episode") return resolveEpisode(target, sourceUrl, fetchImpl);
  return resolveVideo(target, sourceUrl, fetchImpl, { inspectOnly: Boolean(options.inspectVideo) });
}

module.exports = {
  BILIBILI_LIVE_REFERER,
  BILIBILI_REFERER,
  collectLiveStreams,
  isBilibiliUrl,
  parseBilibiliTarget,
  qualityLabel,
  resolveBilibiliStream,
  resolveBilibiliUrl
};
