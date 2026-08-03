// ═════════════════════════════════════════════════════════════
// The sea — procedural, scrolling, and the whole reason the game
// reads as "endless runner" instead of "objects fall down a wall".
//
// Wave crests are spawned at the horizon and swept toward the
// camera, slow and short up top, fast and long at the bottom. That
// single perspective ramp is what sells forward motion; the boat
// never actually moves up the screen.
//
// Storm level rises with the tier: the water darkens, rain comes in,
// and lightning starts cracking behind the pirates.
// ═════════════════════════════════════════════════════════════

interface Crest {
  x: number;
  y: number;
  len: number;
  seed: number;
}

interface Rain {
  x: number;
  y: number;
  len: number;
  v: number;
}

/** Fraction of the canvas height taken by sky above the waterline. */
export const HORIZON = 0.13;

export class Sea {
  private crests: Crest[] = [];
  private rain: Rain[] = [];
  private t = 0;
  private storm = 0;
  private flash = 0;
  private nextFlashAt = 6000;
  /** Sideways current in px/s — drawn as slanted foam so it's readable. */
  private current = 0;

  setStorm(level: number): void {
    this.storm = Math.max(0, Math.min(1, level));
  }

  setCurrent(px: number): void {
    this.current = px;
  }

  update(dt: number, scroll: number, w: number, h: number): void {
    this.t += dt;
    const horizonY = h * HORIZON;
    const span = Math.max(1, h - horizonY);

    // Keep a population proportional to the area; spawn at the horizon.
    const want = Math.round(70 + w / 12);
    while (this.crests.length < want) {
      this.crests.push({
        x: Math.random() * w,
        y: horizonY + Math.random() * span,
        len: 0,
        seed: Math.random() * 1000,
      });
    }

    for (const c of this.crests) {
      const p = (c.y - horizonY) / span; // 0 at horizon → 1 at the hull
      c.y += scroll * (0.14 + p * p * 1.5) * dt;
      c.x -= this.current * (0.2 + p) * dt * 0.6;
      c.len = 6 + p * 64;
      if (c.y > h + 20) {
        c.y = horizonY + Math.random() * 8;
        c.x = Math.random() * w;
      }
      if (c.x < -60) c.x += w + 120;
      if (c.x > w + 60) c.x -= w + 120;
    }

    // Rain only above a storm threshold; density scales with it.
    if (this.storm > 0.15) {
      const wantRain = Math.round(this.storm * 160);
      while (this.rain.length < wantRain) {
        this.rain.push({
          x: Math.random() * (w + 200) - 100,
          y: Math.random() * h,
          len: 14 + Math.random() * 26,
          v: 900 + Math.random() * 700,
        });
      }
      while (this.rain.length > wantRain) this.rain.pop();
      for (const r of this.rain) {
        r.y += r.v * dt;
        r.x += r.v * dt * 0.22;
        if (r.y > h) {
          r.y = -20;
          r.x = Math.random() * (w + 200) - 100;
        }
      }
      // Lightning, occasionally, harder in a heavy storm.
      this.nextFlashAt -= dt * 1000 * (0.4 + this.storm);
      if (this.nextFlashAt <= 0) {
        this.flash = 1;
        this.nextFlashAt = 4000 + Math.random() * 9000;
      }
    } else {
      this.rain.length = 0;
    }
    this.flash = Math.max(0, this.flash - dt * 2.4);
  }

