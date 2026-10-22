// Slow-drifting starfield behind the space-style dark themes. Sleeps when the tab is hidden, motion is reduced,
// or the theme has no stars.
// Per theme: area per star (bigger = fewer), brightness, share of red (or alt-coloured) stars, and star colour.
const SKIES = {
  dark: { area: 14000, glow: 1, red: 0.06 },
  refined: { area: 9000, glow: 1.1, red: 0.04 },
  midnight: { area: 30000, glow: 0.45, red: 0, tint: '170,215,255' },
  synthwave: { area: 12000, glow: 1, red: 0.3, tint: '120,230,255', alt: '255,80,180' },
};

export function startStarfield(canvas) {
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let stars = [];
  let w = 0, h = 0, raf = 0, last = 0, sky = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(160, Math.round((w * h) / sky.area));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() < 0.9 ? Math.random() * 0.9 + 0.2 : Math.random() * 1.4 + 0.9,
      v: Math.random() * 0.06 + 0.01,
      tw: Math.random() * Math.PI * 2,
      red: Math.random() < sky.red,
    }));
    draw(0);
  }

  function draw(dt) {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      s.x -= s.v * dt * 0.06;
      if (s.x < -2) { s.x = w + 2; s.y = Math.random() * h; }
      s.tw += dt * 0.0012;
      const a = (0.3 + Math.sin(s.tw) * 0.2) * sky.glow;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = s.red ? `rgba(${sky.alt || '255,92,92'},${a})` : `rgba(${sky.tint || '226,232,255'},${a})`;
      ctx.fill();
    }
  }

  function frame(t) {
    // ~24 fps is plenty for a slow drift and keeps the page light.
    if (last && t - last < 40) { raf = requestAnimationFrame(frame); return; }
    const dt = last ? Math.min(t - last, 100) : 16;
    last = t;
    draw(dt);
    raf = requestAnimationFrame(frame);
  }

  function run() {
    cancelAnimationFrame(raf);
    last = 0;
    sky = SKIES[document.documentElement.dataset.variant] || null;
    canvas.hidden = !sky;
    if (!sky) return;
    resize();
    if (!document.hidden && !reduce.matches) raf = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => { if (sky) resize(); });
  document.addEventListener('visibilitychange', run);
  reduce.addEventListener?.('change', run);
  window.addEventListener('pitwall-theme', run);
  run();
}
