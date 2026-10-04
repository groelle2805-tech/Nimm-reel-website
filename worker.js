const RUNWAY_API = "https://api.dev.runwayml.com/v1";

const PRICE_STANDARD = "price_1UM7omEBiYsyt7YHIq960Ajw";
const PRICE_BOX = "price_1UM7sIEBiYsyt7YHwEUOXTly";

const STYLE_PROMPTS = {
  Fashion: "premium collectible fashion doll, polished vinyl-like materials, editorial fashion styling, full-body, sophisticated studio lighting",
  Glam: "glamorous collectible fashion doll, luxury evening styling, glossy details, dramatic studio lighting, premium beauty editorial",
  Y2K: "playful early-2000s inspired fashion doll, trendy Y2K clothing, glossy accessories, vibrant but premium styling",
  Luxury: "ultra-premium luxury fashion doll, elegant designer-inspired styling without logos, sophisticated accessories, high-end product photography",
  Business: "confident professional fashion doll, modern business outfit, elegant accessories, premium collectible figure photography",
  Summer: "stylish summer fashion doll, chic resort outfit, bright natural light, premium collectible product photography",
  "Doll in Box": "premium collectible fashion doll displayed inside a realistic clear blister package, personalized collector packaging, coordinated accessories, luxury retail product photography",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://www.nimmreel.de",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-NIMMDOLL-Test-Key",
    },
  });
}

function promptFor(style, name = "", accessories = []) {
  const accessoryText = Array.isArray(accessories) && accessories.length ? accessories.slice(0, 9).join(", ") : "keine";
  const safeName = String(name || "").trim().slice(0, 40);

  if (style === "Doll in Box") {
    return `Using @person, create ONLY the contents for a collectible doll package, not the package itself. Preserve the recognizable face, age, skin tone, hairstyle and hair color. One complete full-body fashion doll standing on the LEFT, head and shoes fully visible. On the RIGHT, show exactly these separate accessories: ${accessoryText}. Each accessory isolated and fully visible. Simple uniform dark charcoal studio background. No box, no blister shell, no retail packaging, no border, no frame, no title area, no footer. No words, letters, numbers, logos, labels or barcode. Exactly one person and one face. Keep generous empty margin around every object.`;
  }

  const looks = {
    Fashion: "editorial fashion outfit, sophisticated studio lighting, premium collectible doll photography",
    Glam: "luxury evening outfit, glamorous styling, polished studio lighting, premium collectible doll photography",
    Y2K: "early-2000s inspired outfit and accessories, playful premium collectible doll photography",
    Luxury: "elegant luxury outfit and accessories, sophisticated premium collectible doll photography",
    Business: "modern professional business outfit, confident premium collectible doll photography",
    Summer: "chic summer resort outfit, bright natural light, premium collectible doll photography",
  };

  return `@person as a premium collectible fashion doll. Keep @person's recognizable facial identity, facial proportions, hairstyle, hair color, skin tone and distinctive features consistent with the reference photo. Full-body composition. ${looks[style] || looks.Fashion}.`;
}

function parseDataUrl(value) {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/s.exec(value || "");
  if (!match) return null;
  const mime = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime, bytes };
  } catch { return null; }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((sig) => sig === expected);
}

async function createStripeSession(env, orderId, style) {
  const priceId = style === "Doll in Box" ? PRICE_BOX : PRICE_STANDARD;
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("metadata[order_id]", orderId);
  form.set("success_url", `https://www.nimmreel.de/?checkout=success&order=${encodeURIComponent(orderId)}&session_id={CHECKOUT_SESSION_ID}#nimm-doll`);
  form.set("cancel_url", `https://www.nimmreel.de/?checkout=cancelled&order=${encodeURIComponent(orderId)}#nimm-doll`);
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = await response.json();
  if (!response.ok || !data.url) throw new Error(data?.error?.message || "Stripe Checkout konnte nicht erstellt werden.");
  return data;
}

