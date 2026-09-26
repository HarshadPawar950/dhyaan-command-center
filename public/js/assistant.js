/* =============================================================
   assistant.js — floating "How can I help you?" helper (AI Day, Feature 2)
   Gold circle button (bottom-right) -> slide-up panel. Full-screen sheet on
   phone. Conversation is held CLIENT-SIDE and posted to /assistant/ask with
   the CSRF token. Self-contained: injects its own navy/gold CSS.
   The including <script> tag carries data-csrf="<csrfToken>".
   ============================================================= */
(function () {
    if (document.getElementById('dh-assistant-root')) return; // once per page

    // CSRF token is fetched from a safe GET so the sidebar partials need no
    // EJS variable (they aren't always rendered with res.locals in scope).
    var CSRF = '';
    function ensureToken() {
        if (CSRF) return Promise.resolve(CSRF);
        return fetch('/assistant/token', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (d) { CSRF = (d && d.csrfToken) || ''; return CSRF; })
            .catch(function () { return ''; });
    }

    var css = document.createElement('style');
    css.textContent = [
        '#dh-asst-btn{position:fixed;bottom:22px;right:22px;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#D4AF37 0%,#E8C766 100%);border:none;box-shadow:0 8px 24px rgba(10,22,40,0.28);cursor:pointer;z-index:900;display:flex;align-items:center;justify-content:center;transition:transform .15s ease;}',
        '#dh-asst-btn:hover{transform:translateY(-2px) scale(1.03);}',
        '#dh-asst-btn svg{width:28px;height:28px;stroke:#0A1628;}',
        '#dh-asst-panel{position:fixed;bottom:94px;right:22px;width:360px;max-width:calc(100vw - 44px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(10,22,40,0.32);z-index:901;display:none;flex-direction:column;overflow:hidden;border:1px solid rgba(10,22,40,0.08);}',
        '#dh-asst-panel.open{display:flex;}',
        '#dh-asst-head{background:linear-gradient(135deg,#0A1628 0%,#142238 100%);color:#FAFAF7;padding:16px 18px;display:flex;justify-content:space-between;align-items:center;}',
        '#dh-asst-head .t{font-family:"Playfair Display",serif;font-size:16px;font-weight:600;}',
        '#dh-asst-head .s{font-size:11px;color:rgba(212,175,55,0.9);letter-spacing:.5px;text-transform:uppercase;margin-top:2px;}',
        '#dh-asst-close{background:none;border:none;color:#FAFAF7;font-size:22px;cursor:pointer;line-height:1;opacity:.8;}',
        '#dh-asst-close:hover{opacity:1;}',
        '#dh-asst-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#FAFAF7;}',
        '.dh-msg{max-width:82%;padding:10px 13px;border-radius:12px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;}',
        '.dh-msg.bot{background:#fff;border:1px solid rgba(10,22,40,0.08);color:#1a1a1a;align-self:flex-start;border-top-left-radius:3px;}',
        '.dh-msg.user{background:#0A1628;color:#FAFAF7;align-self:flex-end;border-top-right-radius:3px;}',
        '.dh-msg.typing{color:#6b6b6b;font-style:italic;}',
        '.dh-chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 4px;}',
        '.dh-chip{font-size:12px;border:1px solid rgba(212,175,55,0.6);background:#fff;color:#0A1628;border-radius:999px;padding:7px 12px;cursor:pointer;font-family:inherit;line-height:1.2;min-height:34px;}',
        '.dh-chip:hover{background:#0A1628;color:#D4AF37;border-color:#0A1628;}',
        '.dh-open{align-self:flex-start;font-size:12.5px;font-weight:600;color:#B8941F;text-decoration:none;}',
        '.dh-open:hover{text-decoration:underline;}',
        '#dh-asst-form{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(10,22,40,0.08);background:#fff;}',
        '#dh-asst-input{flex:1;border:1px solid rgba(10,22,40,0.14);border-radius:10px;padding:10px 12px;font-size:13.5px;font-family:"Inter",sans-serif;outline:none;resize:none;max-height:80px;}',
        '#dh-asst-input:focus{border-color:#D4AF37;box-shadow:0 0 0 3px rgba(212,175,55,0.12);}',
        '#dh-asst-send{flex-shrink:0;width:44px;border:none;border-radius:10px;background:linear-gradient(135deg,#D4AF37 0%,#E8C766 100%);color:#0A1628;font-weight:700;cursor:pointer;font-size:16px;}',
        '#dh-asst-send[disabled]{opacity:.5;cursor:default;}',
        '@media(max-width:768px){#dh-asst-panel{bottom:0;right:0;left:0;width:100%;max-width:100%;height:100%;max-height:100%;border-radius:0;}#dh-asst-btn{bottom:16px;right:16px;}}'
    ].join('');
    document.head.appendChild(css);

    var root = document.createElement('div');
    root.id = 'dh-assistant-root';
    root.innerHTML =
        '<button id="dh-asst-btn" aria-label="Open help assistant">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
        '</button>' +
        '<div id="dh-asst-panel" role="dialog" aria-label="Help assistant">' +
        '  <div id="dh-asst-head"><div><div class="t">How can I help you?</div><div class="s">Dhyaan Portal Guide</div></div><button id="dh-asst-close" aria-label="Close">&times;</button></div>' +
        '  <div id="dh-asst-msgs"></div>' +
        '  <form id="dh-asst-form"><textarea id="dh-asst-input" rows="1" placeholder="Ask how to use the portal…" autocomplete="off"></textarea><button id="dh-asst-send" type="submit" aria-label="Send">&#10148;</button></form>' +
        '</div>';
    document.body.appendChild(root);

    var btn = root.querySelector('#dh-asst-btn');
    var panel = root.querySelector('#dh-asst-panel');
    var closeBtn = root.querySelector('#dh-asst-close');
    var msgs = root.querySelector('#dh-asst-msgs');
    var form = root.querySelector('#dh-asst-form');
    var input = root.querySelector('#dh-asst-input');
    var send = root.querySelector('#dh-asst-send');

    var history = [];   // client-side conversation [{role, content}]
    var greeted = false;

    function bubble(text, who) {
        var d = document.createElement('div');
        d.className = 'dh-msg ' + who;
        d.textContent = text;
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
        return d;
    }
    function addLink(path) {
        var a = document.createElement('a');
        a.className = 'dh-open'; a.href = path; a.textContent = 'Open →';
        msgs.appendChild(a); msgs.scrollTop = msgs.scrollHeight;
    }
    function renderChips(list) {
        if (!list || !list.length) return;
        var wrap = document.createElement('div');
        wrap.className = 'dh-chips';
        list.forEach(function (q) {
            var c = document.createElement('button');
            c.type = 'button'; c.className = 'dh-chip'; c.textContent = q;
            c.addEventListener('click', function () { ask(q); });
            wrap.appendChild(c);
        });
        msgs.appendChild(wrap); msgs.scrollTop = msgs.scrollHeight;
    }

    var chipsShown = false;
    function openPanel() {
        panel.classList.add('open');
        if (!greeted) {
            greeted = true;
            bubble('Hi! I can help you use the Dhyaan portal. Ask a question, or tap one below.', 'bot');
            fetch('/assistant/intro', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
                .then(function (r) { return r.json(); })
                .then(function (d) { if (!chipsShown) { renderChips((d && d.quickQuestions) || []); chipsShown = true; } })
                .catch(function () {});
        }
        setTimeout(function () { input.focus(); }, 50);
    }
    function closePanel() { panel.classList.remove('open'); }

    // Ask a question (from the input or a tapped chip). Local replies are
    // instant, so the typing indicator is delayed and normally never shows.
    function ask(text) {
        text = (text || '').trim();
        if (!text) return;
        input.value = '';
        bubble(text, 'user');
        history.push({ role: 'user', content: text });
        send.disabled = true;

        var typing = null;
        var typingTimer = setTimeout(function () { typing = bubble('…', 'bot typing'); }, 220);

        function post(retry) {
            return ensureToken().then(function () {
                return fetch('/assistant/ask', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'CSRF-Token': CSRF, 'Accept': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ messages: history.slice(-4) })
                }).then(function (r) {
                    if (r.status === 403 && !retry) { CSRF = ''; return post(true); } // stale token — refetch once
                    return r.json().catch(function () { return { reply: 'Sorry, something went wrong.' }; });
                });
            });
        }

        post(false)
            .then(function (data) {
                clearTimeout(typingTimer); if (typing) typing.remove();
                var reply = (data && data.reply) || 'Sorry, something went wrong.';
                bubble(reply, 'bot');
                if (data && data.link) addLink(data.link);
                if (data && data.suggestions) renderChips(data.suggestions);
                if (data && !data.unavailable && !data.rateLimited) history.push({ role: 'assistant', content: reply });
            })
            .catch(function () { clearTimeout(typingTimer); if (typing) typing.remove(); bubble('The assistant is unreachable right now. Please try again.', 'bot'); })
            .then(function () { send.disabled = false; input.focus(); });
    }

    btn.addEventListener('click', function () { panel.classList.contains('open') ? closePanel() : openPanel(); });
    closeBtn.addEventListener('click', closePanel);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });
})();
