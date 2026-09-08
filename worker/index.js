import Anthropic from "@anthropic-ai/sdk";

const MAX_QUESTIONS = 12;
const MAX_TEXT = 2000;
const ID_PATTERN = /^\d{13}-[a-z0-9]{6,12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROFILE_KEYS = ["name", "role", "email", "company", "website", "about", "timeSink"];

const SYSTEM = `You are the intake interviewer for NextStepAI, a one-person AI consulting practice run by Sam. A prospective client is answering your questions before a free 30-minute strategy call with Sam. Sam will read the full transcript before the call.

You need two kinds of information.

1. Basics: their name, their role, an email address, the company name (and website if they have one), and a sentence or two on what the business does and roughly how many people work there.

2. The real substance: the one or two pieces of repetitive, monotonous work in this business that are the best candidates for automation. The tasks someone does the same way every week, that eat real hours, and that nobody wants to do. For each candidate you want who does it, how often and how long it takes, what tools or systems it runs through, and where it goes wrong.

Before every question, re-read the whole conversation and fill in the profile with everything they have said so far. Then ask only for what is still missing. People often answer several things at once ("I'm Jane, ops manager at Smith Plumbing"), so never ask for something already given. If more than one basic is missing, ask for them together in one natural question rather than one at a time. An email address is required before you can finish; ask for it plainly when it is the natural moment, usually right after you know who they are.

How to interview:
- One question at a time. Two or three sentences at most. Plain, direct, conversational. No bullet lists, no headings.
- Build on what they actually said. Use their words.
- Don't give advice, solutions, or opinions about AI during the intake. You are gathering, not pitching. Don't promise outcomes or mention pricing.
- Don't flatter or open with reactions like "Great answer". Just ask the next thing.
- If an answer is vague, ask a more concrete version once, then move on.
- Also worth one question each if it fits naturally: what they have already tried, including any AI tools, and what a win would look like six months out.

When to stop: once you have the basics plus one or two clear candidates with who, how often, and which tools, wrap up. That is usually eight to ten questions in total. Never exceed ${MAX_QUESTIONS}.

Output format: respond with a single JSON object and nothing else. No code fences, no text before or after. Shape:
{"profile": {"name": "", "role": "", "email": "", "company": "", "website": "", "about": "", "timeSink": ""}, "done": false, "message": "", "summary": ""}

Output rules:
- profile: every field filled from the conversation so far, using their exact words; an empty string for anything not yet known.
- While interviewing: done=false, message=your next question, summary="".
- When wrapping up: done=true, message=a short closing note to the client that reflects back the one or two things you heard in their words, says Sam will read this before the call, and invites them to pick a time below. summary=notes for Sam only: the candidate tasks ranked, with who, frequency, tools, and pain, then anything else notable, written as plain text with line breaks.`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/intake") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleIntake(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function handleIntake(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const parsed = validate(body);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const { id, carried, profile, turns, finish } = parsed;

  const record = {
    id,
    createdAt: new Date(Number(id.slice(0, 13))).toISOString(),
    updatedAt: new Date().toISOString(),
    carried,
    profile,
    turns,
    done: false,
    summary: "",
  };

  if (finish) {
    record.done = true;
    record.summary = "Client ended the intake early (or the AI step failed). Transcript below is partial.";
    ctx.waitUntil(save(env, record));
    return json({ done: true, message: "", summary: record.summary, profile });
  }

  let reply;
  try {
    reply = await nextTurn(env, carried, turns);
  } catch (err) {
    console.error("intake model error", err);
    ctx.waitUntil(save(env, record));
    return json({ error: "model_unavailable" }, 502);
  }

  const asked = turns.filter((t) => t.role === "assistant").length + 1;
  if (reply.done && !EMAIL_PATTERN.test(reply.profile.email)) {
    reply = { ...reply, done: false, summary: "", message: "One last thing before we wrap up: what's the best email to reach you at?" };
  }
  if (asked >= MAX_QUESTIONS && !reply.done) {
    reply = { ...reply, done: true, summary: reply.summary || "Reached question cap before the model wrapped up. Review transcript." };
  }

  record.profile = reply.profile;
  record.turns = [...turns, { role: "assistant", text: reply.message }];
  record.done = reply.done;
  record.summary = reply.summary;
  ctx.waitUntil(save(env, record));

  return json({ done: reply.done, message: reply.message, summary: reply.done ? reply.summary : "", profile: reply.profile });
}

function validate(body) {
  if (!body || typeof body !== "object") return { error: "Bad body" };
  const { id, carried, profile, turns, finish } = body;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return { error: "Bad id" };

  const cleanProfile = {};
  for (const key of PROFILE_KEYS) {
    const v = profile && profile[key];
    cleanProfile[key] = typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "";
  }

  if (!Array.isArray(turns) || turns.length > MAX_QUESTIONS * 2 + 2) return { error: "Bad turns" };
  const cleanTurns = [];
  for (const t of turns) {
    if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.text !== "string") return { error: "Bad turn" };
    cleanTurns.push({ role: t.role, text: t.text.trim().slice(0, MAX_TEXT) });
  }
  if (!finish && (cleanTurns.length === 0 || cleanTurns[cleanTurns.length - 1].role !== "user")) return { error: "Last turn must be the client" };

  return {
    id,
    carried: typeof carried === "string" ? carried.trim().slice(0, MAX_TEXT) : "",
    profile: cleanProfile,
    turns: cleanTurns,
    finish: finish === true,
  };
}

async function nextTurn(env, carried, turns) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    defaultHeaders: env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {},
  });

  const opening = carried
    ? `Before this conversation started, on the homepage, they were asked what their team spends too much time on and wrote: "${carried}". Treat that as already answered.`
    : "The conversation starts now. Nothing is known about them yet.";

  const messages = [{ role: "user", content: opening }];
  for (const t of turns) messages.push({ role: t.role, content: t.text });

  const asked = turns.filter((t) => t.role === "assistant").length;
  if (asked >= MAX_QUESTIONS - 1) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { role: "user", content: `${last.content}\n\n(Interviewer note: this must be the final turn. Wrap up now with done=true.)` };
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.beta.messages.create({
        model: "claude-opus-5",
        max_tokens: 2500,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: SYSTEM,
        messages,
      });
      if (response.stop_reason === "refusal") return refusalReply();
      return parseReply(response.content.find((b) => b.type === "text")?.text || "");
    } catch (err) {
      lastError = err;
      console.error(`intake attempt ${attempt + 1} failed`, err?.status || "", err?.message || err);
    }
  }
  throw lastError;
}

function parseReply(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in model reply");
  const out = JSON.parse(text.slice(start, end + 1));
  if (typeof out.message !== "string" || !out.message.trim()) throw new Error("Model reply missing message");
  const profile = emptyProfile();
  for (const key of PROFILE_KEYS) profile[key] = String((out.profile && out.profile[key]) || "").trim();
  return { profile, done: out.done === true, message: out.message.trim(), summary: String(out.summary || "") };
}

function refusalReply() {
  return {
    profile: emptyProfile(),
    done: true,
    message: "Thanks, that gives Sam plenty to work with. Pick a time below and you can go deeper on the call.",
    summary: "Model declined to continue (refusal). Review transcript.",
  };
}

function emptyProfile() {
  return Object.fromEntries(PROFILE_KEYS.map((k) => [k, ""]));
}

async function save(env, record) {
  await env.INTAKE.put(`intake:${record.id}`, JSON.stringify(record));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
