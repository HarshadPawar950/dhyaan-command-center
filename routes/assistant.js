// =============================================================
// routes/assistant.js — Floating "How can I help you?" portal assistant.
// A how-to helper only — NO database access, NO personal data.
//
// DEFAULT = LOCAL mode (ASSISTANT_MODE=local): answers come from the local
// knowledge base (lib/assistant-kb.js). Zero external calls, zero cost. This is
// the shipped default. The legacy Anthropic-API path is preserved but gated
// behind ASSISTANT_MODE=api (+ ANTHROPIC_API_KEY) — see MODE below.
//
// Guards (both modes): auth required · CSRF (global csurf) · in-memory rate
// limit (10/user/min, harmless in local mode). API mode adds: cost cap
// (max_tokens 1000, last 4 messages, stateless) + graceful "unavailable" on
// missing key/SDK/error. No lead/client/employee data is ever sent to the API.
// =============================================================

const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const kb = require('../lib/assistant-kb');

// ASSISTANT_MODE = 'local' (default) | 'api'
//   local → answers come from the local knowledge base (lib/assistant-kb.js).
//           ZERO external calls, zero cost, zero personal data. This is the
//           default and the recommended production mode.
//   api   → the legacy behaviour: calls the Anthropic API (claude-sonnet-4-6)
//           server-side, only if ANTHROPIC_API_KEY is also present. Flip by
//           setting ASSISTANT_MODE=api in .env and restarting.
const MODE = (process.env.ASSISTANT_MODE || 'local').toLowerCase();

// Guarded SDK load — if the package isn't installed the feature degrades
// gracefully instead of crashing the server at require time.
let Anthropic = null;
try {
    const mod = require('@anthropic-ai/sdk');
    Anthropic = mod && (mod.default || mod);
} catch (_) {
    console.warn('[assistant] @anthropic-ai/sdk not installed — assistant will report unavailable.');
}

const MODEL = 'claude-sonnet-4-6';   // Boss's explicit choice
const MAX_TOKENS = 1000;             // cost guard
const HISTORY_TURNS = 4;             // last 4 messages only

const SYSTEM_PROMPT = `You are the Dhyaan Command Center Assistant — an in-app help guide for the
staff of Dhyaan Enterprises, a premium real estate firm in Navi Mumbai. Your
ONLY job is to help employees USE this internal portal: where features live,
how to complete tasks, and what each module does.

WHAT THE PORTAL CONTAINS (your knowledge — do not invent features beyond this):
- Dashboard: personal overview of leads, tasks, performance.
- Leads: "My Leads" (employee) / "All Leads" (admin). Add a lead, record
  feedback, set follow-ups, mark closure. Lead detail has a "Find Matches"
  button that suggests the 5 best-fit properties.
- Properties: browse the inventory (projects + units, price, config, location).
- Cost Sheets: pick a builder -> project -> unit to generate a branded
  Maharashtra cost sheet (stamp duty, GST, registration). History is saved.
- Commissions: receivables and receipts per closed deal.
- Bookings & Token Receipts: record a booking, issue token receipts.
- Client Database: promoted clients and their profiles.
- Site Visits: schedule and log visits; calendar view.
- Marketing: campaigns and spend (admin).
- KPI & Targets, Daily Reports, Follow-Ups, Sales History: reporting.
- Attendance, Leave, Incentives: HR self-service; HR Console for managers.
- Super Admin (senior staff only): Builder Master, Lead Scoring, Audit Log,
  Restore Archive, Export Control, Approval Center.

HOW TO ANSWER:
- Be concise, warm, and practical. Give click-path directions ("Open the lead,
  then click Find Matches"). English only.
- If asked how to do something, walk through the steps using the modules above.
- If you don't know or the portal may not support it, say so honestly and
  suggest the closest module or asking an admin.

HARD BOUNDARIES:
- You have NO access to the database. You cannot look up any specific lead,
  client, employee, phone number, commission figure, or record. If asked for
  specific data ("what's Rahul's budget", "show me today's bookings"), explain
  that you can't see records and point them to the right page to look it up
  themselves.
- Never reveal or speculate about other employees' data, salaries, or
  performance. Redirect such questions to the appropriate page or an admin.
- Never provide legal, tax, or financial advice beyond describing what a portal
  feature computes. Do not invent numbers.
- Stay on the topic of using this portal. Politely decline unrelated requests.`;

