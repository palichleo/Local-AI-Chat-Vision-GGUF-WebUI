/**
 * The take in progress, in its frame (capture 13; direction-artistique.md, « En cours »): the « Flux »
 * of the maquette (claude_design/maquettes/flux-demo.js). Thousands of points follow a field and take
 * their colours from the picture so far, over that picture blurred; they slow down and the picture
 * comes forward as the take nears its end. No pixel is read (no getImageData): the colours come from
 * the picture by composition (source-in).
 * - 12 images a second at most: measured in 560 × 315, 0.6 % of the GPU and 9 % of one core, against
 *   7.5 % and 58 to 98 % at the 100 of the demo. The interface takes almost nothing from a generation.
 * - Nothing is drawn while the frame is out of view (`visible(false)`), the page hidden (no animation
 *   frame) or the motion frozen (`data-motion="fige"`); with reduced motion, the picture blurred alone.
 * - The blurred copies of a picture are made once, when it arrives, not at each image.
 * `source(picture or address)`: the picture so far (the start image until the first preview);
 * `neutral()`: before any picture, a dark field lit by the accent and the ivory of the room (the
 * moving background of before cost 3.5 to 8 % of the GPU at 100 images a second, against 1.4 % here);
 * `progress(fraction)`; `visible(boolean)`; `stop()`, the take being there or the generation stopped.
 */
const LEVELS = [0, 2.5, 6, 11, 18, 28];
const DARK = '#0E0D11';

function hash(i, j, k) {
  const h = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    xf = x - xi,
    yf = y - yi,
    u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, 0),
    b = hash(xi + 1, yi, 0),
    c = hash(xi, yi + 1, 0),
    d = hash(xi + 1, yi + 1, 0);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const smooth = p => p * p * (3 - 2 * p);

