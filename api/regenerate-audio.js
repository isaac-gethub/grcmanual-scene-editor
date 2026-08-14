// Vercel Serverless Function — POST /api/regenerate-audio
// Regenerates ONE scene's narration audio from its current text and
// overwrites the existing MP3 in Supabase Storage. Requires the caller
// to be signed in as a registered staff user (checked via is_staff()).
//
// Required Vercel environment variables (set in Project Settings -> Environment
// Variables, never in client-side code):
//   ELEVENLABS_API_KEY        - your ElevenLabs API key
//   ELEVENLABS_VOICE_ID       - optional, defaults to the voice below
//   ELEVENLABS_MODEL          - optional, defaults to eleven_multilingual_v2
//   SUPABASE_SERVICE_ROLE_KEY - Supabase dashboard -> Project Settings -> API -> service_role
//
// The ELEVENLABS_API_KEY and SUPABASE_SERVICE_ROLE_KEY never reach the browser —
// they only ever exist inside this function, on Vercel's servers.

const SUPABASE_URL = "https://blfgwysgekfqhcafofhe.supabase.co";
const NARRATION_BUCKET = "grcmanual-video-narration";
const DEFAULT_VOICE_ID = "enzbGixeo55iqn1QxbbC"; // John
const DEFAULT_MODEL = "eleven_multilingual_v2";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const MODEL = process.env.ELEVENLABS_MODEL || DEFAULT_MODEL;

  if (!SERVICE_KEY || !ELEVEN_KEY) {
    res.status(500).json({
      error:
        "Server not configured: missing SUPABASE_SERVICE_ROLE_KEY or ELEVENLABS_API_KEY environment variable in Vercel project settings.",
    });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
  }
  const sceneId = body && body.sceneId;
  if (!sceneId) {
    res.status(400).json({ error: "sceneId is required" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    res.status(401).json({ error: "Missing Authorization bearer token" });
    return;
  }

  try {
    // 1. Identify the caller from their Supabase session token
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    const user = await userRes.json();

    // 2. Confirm they're registered staff
    const staffRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_staff`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ check_email: user.email }),
    });
    const isStaff = await staffRes.json();
    if (!isStaff) {
      res.status(403).json({ error: "Staff access required" });
      return;
    }

    // 3. Fetch the scene's current narration text
    const sceneRes = await fetch(
      `${SUPABASE_URL}/rest/v1/grcmanual_video_scenes?id=eq.${sceneId}&select=narration`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const scenes = await sceneRes.json();
    if (!scenes.length) {
      res.status(404).json({ error: `Scene ${sceneId} not found` });
      return;
    }
    const narration = scenes[0].narration;
    const filename = `${sceneId}.mp3`;

    // 4. Generate audio via ElevenLabs
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVEN_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: narration,
          model_id: MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      res.status(502).json({ error: `ElevenLabs request failed: ${errText}` });
      return;
    }
    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());

    // 5. Overwrite the existing MP3 in Storage (upsert=true replaces it in place)
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${NARRATION_BUCKET}/${filename}?upsert=true`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "audio/mpeg",
          "x-upsert": "true",
        },
        body: audioBuffer,
      }
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      res.status(502).json({ error: `Storage upload failed: ${errText}` });
      return;
    }

    // 6. Make sure audio_path is set (harmless no-op if already correct)
    await fetch(`${SUPABASE_URL}/rest/v1/grcmanual_video_scenes?id=eq.${sceneId}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ audio_path: filename }),
    });

    res.status(200).json({ ok: true, filename, bytes: audioBuffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
};