  render(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const horizonY = h * HORIZON;
    const storm = this.storm;

    // ── Sky ──
    const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, mix('#f5a15a', '#2b2140', storm));
    sky.addColorStop(0.55, mix('#f7c877', '#3b2f52', storm));
    sky.addColorStop(1, mix('#ffe3a8', '#5d5470', storm));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizonY + 1);

    // Sun (or the pale disc behind the storm).
    const sunX = w * 0.5 + Math.sin(this.t * 0.05) * w * 0.04;
    const sunR = h * 0.07;
    const sunG = ctx.createRadialGradient(sunX, horizonY, 0, sunX, horizonY, sunR * 2.4);
    sunG.addColorStop(0, `rgba(255,240,190,${0.95 - storm * 0.55})`);
    sunG.addColorStop(0.45, `rgba(255,190,90,${0.5 - storm * 0.3})`);
    sunG.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = sunG;
    ctx.beginPath();
    ctx.arc(sunX, horizonY, sunR * 2.4, 0, Math.PI * 2);
    ctx.fill();

    // ── Water ──
    const water = ctx.createLinearGradient(0, horizonY, 0, h);
    water.addColorStop(0, mix('#2b9ec2', '#1b4a63', storm));
    water.addColorStop(0.35, mix('#1f7ba6', '#143a52', storm));
    water.addColorStop(1, mix('#0d3f61', '#08202f', storm));
    ctx.fillStyle = water;
    ctx.fillRect(0, horizonY, w, h - horizonY);

    // Sun glitter path down the middle of the water.
    if (storm < 0.85) {
      ctx.save();
      ctx.globalAlpha = 0.22 - storm * 0.22;
      const glit = ctx.createLinearGradient(0, horizonY, 0, h);
      glit.addColorStop(0, 'rgba(255,225,160,0.7)');
      glit.addColorStop(0.55, 'rgba(255,205,130,0.25)');
      glit.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = glit;
      ctx.beginPath();
      ctx.moveTo(sunX - w * 0.04, horizonY);
      ctx.lineTo(sunX + w * 0.04, horizonY);
      ctx.lineTo(sunX + w * 0.42, h);
      ctx.lineTo(sunX - w * 0.42, h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Horizon line.
    ctx.strokeStyle = `rgba(255,255,255,${0.35 - storm * 0.2})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    ctx.lineTo(w, horizonY);
    ctx.stroke();

    // ── Crests ──
    const span = Math.max(1, h - horizonY);
    ctx.lineCap = 'round';
    for (const c of this.crests) {
      const p = (c.y - horizonY) / span;
      const wob = Math.sin(this.t * 2 + c.seed) * (2 + p * 5);
      ctx.strokeStyle = `rgba(${210 + p * 45},${238 + p * 17},255,${0.13 + p * 0.42})`;
      ctx.lineWidth = 1 + p * 3.2;
      ctx.beginPath();
      ctx.moveTo(c.x - c.len / 2, c.y + wob * 0.2);
      ctx.quadraticCurveTo(c.x, c.y - 3 - p * 5 + wob, c.x + c.len / 2, c.y + wob * 0.2);
      ctx.stroke();
    }

    // ── Current streaks ──
    if (Math.abs(this.current) > 6) {
      const dir = Math.sign(this.current);
      ctx.strokeStyle = 'rgba(180,240,255,0.30)';
      ctx.lineWidth = 3;
      for (let i = 0; i < 7; i++) {
        const y = horizonY + span * (0.25 + i * 0.11);
        const phase = ((this.t * this.current * 0.35 + i * 90) % (w + 260)) - 130;
        const x = dir > 0 ? phase : w - phase;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 46 * dir, y);
        ctx.lineTo(x + 30 * dir, y - 8);
        ctx.moveTo(x + 46 * dir, y);
        ctx.lineTo(x + 30 * dir, y + 8);
        ctx.stroke();
      }
    }

    // ── Weather on top ──
    if (storm > 0.15) {
      ctx.strokeStyle = `rgba(190,225,245,${0.18 + storm * 0.22})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const r of this.rain) {
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x - r.len * 0.22, r.y - r.len);
      }
      ctx.stroke();
    }
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(214,232,255,${this.flash * 0.4})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  /** Foam wake trailing the hull — drawn under the boat. */
  wake(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, speed: number): void {
    const len = h - y;
    if (len <= 0) return;
    ctx.save();
    const g = ctx.createLinearGradient(0, y, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.34, y);
    ctx.lineTo(x + w * 0.34, y);
    ctx.lineTo(x + w * 0.34 + len * 0.30, h);
    ctx.lineTo(x - w * 0.34 - len * 0.30, h);
    ctx.closePath();
    ctx.fill();
    // Churn bubbles right behind the transom.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (let i = 0; i < 9; i++) {
      const t = (this.t * (1.4 + speed / 700) + i * 0.37) % 1;
      const yy = y + t * len * 0.5;
      const rr = (1 - t) * w * 0.10 + 1.5;
      const off = Math.sin(i * 2.1 + this.t * 3) * w * 0.22 * t;
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.beginPath();
      ctx.arc(x + off, yy, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Blend two #rrggbb colours, t=0 → a, t=1 → b. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `rgb(${r},${g},${bl})`;
}