// ---- in-memory rate limit: 10 requests / user / rolling 60s ----
const RATE_MAX = 10;
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map(); // userId -> [timestamps]
function rateLimited(userId) {
    const now = Date.now();
    const arr = (hits.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) { hits.set(userId, arr); return true; }
    arr.push(now);
    hits.set(userId, arr);
    return false;
}

const UNAVAILABLE = 'The assistant is unavailable right now. Please try again in a moment, or ask an admin.';

// Client factory — overridable in tests to mock the API call path without
// burning real tokens. Production path news up the real SDK client.
let makeClient = function (key) { return new Anthropic({ apiKey: key }); };

// GET /assistant/token — hands the widget a fresh CSRF token (a safe GET, so
// csurf itself doesn't require a token here). Keeps the token out of the
// sidebar partials, which aren't always rendered with res.locals in scope.
router.get('/token', ensureAuthenticated, (req, res) => {
    let token = '';
    try { token = typeof req.csrfToken === 'function' ? req.csrfToken() : ''; } catch (_) {}
    res.json({ csrfToken: token });
});

// GET /assistant/intro — quick-question chips shown when the panel opens.
router.get('/intro', ensureAuthenticated, (req, res) => {
    res.json({ quickQuestions: kb.QUICK_QUESTIONS, mode: MODE });
});

// POST /assistant/ask  { messages: [{role:'user'|'assistant', content:'...'}] }
router.post('/ask', ensureAuthenticated, async (req, res) => {
    const userId = (req.session.user && req.session.user.id) || 'anon';

    if (rateLimited(userId)) {
        return res.status(429).json({ reply: 'You are sending messages a bit fast — please wait a few seconds and try again.', rateLimited: true });
    }

    // ----- LOCAL knowledge-base mode (default): NO external calls -----
    if (MODE !== 'api') {
        const localMsgs = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
        const lastUser = localMsgs.slice().reverse()
            .find(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
        const q = lastUser ? lastUser.content : '';
        const hit = kb.match(q);
        if (hit) return res.json({ reply: hit.entry.answer, link: hit.entry.link || null, source: 'kb' });
        return res.json({ reply: kb.FALLBACK.text, suggestions: kb.FALLBACK.suggestions, source: 'kb' });
    }

    // ----- API mode (legacy, behind ASSISTANT_MODE=api) -----
    // Graceful degradation: no SDK or no key -> friendly, not an error.
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
        return res.json({ reply: UNAVAILABLE, unavailable: true });
    }

    // Sanitize + clamp the client-held conversation to the last 4 turns.
    let msgs = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    msgs = msgs
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }))
        .slice(-HISTORY_TURNS);
    while (msgs.length && msgs[0].role === 'assistant') msgs.shift(); // API requires a leading user turn
    if (!msgs.length) return res.json({ reply: 'Ask me anything about using the portal — for example, "How do I generate a cost sheet?"' });

    try {
        const client = makeClient(process.env.ANTHROPIC_API_KEY);
        const resp = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: msgs,
        });
        if (resp.stop_reason === 'refusal') {
            return res.json({ reply: "I can't help with that one — I'm just here to help you use the portal. Try asking about a feature or how to complete a task." });
        }
        const text = (resp.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim();
        return res.json({ reply: text || 'Sorry, I did not catch that — could you rephrase?' });
    } catch (err) {
        console.error('[assistant] API call failed:', err.status || '', err.message);
        return res.json({ reply: UNAVAILABLE, unavailable: true });
    }
});

// Test-only seams (never used in production paths).
module.exports = router;
module.exports.__setClientFactory = function (f) { makeClient = f; };
module.exports.__config = { MODEL, MAX_TOKENS, HISTORY_TURNS, RATE_MAX };
