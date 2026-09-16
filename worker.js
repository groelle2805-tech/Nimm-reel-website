ratio: "1024:1024"/**
 * NIMM-DOLL backend for Cloudflare Workers
 * Required secret: RUNWAYML_API_SECRET
 *
 * Routes:
 * POST /api/doll  -> starts a Runway image task
 * GET  /api/doll?task=<id> -> polls task status
 *
 * The browser sends the uploaded image as a data URI.
 * The secret is NEVER sent to the browser.
 */
const RUNWAY_API = "https://api.dev.runwayml.com/v1";

const STYLE_PROMPTS = {
  "Fashion": "premium collectible fashion doll, polished vinyl-like materials, editorial fashion styling, full-body, sophisticated studio lighting",
  "Glam": "glamorous collectible fashion doll, luxury evening styling, glossy details, dramatic studio lighting, premium beauty editorial",
  "Y2K": "playful early-2000s inspired fashion doll, trendy Y2K clothing, glossy accessories, vibrant but premium styling",
  "Luxury": "ultra-premium luxury fashion doll, elegant designer-inspired styling without logos, sophisticated accessories, high-end product photography",
  "Business": "confident professional fashion doll, modern business outfit, elegant accessories, premium collectible figure photography",
  "Summer": "stylish summer fashion doll, chic resort outfit, bright natural light, premium collectible product photography",
  "Doll in Box": "premium collectible fashion doll displayed inside a realistic clear blister package, personalized collector packaging, coordinated accessories, luxury retail product photography"
};

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"Content-Type":"application/json", "Access-Control-Allow-Origin":"*"}
  });
}

function promptFor(style, name) {
  const styleText = STYLE_PROMPTS[style] || STYLE_PROMPTS.Fashion;
  const label = (name || "Your Doll").slice(0,40);
  return `${styleText}. Transform the person in @person into an original stylized fashion doll while preserving recognizable facial characteristics, hair color and overall likeness. Do not copy any existing branded doll character. No brand logos. Clean premium composition. ${style === "Doll in Box" ? `The package label should read "${label}" and look like an original collectible brand.` : `The character name is "${label}".`} Make the result polished, realistic, detailed and social-media ready.`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response("", {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":"*",
          "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
          "Access-Control-Allow-Headers":"Content-Type"
        }
      });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/doll")) {
      return new Response("NIMM-DOLL API");
    }

    if (!env.RUNWAYML_API_SECRET) return json({error:"RUNWAYML_API_SECRET fehlt im Worker."},500);

    if (request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({error:"Ungültige Anfrage."},400); }
      if (!body.image || typeof body.image !== "string" || !body.image.startsWith("data:image/")) {
        return json({error:"Bitte ein gültiges Bild hochladen."},400);
      }

      const payload = {
        model: "gen4_image",
        ratio: "1:1",
        promptText: promptFor(body.style, body.name),
        referenceImages: [{ uri: body.image, tag: "person" }]
      };

      const r = await fetch(`${RUNWAY_API}/text_to_image`, {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "Authorization":`Bearer ${env.RUNWAYML_API_SECRET}`,
          "X-Runway-Version":"2024-11-06"
        },
        body:JSON.stringify(payload)
      });

      const data = await r.json();
      if (!r.ok) return json({error:data?.error || data?.message || "KI-Anfrage fehlgeschlagen."},500);
      return json({taskId:data.id});
    }

    if (request.method === "GET") {
      const taskId = url.searchParams.get("task");
      if (!taskId) return json({error:"task fehlt."},400);

      const r = await fetch(`${RUNWAY_API}/tasks/${encodeURIComponent(taskId)}`, {
        headers:{
          "Authorization":`Bearer ${env.RUNWAYML_API_SECRET}`,
          "X-Runway-Version":"2024-11-06"
        }
      });
      const data = await r.json();
      if (!r.ok) return json({error:data?.error || data?.message || "Task-Abfrage fehlgeschlagen."},500);

      if (data.status === "SUCCEEDED") return json({status:"SUCCEEDED", image:data.output?.[0]});
      if (data.status === "FAILED") return json({status:"FAILED", error:data.failure || "Bildgenerierung fehlgeschlagen."});
      return json({status:data.status || "RUNNING"});
    }

    return json({error:"Methode nicht unterstützt."},405);
  }
};
