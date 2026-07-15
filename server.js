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

// ---- YouTube-Cookies ----
// Railway hat kein dauerhaftes Dateisystem, daher kommt der Cookie-Inhalt als
// Umgebungsvariable YT_COOKIES_CONTENT (Netscape-Format) und wird beim Start
// in eine Datei geschrieben, die yt-dlp per --cookies nutzt.
const COOKIE_PATH = "/tmp/yt-cookies.txt";
let COOKIES_READY = false;
if (process.env.YT_COOKIES_CONTENT && process.env.YT_COOKIES_CONTENT.trim()) {
  try {
    fs.writeFileSync(COOKIE_PATH, process.env.YT_COOKIES_CONTENT);
    COOKIES_READY = true;
    console.log("YouTube-Cookies geladen:", COOKIE_PATH);
  } catch (e) {
    console.error("Konnte Cookie-Datei nicht schreiben:", e.message);
  }
} else {
  console.log("Keine YT_COOKIES_CONTENT gesetzt — laufe ohne Cookies.");
}

// ---- Proxy (Webshare o.ä.) ----
// Vollständige Proxy-URL, z.B. http://user:pass@host:port
// Wird an yt-dlp per --proxy übergeben, damit YouTube eine Wohn-IP statt der
// Railway-Rechenzentrums-IP sieht.
const YT_PROXY = (process.env.YT_PROXY || "").trim();
if (YT_PROXY) {
  console.log("Proxy aktiv.");
} else {
  console.log("Kein YT_PROXY gesetzt — laufe ohne Proxy.");
}

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

function runCmd(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.stdout.on("data", (d) => process.stdout.write(d)); // Fortschritt in die Logs
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exit ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

function runYtDlp(args) {
  return runCmd("yt-dlp", args);
}

app.get("/", (_req, res) => res.send("clip-service läuft"));

app.post("/clip", async (req, res) => {
  // ---- Auth ----
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { videoUrl, startTime, endTime, title, format } = req.body || {};
  if (!videoUrl || startTime == null || endTime == null) {
    return res
      .status(400)
      .json({ error: "videoUrl, startTime und endTime sind Pflicht" });
  }
  // Zielformat: "crop" (Center-Crop, Standard) oder "blur" (unscharfer Hintergrund).
  const fmt = (format || "crop").toLowerCase();

  const start = toSeconds(startTime);
  const end = toSeconds(endTime);
  if (start == null || end == null || end <= start) {
    return res.status(400).json({ error: "ungültige Zeitstempel" });
  }

  const id = randomUUID();
  const outPath = path.join("/tmp", `${id}.mp4`);
  const key = `clips/${id}.mp4`;

  try {
    // Lädt NUR das gewünschte Segment (spart Proxy-Volumen und Zeit),
    // danach 9:16-Konvertierung auf dem bereits kurzen Ausschnitt.
    console.log(`[v5-section] Lade nur Segment ${start}-${end}s in 720p`);
    const fullPath = path.join("/tmp", `${id}-full.mp4`);

    // SCHRITT 1: NUR das Segment laden.
    // --download-sections + ffmpeg-Downloader => yt-dlp holt per HTTP-Range nur
    // den benoetigten Bereich. Ohne --force-keyframes-at-cuts, damit nicht neu
    // kodiert wird (das war der OOM-Killer).
    const dlArgs = [
      "--download-sections", `*${start}-${end}`,
      "--downloader", "ffmpeg",
      "--downloader-args", "ffmpeg:-threads 1",
      "-f",
      "bv*[height<=720][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[ext=mp4]/b",
      "--merge-output-format",
      "mp4",
      // Mit Cookies funktioniert der web-Client zuverlässig; ios als Fallback.
      "--extractor-args",
      "youtube:player_client=default,web_safari,ios",
      "-o",
      fullPath,
      videoUrl,
    ];
    if (COOKIES_READY && fs.existsSync(COOKIE_PATH)) {
      dlArgs.unshift("--cookies", COOKIE_PATH);
    }
    if (YT_PROXY) {
      dlArgs.unshift("--proxy", YT_PROXY);
    }
    await runYtDlp(dlArgs);

    if (!fs.existsSync(fullPath)) {
      throw new Error("Download fehlgeschlagen — Datei nicht gefunden");
    }

    // SCHRITT 2: Segment schneiden UND auf 9:16 (1080x1920) bringen.
    // Zwei Modi:
    //  - crop: mittleren Ausschnitt formatfüllend zuschneiden (Standard)
    //  - blur: ganzes Bild sichtbar, oben/unten unscharfer Hintergrund
    // Hinweis: 9:16 erfordert Re-Encode (kein -c copy). Ein Thread + veryfast
    // hält den Speicherbedarf auf dem kleinen Container niedrig.
    const cropFilter =
      "crop=ih*9/16:ih,scale=1080:1920:force_original_aspect_ratio=increase," +
      "crop=1080:1920,setsar=1";
    const blurFilter =
      "split[a][b];" +
      "[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bg];" +
      "[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];" +
      "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1";
    const vf = fmt === "blur" ? blurFilter : cropFilter;
    console.log(`[v4-9x16] Format: ${fmt}`);

    await runCmd("ffmpeg", [
      "-y",
      "-i", fullPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-avoid_negative_ts", "make_zero",
      "-threads", "1",
      outPath,
    ]);

    try { fs.unlinkSync(fullPath); } catch (_) {}

    if (!fs.existsSync(outPath)) {
      throw new Error("Schnitt fehlgeschlagen — Ausgabedatei nicht gefunden");
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
