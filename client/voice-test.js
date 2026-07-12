const logEl = document.getElementById("log");
const runButton = document.getElementById("run");
const localButton = document.getElementById("local");

let audioContext = null;
let nextPlayTime = 0;

function log(line) {
  logEl.textContent += `${line}\n`;
}

function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!audioContext && AudioContextClass) audioContext = new AudioContextClass();
  return audioContext;
}

async function unlockAudio() {
  const context = ensureAudioContext();
  if (!context) throw new Error("AudioContext is not supported");
  await context.resume?.();
  return context;
}

function makeTonePacket({ sampleRate = 24000, frequency = 660, seconds = 0.16, seq = 0 } = {}) {
  const length = Math.floor(sampleRate * seconds);
  const pcm = new Int16Array(length);

  for (let index = 0; index < length; index += 1) {
    const envelope = Math.min(1, index / 120, (length - index) / 120);
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.42 * Math.max(0, envelope);
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return {
    meta: {
      sampleRate,
      channels: 1,
      seq,
      sentAt: Date.now()
    },
    buffer: pcm.buffer
  };
}

function playPcmPacket(meta = {}, bytes) {
  const context = ensureAudioContext();
  if (!context || context.state !== "running") return false;

  const pcm = new Int16Array(bytes);
  if (pcm.length === 0) return false;

  const sampleRate = Number(meta.sampleRate || 24000);
  const audioBuffer = context.createBuffer(1, pcm.length, sampleRate);
  const channel = audioBuffer.getChannelData(0);
  for (let index = 0; index < pcm.length; index += 1) {
    channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
  }

  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = audioBuffer;
  source.connect(gain);
  gain.connect(context.destination);

  const startAt = Math.max(context.currentTime + 0.04, nextPlayTime || 0);
  const fade = Math.min(0.002, audioBuffer.duration / 20);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.72, startAt + fade);
  gain.gain.setValueAtTime(0.72, Math.max(startAt + fade, startAt + audioBuffer.duration - fade));
  gain.gain.linearRampToValueAtTime(0, startAt + audioBuffer.duration);
  source.start(startAt);
  nextPlayTime = startAt + audioBuffer.duration;
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
  return true;
}

function socketClient(name, clientId) {
  const socket = window.io({
    transports: ["websocket"],
    upgrade: false,
    reconnection: false,
    timeout: 5000
  });

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${name} connect timeout`)), 5000);
    socket.on("connect", () => {
      socket.emit("join", { name, clientId });
    });
    socket.on("joined", (payload) => {
      window.clearTimeout(timer);
      resolve({ socket, id: payload.id });
    });
    socket.on("connect_error", reject);
  });
}

async function resolveBytes(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer;
  if (ArrayBuffer.isView(buffer)) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  if (buffer instanceof Blob) return buffer.arrayBuffer();
  if (buffer?.data && Array.isArray(buffer.data)) return new Uint8Array(buffer.data).buffer;
  return null;
}

function rmsOf(bytes) {
  const pcm = bytes ? new Int16Array(bytes) : new Int16Array();
  let sum = 0;
  for (const value of pcm) {
    const sample = value / 32768;
    sum += sample * sample;
  }
  return {
    samples: pcm.length,
    rms: pcm.length ? Math.sqrt(sum / pcm.length) : 0
  };
}

async function runVoiceTest() {
  logEl.textContent = "";
  runButton.disabled = true;
  await unlockAudio();
  nextPlayTime = 0;

  const receiver = await socketClient("VoiceTest-B", `voice-test-b-${Date.now()}`);
  log(`B joined: ${receiver.id}`);
  const sender = await socketClient("VoiceTest-A", `voice-test-a-${Date.now()}`);
  log(`A joined: ${sender.id}`);

  const received = [];
  receiver.socket.on("voice-packet", async (meta, buffer) => {
    if (meta?.from && meta.from !== sender.id) return;

    const bytes = await resolveBytes(buffer);
    const { samples, rms } = rmsOf(bytes);
    const played = bytes ? playPcmPacket(meta, bytes) : false;

    received.push({ meta, bytes: bytes?.byteLength || 0, samples, rms, played });
    log(`B received seq=${meta.seq} bytes=${bytes?.byteLength || 0} samples=${samples} rms=${rms.toFixed(4)} played=${played}`);
  });

  await new Promise((resolve) => window.setTimeout(resolve, 300));
  for (let seq = 0; seq < 8; seq += 1) {
    const packet = makeTonePacket({ seq });
    sender.socket.emit("voice-packet", packet.meta, packet.buffer);
    log(`A sent seq=${seq} bytes=${packet.buffer.byteLength}`);
    await new Promise((resolve) => window.setTimeout(resolve, 130));
  }

  await new Promise((resolve) => window.setTimeout(resolve, 1200));
  sender.socket.disconnect();
  receiver.socket.disconnect();

  const ok = received.length > 0 && received.some((item) => item.bytes > 0 && item.rms > 0.05 && item.played);
  log("");
  log(ok ? "RESULT: PASS - relay received and played." : "RESULT: FAIL - relay did not produce playable audio.");
  runButton.disabled = false;
}

localButton.addEventListener("click", async () => {
  logEl.textContent = "";
  try {
    await unlockAudio();
    nextPlayTime = 0;
    const packet = makeTonePacket({ frequency: 880, seconds: 0.35, seq: 0 });
    const played = playPcmPacket(packet.meta, packet.buffer);
    log(`LOCAL BEEP: ${played ? "played" : "blocked"} state=${audioContext?.state || "none"}`);
  } catch (error) {
    log(`LOCAL BEEP ERROR: ${error.message}`);
  }
});

runButton.addEventListener("click", () => {
  runVoiceTest().catch((error) => {
    log(`ERROR: ${error.message}`);
    runButton.disabled = false;
  });
});