async function startGeneration(env, orderId) {
  const claim = await env.DB.prepare(`UPDATE orders SET generation_status = 'starting', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status = 'paid' AND generation_status = 'waiting'`).bind(orderId).run();
  if (!claim.meta?.changes) return;
  try {
    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first();
    if (!order) throw new Error("Bestellung nicht gefunden.");
    const object = await env.UPLOADS.get(order.image_data);
    if (!object) throw new Error("Kundenfoto nicht gefunden.");
    const imageBuffer = await object.arrayBuffer();
    const mime = object.customMetadata?.mime || "image/jpeg";
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const initUploadResponse = await fetch(`${RUNWAY_API}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RUNWAYML_API_SECRET}`, "X-Runway-Version": "2024-11-06" },
      body: JSON.stringify({ filename: `reference.${ext}`, type: "ephemeral" }),
    });
    const uploadData = await initUploadResponse.json();
    if (!initUploadResponse.ok || !uploadData.uploadUrl || !uploadData.runwayUri) throw new Error(`Runway upload init ${initUploadResponse.status}: ${JSON.stringify(uploadData)}`);
    const form = new FormData();
    for (const [key, value] of Object.entries(uploadData.fields || {})) form.append(key, String(value));
    form.append("file", new Blob([imageBuffer], { type: mime }), `reference.${ext}`);
    const fileUploadResponse = await fetch(uploadData.uploadUrl, { method: "POST", body: form });
    if (!fileUploadResponse.ok) throw new Error(`Runway file upload ${fileUploadResponse.status}: ${await fileUploadResponse.text()}`);
    const runwayUri = uploadData.runwayUri;
    let accessories = [];
    try { accessories = order.accessories ? JSON.parse(order.accessories) : []; } catch { accessories = []; }
    const payload = {
      model: "gen4_image",
      ratio: "1920:1080",
      promptText: promptFor(order.style, order.name, accessories),
      referenceImages: [{ uri: runwayUri, tag: "person" }],
    };
    const response = await fetch(`${RUNWAY_API}/text_to_image`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RUNWAYML_API_SECRET}`, "X-Runway-Version": "2024-11-06" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.id) {
      const runwayDetail = JSON.stringify(data);
      console.error("RUNWAY_START_ERROR", orderId, response.status, runwayDetail);
      throw new Error(`Runway ${response.status}: ${runwayDetail || "Start fehlgeschlagen"}`);
    }
    await env.DB.prepare(`UPDATE orders SET runway_task_id = ?, generation_status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(data.id, orderId).run();
  } catch (error) {
    await env.DB.prepare(`UPDATE orders SET generation_status = 'failed', result_image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind("ERROR:" + String(error?.message || error).slice(0,900), orderId).run();
    console.error("GENERATION_ERROR", orderId, error);
  }
}

async function pollOrder(env, orderId) {
  const order = await env.DB.prepare(`SELECT id, payment_status, generation_status, runway_task_id, result_image, image_data, name, style FROM orders WHERE id = ?`).bind(orderId).first();
  if (!order) return json({ error: "Bestellung nicht gefunden." }, 404);
  if (order.payment_status === "paid" && order.generation_status === "failed") {
    return json({ orderId: order.id, paymentStatus: "paid", generationStatus: "failed", recoverable: !!order.image_data, image: null, error: order.result_image?.startsWith("ERROR:") ? order.result_image.slice(6) : "Bildgenerierung fehlgeschlagen.", name: order.name || "", style: order.style || "" });
  }
  if (order.generation_status !== "running" || !order.runway_task_id) {
    return json({ orderId: order.id, paymentStatus: order.payment_status, generationStatus: order.generation_status, image: order.result_image ? (order.result_image.startsWith("orders/") ? `/api/doll/result?order=${encodeURIComponent(order.id)}` : order.result_image) : null, name: order.name || "", style: order.style || "" });
  }
  const response = await fetch(`${RUNWAY_API}/tasks/${encodeURIComponent(order.runway_task_id)}`, {
    headers: { Authorization: `Bearer ${env.RUNWAYML_API_SECRET}`, "X-Runway-Version": "2024-11-06" },
  });
  const data = await response.json();
  if (!response.ok) return json({ error: data?.error || data?.message || "Runway-Status konnte nicht abgefragt werden." }, 502);
  if (data.status === "SUCCEEDED") {
    const image = data.output?.[0] || null;
    if (!image) return json({ error: "Runway hat kein Ergebnisbild geliefert." }, 502);
    const resultKey = `orders/${orderId}/result`;
    let storedResult = false;
    try {
      const imageResponse = await fetch(image);
      if (!imageResponse.ok) throw new Error("Runway-Ergebnis konnte nicht gespeichert werden.");
      const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
      await env.UPLOADS.put(resultKey, imageResponse.body, { httpMetadata: { contentType } });
      storedResult = true;
    } catch (error) {
      console.error("RESULT_STORE_FAILED", orderId, error?.message || error);
    }
    const resultRef = storedResult ? resultKey : image;
    await env.DB.prepare(`UPDATE orders SET generation_status = 'succeeded', result_image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(resultRef, orderId).run();
    if (order.image_data) await env.UPLOADS.delete(order.image_data).catch(() => {});
    return json({ orderId, paymentStatus: "paid", generationStatus: "succeeded", image: storedResult ? `/api/doll/result?order=${encodeURIComponent(orderId)}` : image, name: order.name || "", style: order.style || "" });
  }
  if (data.status === "FAILED") {
    const failure = data.failure || data.failureCode || data.error || data.message || "Runway-Bildgenerierung fehlgeschlagen.";
    const failureDetail = typeof failure === "string" ? failure : JSON.stringify(failure);
    console.error("RUNWAY_TASK_FAILED", orderId, JSON.stringify(data));
    await env.DB.prepare(`UPDATE orders SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(orderId).run();
    return json({ orderId, paymentStatus: "paid", generationStatus: "failed", error: failureDetail, name: order.name || "", style: order.style || "" });
  }
  return json({ orderId, paymentStatus: "paid", generationStatus: "running", name: order.name || "", style: order.style || "" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: { "Access-Control-Allow-Origin": "https://www.nimmreel.de", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-NIMMDOLL-Test-Key" } });
    }
    if (!env.DB || !env.UPLOADS || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.RUNWAYML_API_SECRET) {
      return json({ error: "Server-Konfiguration unvollständig." }, 500);
    }
    if (url.pathname === "/api/stripe/webhook" && request.method === "POST") {
      const rawBody = await request.text();
      const valid = await verifyStripeSignature(rawBody, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
      if (!valid) return new Response("Invalid signature", { status: 400 });
      let event;
      try { event = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }
      if (event.type === "checkout.session.completed") {
        const session = event.data?.object;
        const orderId = session?.metadata?.order_id;
        if (orderId && session?.payment_status === "paid") {
          await env.DB.prepare(`UPDATE orders SET stripe_session_id = ?, payment_status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(session.id, orderId).run();
          ctx.waitUntil(startGeneration(env, orderId));
        }
      }
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/api/doll/admin-test" && request.method === "POST") {
      const supplied = request.headers.get("X-NIMMDOLL-Test-Key") || "";
      if (!env.NIMMDOLL_TEST_KEY || supplied !== env.NIMMDOLL_TEST_KEY) {
        return json({ error: "Admin-Schlüssel ungültig." }, 401);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
      const parsed = parseDataUrl(body.image);
      if (!parsed) return json({ error: "Bitte ein gültiges Foto hochladen." }, 400);
      if (parsed.bytes.byteLength > 10 * 1024 * 1024) return json({ error: "Das Foto darf maximal 10 MB groß sein." }, 413);
      const style = typeof body.style === "string" && STYLE_PROMPTS[body.style] ? body.style : "Fashion";
      const accessories = Array.isArray(body.accessories) ? body.accessories.slice(0, 9) : [];
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
      if (style === "Doll in Box" && !name) return json({ error: "Bitte einen Namen für die Doll eingeben." }, 400);
      const orderId = crypto.randomUUID();
      const uploadKey = `orders/${orderId}/photo`;
      await env.UPLOADS.put(uploadKey, parsed.bytes, { customMetadata: { mime: parsed.mime } });
      try {
        await env.DB.prepare(`INSERT INTO orders (id, payment_status, style, name, accessories, image_data, generation_status, paid_at) VALUES (?, 'paid', ?, ?, ?, ?, 'waiting', CURRENT_TIMESTAMP)`).bind(orderId, style, name, JSON.stringify(accessories), uploadKey).run();
        ctx.waitUntil(startGeneration(env, orderId));
        return json({ orderId, adminTest: true });
      } catch (error) {
        await env.UPLOADS.delete(uploadKey).catch(() => {});
        await env.DB.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId).run().catch(() => {});
        return json({ error: error?.message || "Admin-Test konnte nicht gestartet werden." }, 500);
      }
    }
    if (url.pathname === "/api/doll/checkout" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
      const parsed = parseDataUrl(body.image);
      if (!parsed) return json({ error: "Bitte ein gültiges Foto hochladen." }, 400);
      if (parsed.bytes.byteLength > 10 * 1024 * 1024) return json({ error: "Das Foto darf maximal 10 MB groß sein." }, 413);
      const style = typeof body.style === "string" && STYLE_PROMPTS[body.style] ? body.style : "Fashion";
      const accessories = Array.isArray(body.accessories) ? body.accessories.slice(0, 9) : [];
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
      if (style === "Doll in Box" && !name) return json({ error: "Bitte einen Namen für die Doll eingeben." }, 400);
      const orderId = crypto.randomUUID();
      const uploadKey = `orders/${orderId}/photo`;
      await env.UPLOADS.put(uploadKey, parsed.bytes, { customMetadata: { mime: parsed.mime } });
      try {
        await env.DB.prepare(`INSERT INTO orders (id, payment_status, style, name, accessories, image_data, generation_status) VALUES (?, 'pending', ?, ?, ?, ?, 'waiting')`).bind(orderId, style, name, JSON.stringify(accessories), uploadKey).run();
        const session = await createStripeSession(env, orderId, style);
        await env.DB.prepare(`UPDATE orders SET stripe_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(session.id, orderId).run();
        return json({ orderId, checkoutUrl: session.url });
      } catch (error) {
        await env.UPLOADS.delete(uploadKey).catch(() => {});
        await env.DB.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId).run().catch(() => {});
        return json({ error: error?.message || "Checkout konnte nicht erstellt werden." }, 500);
      }
    }
    if (url.pathname === "/api/doll/result" && request.method === "GET") {
      const orderId = (url.searchParams.get("order") || "").trim();
      if (!orderId) return json({ error: "Bestellnummer fehlt." }, 400);
      const order = await env.DB.prepare(`SELECT payment_status, generation_status, result_image FROM orders WHERE id = ?`).bind(orderId).first();
      if (!order || order.payment_status !== "paid" || order.generation_status !== "succeeded") return json({ error: "Ergebnis nicht verfügbar." }, 404);
      if (!order.result_image || !order.result_image.startsWith("orders/")) return Response.redirect(order.result_image, 302);
      const object = await env.UPLOADS.get(order.result_image);
      if (!object) return json({ error: "Ergebnis nicht verfügbar." }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "private, max-age=3600");
      return new Response(object.body, { headers });
    }
    if (url.pathname === "/api/doll/retry" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
      const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
      if (!orderId) return json({ error: "Bestellnummer fehlt." }, 400);
      const order = await env.DB.prepare(`SELECT id, payment_status, generation_status, image_data FROM orders WHERE id = ?`).bind(orderId).first();
      if (!order) return json({ error: "Bestellung nicht gefunden." }, 404);
      if (order.payment_status !== "paid") return json({ error: "Bestellung ist nicht bezahlt." }, 403);
      if (order.generation_status !== "failed") return json({ error: "Diese Bestellung kann nicht erneut gestartet werden." }, 409);
      if (!order.image_data) return json({ error: "Das ursprüngliche Kundenfoto ist nicht mehr verfügbar." }, 410);
      const object = await env.UPLOADS.get(order.image_data);
      if (!object) return json({ error: "Das ursprüngliche Kundenfoto ist nicht mehr verfügbar." }, 410);
      const reset = await env.DB.prepare(`UPDATE orders SET generation_status = 'waiting', runway_task_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status = 'paid' AND generation_status = 'failed'`).bind(orderId).run();
      if (!reset.meta?.changes) return json({ error: "Bestellung konnte nicht zurückgesetzt werden." }, 409);
      ctx.waitUntil(startGeneration(env, orderId));
      return json({ orderId, paymentStatus: "paid", generationStatus: "waiting", retried: true });
    }
    if (url.pathname === "/api/doll" && request.method === "GET") {
      const orderId = url.searchParams.get("order");
      if (!orderId) return json({ error: "order fehlt." }, 400);
      return pollOrder(env, orderId);
    }
    if (url.pathname === "/api/doll" && request.method === "POST") {
      return json({ error: "Vor der Bildgenerierung ist eine Zahlung erforderlich." }, 402);
    }
    return new Response("NIMM-DOLL API", { status: 200 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const expiredResults = await env.DB.prepare(`SELECT id, result_image FROM orders WHERE generation_status = 'succeeded' AND result_image LIKE 'orders/%/result' AND updated_at < datetime('now','-30 days') LIMIT 100`).all();
      for (const order of expiredResults.results || []) {
        if (order.result_image) await env.UPLOADS.delete(order.result_image).catch(() => {});
        await env.DB.prepare(`UPDATE orders SET result_image = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(order.id).run();
      }
      const abandoned = await env.DB.prepare(`SELECT id, image_data FROM orders WHERE payment_status = 'pending' AND created_at < datetime('now','-1 day') LIMIT 100`).all();
      for (const order of abandoned.results || []) {
        if (order.image_data) await env.UPLOADS.delete(order.image_data).catch(() => {});
        await env.DB.prepare(`DELETE FROM orders WHERE id = ? AND payment_status = 'pending'`).bind(order.id).run();
      }
      const failed = await env.DB.prepare(`SELECT id, image_data FROM orders WHERE payment_status = 'paid' AND generation_status = 'failed' AND updated_at < datetime('now','-7 days') LIMIT 100`).all();
      for (const order of failed.results || []) {
        if (order.image_data) await env.UPLOADS.delete(order.image_data).catch(() => {});
        await env.DB.prepare(`UPDATE orders SET image_data = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(order.id).run();
      }
    })());
  }
};
