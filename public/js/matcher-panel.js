/* =============================================================
   matcher-panel.js — "Suggested Properties" panel (AI Day, Feature 1)
   Self-contained: injects its own navy/gold CSS, wires the "Find Matches"
   button, fetches the deterministic matches, renders top-5 cards with score
   + reason chips + a one-click Cost Sheet link. Responsive from birth.
   Expects a container: <div class="match-panel" data-matches-url="..."
     [data-cost-base="/admin/cost-sheet"]>...<button data-find>...
     <div data-results></div></div>
   ============================================================= */
(function () {
    var panel = document.querySelector('.match-panel[data-matches-url]');
    if (!panel) return;

    // ---- one-time CSS ----
    if (!document.getElementById('match-panel-css')) {
        var css = document.createElement('style');
        css.id = 'match-panel-css';
        css.textContent = [
            '.match-panel{background:#fff;border:1px solid rgba(10,22,40,0.08);border-top:3px solid #D4AF37;border-radius:14px;padding:20px;box-shadow:0 4px 24px rgba(10,22,40,0.06);margin-top:24px;}',
            '.match-panel .mp-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px;}',
            '.match-panel .mp-head h3{font-family:"Playfair Display",serif;color:#0A1628;font-size:1.2rem;margin:0;}',
            '.match-panel .mp-sub{font-size:12px;color:#6b6b6b;margin-bottom:14px;}',
            '.match-panel .mp-btn{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:10px 20px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;border:1px solid #D4AF37;background:linear-gradient(135deg,#D4AF37 0%,#E8C766 100%);color:#0A1628;font-family:"Inter",sans-serif;}',
            '.match-panel .mp-btn[disabled]{opacity:.6;cursor:default;}',
            '.match-panel .mp-banner{background:rgba(217,119,6,0.12);color:#b8941f;border-radius:8px;padding:10px 12px;font-size:12.5px;margin-bottom:12px;}',
            '.match-panel .mp-skip{font-size:12px;color:#6b6b6b;margin-top:10px;}',
            '.match-panel .mp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;}',
            '.match-panel .mp-card{border:1px solid rgba(10,22,40,0.08);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;background:#FAFAF7;}',
            '.match-panel .mp-card .mp-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}',
            '.match-panel .mp-card .mp-title{font-weight:700;color:#0A1628;font-size:14px;line-height:1.25;}',
            '.match-panel .mp-card .mp-meta{font-size:12px;color:#6b6b6b;}',
            '.match-panel .mp-kind{display:inline-block;font-size:9px;font-weight:700;letter-spacing:.4px;padding:2px 7px;border-radius:5px;margin-bottom:4px;text-transform:uppercase;}',
            '.match-panel .mp-kind.k-unit{background:rgba(22,163,74,0.14);color:#16a34a;}',
            '.match-panel .mp-kind.k-project{background:rgba(184,148,31,0.16);color:#B8941F;}',
            '.match-panel .mp-card .mp-price{font-family:"Playfair Display",serif;color:#0A1628;font-weight:700;font-size:15px;}',
            '.match-panel .mp-score{flex-shrink:0;width:52px;height:52px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:700;color:#fff;line-height:1;}',
            '.match-panel .mp-score small{font-size:8px;font-weight:600;opacity:.85;}',
            '.match-panel .mp-chips{display:flex;flex-wrap:wrap;gap:5px;}',
            '.match-panel .mp-chip{font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:999px;background:rgba(22,163,74,0.12);color:#16a34a;}',
            '.match-panel .mp-cost{margin-top:2px;text-align:center;font-size:12px;font-weight:600;color:#0A1628;border:1px solid rgba(10,22,40,0.12);border-radius:8px;padding:9px;text-decoration:none;min-height:40px;display:flex;align-items:center;justify-content:center;}',
            '.match-panel .mp-cost:hover{background:#0A1628;color:#D4AF37;}',
            '.match-panel .mp-empty{color:#6b6b6b;font-size:13px;padding:8px 0;}',
            '@media(max-width:768px){.match-panel .mp-grid{grid-template-columns:1fr;}}'
        ].join('');
        document.head.appendChild(css);
    }

    var url = panel.getAttribute('data-matches-url');
    var costBase = panel.getAttribute('data-cost-base');
    var btn = panel.querySelector('[data-find]');
    var out = panel.querySelector('[data-results]');

    function fmtPrice(lakhs) {
        if (lakhs === null || lakhs === undefined) return '—';
        if (lakhs >= 100) return '₹' + (lakhs / 100).toFixed(2).replace(/\.00$/, '') + ' Cr';
        return '₹' + Math.round(lakhs) + ' L';
    }
    function scoreColor(s) {
        if (s >= 75) return '#16a34a';
        if (s >= 50) return '#B8941F';
        return '#6b6b6b';
    }
    function esc(x) {
        return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function render(data) {
        var html = '';
        if (data.banner) html += '<div class="mp-banner">' + esc(data.banner) + '</div>';
        if (!data.results || !data.results.length) {
            // Explicit empty-state (never a blank panel): distinguish "nothing to score
            // yet" from "we scored inventory but none cleared the match floor".
            var emptyMsg = (data.totalScored > 0)
                ? 'No properties match this lead’s requirements.'
                : 'No scorable properties for this lead’s requirements yet.';
            html += '<div class="mp-empty">' + emptyMsg + '</div>';
        } else {
            html += '<div class="mp-grid">';
            data.results.forEach(function (r) {
                var kindClass = r.kind === 'project' ? 'k-project' : 'k-unit';
                var kindLabel = r.kind === 'project' ? 'Project · range' : 'Unit · exact';
                html += '<div class="mp-card">';
                html += '<div class="mp-top"><div>' +
                        '<span class="mp-kind ' + kindClass + '">' + kindLabel + '</span>' +
                        '<div class="mp-title">' + esc(r.title) + '</div>' +
                        '<div class="mp-meta">' + esc(r.config) + (r.location ? ' · ' + esc(r.location) : '') + '</div></div>' +
                        '<div class="mp-score" style="background:' + scoreColor(r.score) + '">' + r.score + '<small>/100</small></div></div>';
                html += '<div class="mp-price">' + (r.price_lakhs != null ? fmtPrice(r.price_lakhs) : esc(r.price_display || '—')) + '</div>';
                if (r.reasons && r.reasons.length) {
                    html += '<div class="mp-chips">';
                    r.reasons.forEach(function (c) { html += '<span class="mp-chip">' + esc(c.t) + '</span>'; });
                    html += '</div>';
                }
                if (costBase && r.project_id) {
                    html += '<a class="mp-cost" href="' + costBase + '?project_id=' + encodeURIComponent(r.project_id) + '">Generate Cost Sheet →</a>';
                }
                html += '</div>';
            });
            html += '</div>';
        }
        var scored = (data.totalScored || 0);
        var skipped = (data.skippedCount || 0);
        html += '<div class="mp-skip">Scored ' + scored + ' item' + (scored === 1 ? '' : 's') +
                (skipped ? ' · <strong>' + skipped + ' skipped — incomplete data</strong>' : '') + '.</div>';
        out.innerHTML = html;
    }

    btn.addEventListener('click', function () {
        btn.disabled = true;
        var label = btn.textContent;
        btn.textContent = 'Finding…';
        out.innerHTML = '';
        fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
            .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
            .then(render)
            .catch(function () { out.innerHTML = '<div class="mp-empty">Could not load matches right now. Please try again.</div>'; })
            .then(function () { btn.disabled = false; btn.textContent = label; });
    });
})();
