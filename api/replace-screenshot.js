// Vercel Serverless Function — POST /api/replace-screenshot
// Replaces ONE scene's screenshot image in Supabase Storage, overwriting the
// existing file in place so no database changes are needed. Requires the
// caller to be signed in as a registered staff user (checked via is_staff()).
//
// Expects the raw image bytes as the request body (not JSON/base64) — the
// client sends the File/Blob directly with its real Content-Type. Vercel's
// Node runtime leaves any non-JSON/text/form body as a raw Buffer in req.body.
//
// Required headers:
//   Content-Type    - the image's real MIME type (image/jpeg, image/png, etc.)
//   Authorization   - Bearer <the caller's Supabase access token>
//   X-Scene-Id      - the scene's numeric id
//
// Required Vercel environment variable (Project Settings -> Environment Variables):
//   SUPABASE_SERVICE_ROLE_KEY - Supabase dashboard -> Project Settings -> API -> service_role

const SUPABASE_URL = "https://blfgwysgekfqhcafofhe.supabase.co";
const STORAGE_BUCKET = "grcmanual-video-screenshots";
const MAX_BYTES = 8 * 1024 * 1024; // 8MB safety cap

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) {
    res.status(500).json({
      error:
        "Server not configured: missing SUPABASE_SERVICE_ROLE_KEY environment variable in Vercel project settings.",
    });
    return;
  }

  const sceneId = req.headers["x-scene-id"];
  if (!sceneId) {
    res.status(400).json({ error: "Missing X-Scene-Id header" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    res.status(401).json({ error: "Missing Authorization bearer token" });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("image/")) {
    res.status(400).json({ error: "Only image uploads are accepted" });
    return;
  }

  const imageBuffer = req.body;
  if (!imageBuffer || !imageBuffer.length) {
    res.status(400).json({ error: "Empty image body" });
    return;
  }
  if (imageBuffer.length > MAX_BYTES) {
    res.status(413).json({ error: `Image too large — max ${MAX_BYTES / 1024 / 1024}MB` });
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

    // 3. Look up the scene to resolve its existing screenshot filename
    const sceneRes = await fetch(
      `${SUPABASE_URL}/rest/v1/grcmanual_video_scenes?id=eq.${sceneId}&select=type,image_caption`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const scenes = await sceneRes.json();
    if (!scenes.length) {
      res.status(404).json({ error: `Scene ${sceneId} not found` });
      return;
    }
    const scene = scenes[0];
    if (scene.type !== "screen") {
      res.status(400).json({ error: "This scene has no screenshot slot (it's a text-only scene)" });
      return;
    }

    const match = (scene.image_caption || "").match(/([\w\-]+)\.+(?:png|jpg|jpeg)/i);
    if (!match) {
      res.status(400).json({
        error: "Could not determine the target filename from this scene's image_caption",
      });
      return;
    }
    const filename = `${match[1]}.jpg`; // storage convention: always saved as .jpg regardless of source format

    // 4. Overwrite the existing screenshot in Storage (upsert=true replaces it in place)
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${filename}?upsert=true`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": contentType,
          "x-upsert": "true",
        },
        body: imageBuffer,
      }
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      res.status(502).json({ error: `Storage upload failed: ${errText}` });
      return;
    }

    res.status(200).json({ ok: true, filename, bytes: imageBuffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
};
