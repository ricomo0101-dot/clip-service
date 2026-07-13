// clip-service — schneidet ein Segment aus einem YouTube-Video und lädt es zu Cloudflare R2 hoch.
// Rückgabe: eine öffentliche R2-URL, die du direkt an Submagic (videoUrl) weitergibst.

const express = require("express");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const app = express();
app.use(express.json());

// ---- Konfiguration (kommt aus Umgebungsvariablen / Railway Variables) ----
const API_KEY = process.env.API_KEY;                 // frei wählbares Passwort, das n8n mitschickt
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE;   // z.B. https://clips.deinedomain.de  (öffentliche R2-URL)
const PORT = process.env.PORT || 8080;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// "1:30" oder "01:30" oder "1:02:05" -> Sekunden
function toSeconds(ts) {
  const parts = String(ts).split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.stdout.on("data", (d) => process.stdout.write(d)); // Fortschritt in die Logs
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

app.get("/", (_req, res) => res.send("clip-service läuft"));

app.post("/clip", async (req, res) => {
  // ---- Auth ----
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { videoUrl, startTime, endTime, title } = req.body || {};
  if (!videoUrl || startTime == null || endTime == null) {
    return res
      .status(400)
      .json({ error: "videoUrl, startTime und endTime sind Pflicht" });
  }

  const start = toSeconds(startTime);
  const end = toSeconds(endTime);
  if (start == null || end == null || end <= start) {
    return res.status(400).json({ error: "ungültige Zeitstempel" });
  }

  const id = randomUUID();
  const outPath = path.join("/tmp", `${id}.mp4`);
  const key = `clips/${id}.mp4`;

  try {
    // --download-sections lädt NUR das gewünschte Segment (schnell, wenig Traffic).
    // Wichtig fuer wenig RAM: max. 720p laden UND ffmpeg per copy schneiden (kein Re-Encode),
    // sonst wird ffmpeg auf kleinen Containern per OOM (exit -9) gekillt.
    const args = [
      "--download-sections",
      `*${start}-${end}`,
      // KEIN --force-keyframes-at-cuts => kein Neu-Kodieren => sehr wenig RAM
      "-f",
      "bv*[height<=720][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[ext=mp4]/b",
      "--merge-output-format",
      "mp4",
      // Downloader-seitig ohne Re-Encode zuschneiden
      "--downloader",
      "ffmpeg",
      "--downloader-args",
      "ffmpeg_i:-avoid_negative_ts make_zero",
      "--postprocessor-args",
      "ffmpeg:-c copy",
      // 2026er Anti-Bot-Absicherung: iOS-Client + Deno-JS-Runtime sind im Image vorhanden
      "--extractor-args",
      "youtube:player_client=default,ios",
      "-o",
      outPath,
      videoUrl,
    ];

    // Optional: falls du ein Cookie-File hinterlegst (gegen "confirm you're not a bot")
    if (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) {
      args.unshift("--cookies", process.env.YT_COOKIES_FILE);
    }

    await runYtDlp(args);

    if (!fs.existsSync(outPath)) {
      throw new Error("Ausgabedatei nicht gefunden — Download fehlgeschlagen");
    }

    const body = fs.readFileSync(outPath);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: "video/mp4",
      })
    );

    fs.unlinkSync(outPath);

    const publicUrl = `${R2_PUBLIC_BASE.replace(/\/$/, "")}/${key}`;
    return res.json({
      ok: true,
      videoUrl: publicUrl,
      key,
      durationSeconds: end - start,
      title: title || null,
    });
  } catch (err) {
    console.error(err);
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (_) {}
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => console.log(`clip-service auf Port ${PORT}`));
