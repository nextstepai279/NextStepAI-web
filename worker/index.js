import Anthropic from "@anthropic-ai/sdk";

const MAX_AI_QUESTIONS = 8;
const MAX_TEXT = 2000;
const ID_PATTERN = /^\d{13}-[a-z0-9]{6,12}$/;

const SYSTEM = `You are the intake interviewer for NextStepAI, a one-person AI consulting practice run by Sam. A prospective client is answering your questions before a free 30-minute strategy call with Sam. Sam will read the full transcript before the call.

Your job is to find the one or two pieces of repetitive, monotonous work in this business that are the best candidates for automation: the tasks someone does the same way every week, that eat real hours, and that nobody wants to do. For each candidate you want to know who does it, how often and how long it takes, what tools or systems it runs through, and where it goes wrong.

How to interview:
- One question at a time. Two or three sentences at most. Plain, direct, conversational. No bullet lists, no headings.
- Build on what they actually said. Use their words. Never ask for something they already told you.
- Don't give advice, solutions, or opinions about AI during the intake. You are gathering, not pitching. Don't promise outcomes or mention pricing.
- Don't flatter or open with reactions like "Great answer". Just ask the next thing.
- If an answer is vague, ask a more concrete version once, then move on.
- Also worth one question each if it fits naturally: what they have already tried, including any AI tools, and what a win would look like six months out.

When to stop: as soon as you have one or two clear candidates with who, how often, and which tools, wrap up. That is usually after four to six questions. Never exceed ${MAX_AI_QUESTIONS}.

Output rules:
- While interviewing: done=false, message=your next question, summary="".
- When wrapping up: done=true, message=a short closing note to the client that reflects back the one or two things you heard in their words, says Sam will read this before the call, and invites them to pick a time below. summary=notes for Sam only: the candidate tasks ranked, with who, frequency, tools, and pain, then anything else notable, written as plain text with line breaks.`;

const SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean" },
    message: { type: "string" },
    summary: { type: "string" },
  },
  required: ["done", "message", "summary"],
  additionalProperties: false,
};

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
  const { id, profile, turns, finish } = parsed;

  const record = {
    id,
    createdAt: new Date(Number(id.slice(0, 13))).toISOString(),
    updatedAt: new Date().toISOString(),
    profile,
    turns,
    done: false,
    summary: "",
  };

  if (finish) {
    record.done = true;
    record.summary = "Client ended the intake early (or the AI step failed). Transcript below is partial.";
    ctx.waitUntil(save(env, record));
    return json({ done: true, message: "", summary: record.summary });
  }

  let reply;
  try {
    reply = await nextTurn(env, profile, turns);
  } catch (err) {
    console.error("intake model error", err);
    ctx.waitUntil(save(env, record));
    return json({ error: "model_unavailable" }, 502);
  }

  const assistantTurns = turns.filter((t) => t.role === "assistant").length + 1;
  if (assistantTurns >= MAX_AI_QUESTIONS && !reply.done) {
    reply = { ...reply, done: true, summary: reply.summary || "Reached question cap before the model wrapped up. Review transcript." };
  }

  record.turns = [...turns, { role: "assistant", text: reply.message }];
  record.done = reply.done;
  record.summary = reply.summary;
  ctx.waitUntil(save(env, record));

  return json({ done: reply.done, message: reply.message, summary: reply.done ? reply.summary : "" });
}

function validate(body) {
  if (!body || typeof body !== "object") return { error: "Bad body" };
  const { id, profile, turns, finish } = body;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return { error: "Bad id" };
  if (!profile || typeof profile !== "object") return { error: "Bad profile" };

  const clean = {};
  for (const key of ["name", "email", "company", "about", "timeSink"]) {
    const v = profile[key];
    clean[key] = typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "";
  }
  if (!clean.name || !clean.email) return { error: "Name and email required" };

  if (!Array.isArray(turns) || turns.length > MAX_AI_QUESTIONS * 2 + 2) return { error: "Bad turns" };
  const cleanTurns = [];
  for (const t of turns) {
    if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.text !== "string") return { error: "Bad turn" };
    cleanTurns.push({ role: t.role, text: t.text.trim().slice(0, MAX_TEXT) });
  }

  return { id, profile: clean, turns: cleanTurns, finish: finish === true };
}

async function nextTurn(env, profile, turns) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    defaultHeaders: env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {},
  });

  const opening = [
    `Name and role: ${profile.name}`,
    `Company: ${profile.company || "(not given)"}`,
    `What the business does and team size: ${profile.about || "(not given)"}`,
    "",
    `Asked what the team spends too much time on, they said: ${profile.timeSink || "(no answer yet; ask this first)"}`,
  ].join("\n");

  const messages = [{ role: "user", content: opening }];
  for (const t of turns) messages.push({ role: t.role, content: t.text });

  const asked = turns.filter((t) => t.role === "assistant").length;
  if (asked >= MAX_AI_QUESTIONS - 1) {
    messages[messages.length - 1] = {
      role: "user",
      content: `${messages[messages.length - 1].content}\n\n(Interviewer note: this must be the final turn. Wrap up now with done=true.)`,
    };
  }

  const response = await client.beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages,
  });

  if (response.stop_reason === "refusal") {
    return {
      done: true,
      message: "Thanks, that gives Sam plenty to work with. Pick a time below and you can go deeper on the call.",
      summary: "Model declined to continue (refusal). Review transcript.",
    };
  }

  const text = response.content.find((b) => b.type === "text")?.text || "";
  const out = JSON.parse(text);
  return { done: out.done === true, message: String(out.message || ""), summary: String(out.summary || "") };
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
