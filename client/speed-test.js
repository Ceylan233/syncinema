(function () {
  const startButton = document.getElementById("startButton");
  const statusText = document.getElementById("status");
  const barFill = document.getElementById("barFill");
  const latencyText = document.getElementById("latency");
  const jitterText = document.getElementById("jitter");
  const downloadText = document.getElementById("download");
  const parallelDownloadText = document.getElementById("parallelDownload");
  const uploadText = document.getElementById("upload");
  const verdictText = document.getElementById("verdictText");
  const hostText = document.getElementById("hostText");

  hostText.textContent = location.host;

  function setStatus(text, progress) {
    statusText.textContent = text;
    barFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }

  function formatMbps(bytes, ms) {
    if (!bytes || !ms) return 0;
    return (bytes * 8) / (ms / 1000) / 1000 / 1000;
  }

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function measureLatency() {
    const samples = [];
    for (let index = 0; index < 8; index += 1) {
      const started = performance.now();
      const response = await fetchWithTimeout(
        `/api/speed/ping?t=${Date.now()}-${index}`,
        { cache: "no-store" },
        4000
      );
      await response.json();
      samples.push(performance.now() - started);
      setStatus(`正在测延迟 ${index + 1}/8`, 8 + index * 5);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const stableSamples = sorted.length > 4 ? sorted.slice(1, -1) : sorted;
    const avg = average(stableSamples);
    const jitter = average(stableSamples.map((sample) => Math.abs(sample - avg)));
    return { avg, jitter };
  }

  async function measureDownload() {
    const sampleMs = 8000;
    const controller = new AbortController();
    const started = performance.now();
    let bytes = 0;
    const timer = setTimeout(() => controller.abort(), sampleMs);
    let reader = null;
    try {
      const response = await fetch(`/api/speed/download?mb=16&t=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error("download unavailable");
      reader = response.body.getReader();
      while (performance.now() - started < sampleMs) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        const elapsed = performance.now() - started;
        setStatus(
          `正在测下载 ${(bytes / 1024 / 1024).toFixed(1)} MB`,
          52 + Math.min(25, (elapsed / sampleMs) * 25)
        );
      }
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) {
        try { await reader.cancel(); } catch (_error) { /* stream already closed */ }
      }
    }
    if (!bytes) throw new Error("download returned no data");
    return formatMbps(bytes, Math.min(performance.now() - started, sampleMs));
  }

  async function measureParallelDownload(connections = 4) {
    const sampleMs = 8000;
    const controller = new AbortController();
    const started = performance.now();
    let bytes = 0;
    const timer = setTimeout(() => controller.abort(), sampleMs);
    try {
      const workers = Array.from({ length: connections }, async (_, index) => {
        let reader = null;
        try {
          const response = await fetch(
            `/api/speed/download?mb=64&t=${Date.now()}-${connections}-${index}`,
            { cache: "no-store", signal: controller.signal }
          );
          if (!response.ok || !response.body) throw new Error("download unavailable");
          reader = response.body.getReader();
          while (performance.now() - started < sampleMs) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
          }
        } catch (error) {
          if (error.name !== "AbortError") throw error;
        } finally {
          if (reader) {
            try { await reader.cancel(); } catch (_error) { /* stream already closed */ }
          }
        }
      });
      const results = await Promise.allSettled(workers);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (!bytes) throw new Error("download returned no data");
    return formatMbps(bytes, Math.min(performance.now() - started, sampleMs));
  }

  async function measureUpload() {
    async function sendSample(bytes, timeoutMs) {
      const chunk = new Uint8Array(bytes);
      for (let index = 0; index < bytes; index += 1) {
        chunk[index] = (index * 13 + 29) & 255;
      }
      const started = performance.now();
      const response = await fetchWithTimeout(
        `/api/speed/upload?t=${Date.now()}-${bytes}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunk
        },
        timeoutMs
      );
      if (!response.ok) throw new Error("upload unavailable");
      const elapsed = performance.now() - started;
      return { elapsed, mbps: formatMbps(bytes, elapsed) };
    }

    const probeBytes = 16 * 1024;
    const probe = await sendSample(probeBytes, 8000);
    if (probe.elapsed >= 2000) return probe.mbps;

    const targetBytes = Math.round(Math.max(
      64 * 1024,
      Math.min(1024 * 1024, probeBytes * (5000 / Math.max(1, probe.elapsed)))
    ));
    const sample = await sendSample(targetBytes, 12000);
    return sample.mbps;
  }

  function verdict(result) {
    const parts = [];
    if (result.latency <= 80 && result.jitter <= 15) {
      parts.push("语音和同步很稳");
    } else if (result.latency <= 130 && result.jitter <= 30) {
      parts.push("语音和同步可用");
    } else {
      parts.push("语音或同步可能会有延迟");
    }

    if (result.download >= 30) {
      parts.push("视频缓冲很舒服");
    } else if (result.download >= 10) {
      parts.push("适合普通 720p/低码率 1080p");
    } else {
      parts.push("视频建议开省流或低码率");
    }

    if (result.upload < 5) {
      parts.push("手机上传片源会偏慢");
    }
    return `${parts.join("，")}。`;
  }

  async function run() {
    startButton.disabled = true;
    startButton.textContent = "测速中";
    latencyText.textContent = "-- ms";
    jitterText.textContent = "-- ms";
    downloadText.textContent = "-- Mbps";
    parallelDownloadText.textContent = "-- Mbps";
    uploadText.textContent = "-- Mbps";
    verdictText.textContent = "测速进行中，请保持页面在前台。";

    try {
      setStatus("准备测速", 4);
      const latency = await measureLatency();
      latencyText.textContent = `${Math.round(latency.avg)} ms`;
      jitterText.textContent = `${Math.round(latency.jitter)} ms`;

      setStatus("正在测下载", 56);
      const down = await measureDownload();
      downloadText.textContent = `${down.toFixed(1)} Mbps`;
      setStatus("\u6b63\u5728\u6d4b\u8bd5\u56db\u8fde\u63a5\u4e0b\u8f7d", 70);
      const parallelDown = await measureParallelDownload(4);
      parallelDownloadText.textContent = `${parallelDown.toFixed(1)} Mbps`;

      setStatus("正在测上传", 82);
      const up = await measureUpload();
      uploadText.textContent = `${up.toFixed(1)} Mbps`;

      const result = {
        latency: latency.avg,
        jitter: latency.jitter,
        download: down,
        parallelDownload: parallelDown,
        upload: up
      };
      verdictText.textContent = verdict(result);
      setStatus("测速完成", 100);
    } catch (error) {
      console.error(error);
      setStatus("测速失败，请刷新后重试", 100);
      verdictText.textContent = "测速请求失败，可能是服务器未部署新接口，或当前网络阻断了连接。";
    } finally {
      startButton.disabled = false;
      startButton.textContent = "重新测速";
    }
  }

  startButton.addEventListener("click", run);
}());
