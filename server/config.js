const defaultIceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

function parseIceServers() {
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (error) {
      console.warn("ICE_SERVERS_JSON parse failed, falling back to STUN", error.message);
    }
  }

  const turnUrls = String(process.env.TURN_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (turnUrls.length === 0) return defaultIceServers;

  return [
    ...defaultIceServers,
    {
      urls: turnUrls,
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || ""
    }
  ];
}

module.exports = {
  port: Number(process.env.PORT || 3100),
  clientDir: process.env.CLIENT_DIR,
  corsOrigin: process.env.CORS_ORIGIN || "*",
  maxHttpBufferSize: 8 * 1024 * 1024,
  https: {
    pfxPath: process.env.HTTPS_PFX_PATH || "",
    pfxPassphrase: process.env.HTTPS_PFX_PASSPHRASE || "",
    keyPath: process.env.HTTPS_KEY_PATH || "",
    certPath: process.env.HTTPS_CERT_PATH || ""
  },
  iceServers: parseIceServers()
};