export function takeFlux(frame, { node, fps = 12, win = globalThis.window } = {}) {
  const canvas = node('canvas', 'take-flux');
  // Without a page that draws (the tests): nothing to show.
  if (typeof canvas.getContext !== 'function' || !win?.document)
    return { source() {}, neutral() {}, progress() {}, visible() {}, stop() {} };
  const doc = win.document;
  canvas.setAttribute('aria-hidden', 'true');
  const still = () =>
    Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ||
    doc.documentElement.dataset.motion === 'fige';
  let picture = null,
    fraction = 0,
    shown = true,
    stopped = false,
    timer = 0,
    pending = 0,
    last = 0,
    loading = null;
  const start = win.performance.now() / 1000,
    st = { W: 0, H: 0, dpr: 1, lv: null, fresh: false, data: {} };

  function make(w, h) {
    const made = doc.createElement('canvas');
    made.width = Math.max(1, w);
    made.height = Math.max(1, h);
    return made;
  }
  // The picture covering the frame, a little larger, as in the demo.
  function cover(x, im, w, h) {
    const iw = im.naturalWidth || im.width,
      ih = im.naturalHeight || im.height,
      s = Math.max(w / iw, h / ih) * 1.08,
      dw = iw * s,
      dh = ih * s;
    x.drawImage(im, (w - dw) * 0.6, (h - dh) * 0.3, dw, dh);
  }
  function levels() {
    st.lv = LEVELS.map(blur => {
      const level = make(st.W, st.H),
        x = level.getContext('2d');
      x.fillStyle = DARK;
      x.fillRect(0, 0, st.W, st.H);
      if (blur) x.filter = `blur(${(blur * st.dpr).toFixed(1)}px)`;
      cover(x, picture, st.W, st.H);
      return level;
    });
  }
  function blurAt(x, blur) {
    let i = 0;
    while (i < LEVELS.length - 2 && LEVELS[i + 1] < blur) i++;
    const f = Math.max(0, Math.min(1, (blur - LEVELS[i]) / (LEVELS[i + 1] - LEVELS[i]))),
      alpha = x.globalAlpha;
    x.drawImage(st.lv[i], 0, 0);
    if (f > 0) {
      x.globalAlpha = alpha * f;
      x.drawImage(st.lv[i + 1], 0, 0);
      x.globalAlpha = alpha;
    }
  }
  function nearest(x, blur) {
    let best = 0;
    LEVELS.forEach((level, k) => {
      if (Math.abs(level - blur) < Math.abs(LEVELS[best] - blur)) best = k;
    });
    x.drawImage(st.lv[best], 0, 0);
  }
  // The points move along a curl field (no sink: they do not gather into a few threads); each draws
  // the segment it ran since the last image, so that a trail stays whole at 12 images a second.
  function flux(x, p, t, dt) {
    const { W, H, dpr } = st,
      d = st.data,
      e = smooth(p);
    if (!d.trails) {
      d.trails = make(W, H);
      d.tinted = make(W, H);
      const count = Math.round((W * H) / (dpr * dpr) / 75);
      d.points = new Float32Array(count * 2);
      for (let k = 0; k < count; k++) {
        d.points[2 * k] = Math.random() * W;
        d.points[2 * k + 1] = Math.random() * H;
      }
    }
    const trails = d.trails.getContext('2d'),
      points = d.points;
    // The trails fade as they would at 60 images a second, whatever the rate.
    trails.globalCompositeOperation = 'destination-out';
    trails.fillStyle = `rgba(0,0,0,${(1 - Math.pow(1 - (0.07 + 0.12 * e), dt * 60)).toFixed(3)})`;
    trails.fillRect(0, 0, W, H);
    trails.globalCompositeOperation = 'source-over';
    trails.strokeStyle = '#fff';
    trails.lineWidth = (1.1 + 1.2 * e) * dpr;
    const scale = 0.006 / dpr,
      speed = (1.7 - 1.25 * e) * dpr * 60 * dt,
      ep = 0.6,
      tz = t * 0.06;
    trails.beginPath();
    for (let q = 0; q < points.length / 2; q++) {
      const px = points[2 * q],
        py = points[2 * q + 1];
      if (Math.random() < 0.004) {
        points[2 * q] = Math.random() * W;
        points[2 * q + 1] = Math.random() * H;
        continue;
      }
      const u = px * scale,
        v = py * scale,
        dny = vnoise(u + tz, v + ep + tz) - vnoise(u + tz, v - ep + tz),
        dnx = vnoise(u + ep + tz, v + tz) - vnoise(u - ep + tz, v + tz),
        length = Math.hypot(dny, dnx) || 1;
      let nx = px + (dny / length) * speed,
        ny = py - (dnx / length) * speed;
      const out = nx < 0 || nx >= W || ny < 0 || ny >= H;
      if (nx < 0) nx += W;
      else if (nx >= W) nx -= W;
      if (ny < 0) ny += H;
      else if (ny >= H) ny -= H;
      if (!out) {
        trails.moveTo(px, py);
        trails.lineTo(nx, ny);
      }
      points[2 * q] = nx;
      points[2 * q + 1] = ny;
    }
    trails.stroke();
    // The trails in the colours of the picture, over the picture blurred.
    const tinted = d.tinted.getContext('2d');
    tinted.globalCompositeOperation = 'source-over';
    tinted.clearRect(0, 0, W, H);
    tinted.drawImage(d.trails, 0, 0);
    tinted.globalCompositeOperation = 'source-in';
    nearest(tinted, 6 * (1 - p));
    tinted.globalCompositeOperation = 'source-over';
    x.globalAlpha = 0.08 + 0.45 * e * e;
    blurAt(x, 20 * (1 - e) + 2);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'screen';
    x.drawImage(d.tinted, 0, 0);
    x.globalCompositeOperation = 'source-over';
  }
  function draw(now) {
    pending = 0;
    if (stopped || !picture) return;
    const dpr = Math.min(2, win.devicePixelRatio || 1),
      W = Math.round(canvas.clientWidth * dpr),
      H = Math.round(canvas.clientHeight * dpr);
    if (W && H) {
      if (st.W !== W || st.H !== H) {
        canvas.width = W;
        canvas.height = H;
        Object.assign(st, { W, H, dpr, fresh: true, data: {} });
      }
      if (st.fresh) {
        levels();
        st.fresh = false;
      }
      const t = now / 1000,
        dt = last ? Math.min(0.1, Math.max(0, t - last)) : 1 / fps,
        p = Math.min(1, Math.max(0, fraction)),
        x = canvas.getContext('2d');
      last = t;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalCompositeOperation = 'source-over';
      x.globalAlpha = 1;
      x.filter = 'none';
      x.fillStyle = DARK;
      x.fillRect(0, 0, W, H);
      // Still: the picture blurred as half way, without points.
      if (still()) blurAt(x, 8);
      else flux(x, p, t - start, dt);
      // Near its end, the picture comes forward.
      if (p > 0.9) {
        x.globalAlpha = smooth(Math.min(1, (p - 0.9) / 0.1));
        x.drawImage(st.lv[0], 0, 0);
        x.globalAlpha = 1;
      }
    }
    if (!still()) schedule();
  }
  function schedule() {
    if (stopped || !shown || !picture || timer || pending) return;
    timer = win.setTimeout(() => {
      timer = 0;
      pending = win.requestAnimationFrame(draw);
    }, 1000 / fps);
  }
  function now() {
    if (stopped || !shown || pending) return;
    win.clearTimeout(timer);
    timer = 0;
    pending = win.requestAnimationFrame(draw);
  }
  function use(image) {
    if (stopped || !(image.naturalWidth || image.width)) return;
    picture = image;
    st.fresh = true;
    if (canvas.parentNode !== frame) frame.append(canvas);
    frame.classList.add('has-flux');
    now();
  }
  return {
    source(given) {
      if (stopped || !given) return;
      if (typeof given !== 'string') {
        if (given.complete && given.naturalWidth) use(given);
        return;
      }
      const image = new win.Image();
      image.decoding = 'async';
      loading = image;
      image.onload = () => {
        // A later picture came first: this one is old.
        if (loading === image) use(image);
      };
      image.src = given;
    },
    neutral() {
      if (stopped || picture) return;
      const field = make(320, 180),
        x = field.getContext('2d');
      let accent = '#d0cadd';
      try {
        accent = win.getComputedStyle(frame).getPropertyValue('--accent').trim() || accent;
      } catch {
        // A frame outside the page: the accent of the dark room.
      }
      x.fillStyle = DARK;
      x.fillRect(0, 0, 320, 180);
      for (const [cx, cy, radius, colour, alpha] of [
        [96, 64, 170, accent, 0.5],
        [236, 124, 140, '#eee8de', 0.3],
        [180, 30, 110, '#c8925a', 0.22],
      ]) {
        const glow = x.createRadialGradient(cx, cy, 0, cx, cy, radius);
        try {
          glow.addColorStop(0, colour);
        } catch {
          glow.addColorStop(0, '#d0cadd');
        }
        glow.addColorStop(1, 'rgba(14, 13, 17, 0)');
        x.globalAlpha = alpha;
        x.fillStyle = glow;
        x.fillRect(0, 0, 320, 180);
      }
      x.globalAlpha = 1;
      use(field);
    },
    progress(value) {
      if (!Number.isFinite(value)) return;
      fraction = value;
      // Still, or the motion just allowed again: one image now (the loop goes on by itself if it may).
      if (!timer && !pending) now();
    },
    visible(value) {
      shown = Boolean(value);
      if (!shown) {
        win.clearTimeout(timer);
        win.cancelAnimationFrame(pending);
        timer = pending = 0;
        last = 0;
      } else now();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      win.clearTimeout(timer);
      win.cancelAnimationFrame(pending);
      timer = pending = 0;
      loading = null;
      canvas.remove();
      frame.classList.remove('has-flux');
      st.lv = null;
      st.data = {};
    },
  };
}
