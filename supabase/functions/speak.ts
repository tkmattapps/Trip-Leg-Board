// speak -- Supabase Edge Function. Kyle / Imogen, 14 Sep 2026.
//
// WHAT IT DOES: turns an Ask Beacon answer into audio with ElevenLabs and
// returns the MP3. The front end plays it in place of the browser's own
// speech synthesiser, and falls back to that synthesiser if this call fails.
//
// WHAT GOES OUT OF THE BUILDING: the answer text only. That text is written
// by ask-beacon from the guide and cannot contain a trip, a leg, a name or a
// tail number, because ask-beacon cannot see any of those. The person's
// question is never sent here. That is why ZDR is not a condition on this
// vendor the way it is on extraction (beacon-zdr-route.md).
//
// AUTH: same shape as ask-beacon. Refuse anonymous callers before reading the
// body; confirm the token with getUser. No table is read or written.
//
// SECRET: ELEVENLABS_API_KEY in Edge Function secrets. Never in the browser.
//
// VOICE: "Sally Ford", chosen by Kyle by ear on 14 Sep 2026. Model is a Flash
// one for latency and because it is half the credits per character.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const VOICE_ID = "kBag1HOZlaVBH7ICPE8x"; // Sally Ford
const MODEL_ID = "eleven_flash_v2_5";
// Streaming, because the wait Kyle noticed was all before the first word. The
// /stream endpoint returns audio as it is generated, so playback starts on the
// first sentence instead of after the last. The response is piped straight to
// the browser -- never collected into a buffer here, which would give the whole
// gain back.
//
// Optimisation 3 is max. NOT 4: that turns off the text normaliser, and this is
// aviation -- tail numbers, times and dates have to be read correctly.
const LATENCY_OPTIMIZATION = 3;
const MAX_TEXT_CHARS = 3000; // ask-beacon answers are a few sentences; this is a hard stop, not a target

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- 1. Who is calling? -------------------------------------------
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
      return jsonResponse({ error: "Not signed in." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not available to the function");
    }

    const sb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Your session has expired." }, 401);
    }

    // ---- 2. The text ----------------------------------------------------
    let body: { text?: unknown } = {};
    try { body = await req.json(); } catch { body = {}; }
    const text = String(body.text ?? "").trim().slice(0, MAX_TEXT_CHARS);
    if (!text) {
      return jsonResponse({ error: "Nothing to say." }, 400);
    }

    // ---- 3. ElevenLabs --------------------------------------------------
    const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not set in Edge Function secrets");
    }

    const el = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
        `?output_format=mp3_44100_64&optimize_streaming_latency=${LATENCY_OPTIMIZATION}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
        }),
      },
    );

    if (!el.ok) {
      const detail = await el.text().catch(() => "");
      return jsonResponse({ error: `Voice service failed (${el.status})`, detail: detail.slice(0, 300) }, 502);
    }

    // Pass the stream through untouched. Awaiting the body here would rebuild
    // the very delay the stream endpoint exists to remove.
    return new Response(el.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: message }, 500);
  }
});
