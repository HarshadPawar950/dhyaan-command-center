/* =============================================================
   gallery.js — property photo slider (Launch Day).
   Vanilla, dependency-free. Arrows on desktop, swipe on phone, dots.
   Graceful: 0 images → handled in the view; 1 image → no arrows/dots.
   Markup: .pg-gallery > .pg-viewport > .pg-track > .pg-slide(img)
           (+ .pg-arrow.pg-prev/.pg-next, .pg-dots when >1 image)
   ============================================================= */
(function () {
    if (!document.getElementById('pg-gallery-css')) {
        var css = document.createElement('style');
        css.id = 'pg-gallery-css';
        css.textContent = [
            '.pg-gallery{margin:0 0 20px;}',
            '.pg-viewport{position:relative;width:100%;border-radius:14px;overflow:hidden;background:#0A1628;box-shadow:0 4px 24px rgba(10,22,40,0.10);}',
            '.pg-track{display:flex;transition:transform .3s ease;}',
            '.pg-slide{min-width:100%;}',
            '.pg-slide img{width:100%;height:420px;object-fit:cover;display:block;}',
            '.pg-arrow{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;border:none;background:rgba(255,255,255,0.88);color:#0A1628;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;box-shadow:0 2px 10px rgba(0,0,0,0.25);z-index:2;}',
            '.pg-arrow:hover{background:#fff;}',
            '.pg-prev{left:12px;}.pg-next{right:12px;}',
            '.pg-dots{position:absolute;bottom:12px;left:0;right:0;display:flex;justify-content:center;gap:6px;z-index:2;}',
            '.pg-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.55);border:none;cursor:pointer;padding:0;}',
            '.pg-dot.active{background:#D4AF37;}',
            '.pg-empty{width:100%;height:200px;border-radius:14px;border:1px dashed rgba(10,22,40,0.15);display:flex;align-items:center;justify-content:center;color:#6b6b6b;font-size:14px;background:#FAFAF7;}',
            '@media(max-width:768px){.pg-slide img{height:260px;}.pg-arrow{width:36px;height:36px;font-size:20px;}}'
        ].join('');
        document.head.appendChild(css);
    }

    var galleries = document.querySelectorAll('.pg-gallery');
    Array.prototype.forEach.call(galleries, function (g) {
        var track = g.querySelector('.pg-track');
        if (!track) return;
        var slides = track.querySelectorAll('.pg-slide');
        if (slides.length <= 1) return; // nothing to slide

        var idx = 0;
        var dotsWrap = g.querySelector('.pg-dots');
        var dots = [];
        function go(i) {
            idx = (i + slides.length) % slides.length;
            track.style.transform = 'translateX(' + (-idx * 100) + '%)';
            dots.forEach(function (d, k) { d.classList.toggle('active', k === idx); });
        }
        if (dotsWrap) {
            for (var k = 0; k < slides.length; k++) {
                (function (k) {
                    var d = document.createElement('button');
                    d.type = 'button'; d.className = 'pg-dot' + (k === 0 ? ' active' : '');
                    d.setAttribute('aria-label', 'Go to image ' + (k + 1));
                    d.addEventListener('click', function () { go(k); });
                    dotsWrap.appendChild(d); dots.push(d);
                })(k);
            }
        }
        var prev = g.querySelector('.pg-prev'), next = g.querySelector('.pg-next');
        if (prev) prev.addEventListener('click', function () { go(idx - 1); });
        if (next) next.addEventListener('click', function () { go(idx + 1); });

        // touch swipe
        var x0 = null;
        var vp = g.querySelector('.pg-viewport');
        vp.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
        vp.addEventListener('touchend', function (e) {
            if (x0 === null) return;
            var dx = e.changedTouches[0].clientX - x0;
            if (Math.abs(dx) > 40) go(idx + (dx < 0 ? 1 : -1));
            x0 = null;
        }, { passive: true });
    });
})();
