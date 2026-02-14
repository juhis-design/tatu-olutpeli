const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

// =====================
// Resize
// =====================
let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  W = canvas.width;
  H = canvas.height;
}
window.addEventListener("resize", resize);
resize();

// =====================
// Settings
// =====================
const START_LIVES = 3;
const CHEER_MS = 600;

const GRACE_SEC = 10;
const BELLY_SCORE = 50;
const FULL_SCALE_SCORE = 120;

const LEVEL_EVERY = 20;
const SPAWN_START = 1.20;
const SPAWN_MIN = 0.45;
const SPEED_START = 0.28;
const SPEED_MAX = 0.95;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function getLevel(score) { return 1 + Math.floor(score / LEVEL_EVERY); }

function pickType(tSec) {
  if (tSec < GRACE_SEC) {
    const r = Math.random();
    if (r < 0.70) return "normal";
    if (r < 0.90) return "bonus";
    return "big";
  }
  const r = Math.random();
  if (r < 0.15) return "bomb";
  if (r < 0.25) return "big";
  if (r < 0.40) return "bonus";
  return "normal";
}

// =====================
// WebAudio SFX (louder + nicer)
// =====================
let audioCtx = null;
let audioEnabled = false;
let masterGain = null;

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = AC ? new AC() : null;
    if (audioCtx) {
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1.0; // master volume
      masterGain.connect(audioCtx.destination);
    }
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  audioEnabled = !!audioCtx;
}

function playTone({ type="sine", f=440, fEnd=null, dur=0.10, gain=0.2, attack=0.01, release=0.08 }) {
  if (!audioEnabled || !audioCtx) return;

  const t0 = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  if (fEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, fEnd), t0 + dur);

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(attack + 0.01, release));

  // tiny lowpass to soften harsh edges
  const lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(5000, t0);

  osc.connect(lp);
  lp.connect(g);
  g.connect(masterGain);

  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function playNoise({ dur=0.20, gain=0.25, lpStart=1200, lpEnd=200 }) {
  if (!audioEnabled || !audioCtx) return;

  const t0 = audioCtx.currentTime;
  const bufferSize = Math.floor(audioCtx.sampleRate * dur);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  // low-ish colored noise
  let last = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    last = (last * 0.94) + (white * 0.06);
    data[i] = last;
  }

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;

  const lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(lpStart, t0);
  lp.frequency.exponentialRampToValueAtTime(Math.max(60, lpEnd), t0 + dur);

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(lp);
  lp.connect(g);
  g.connect(masterGain);

  src.start(t0);
  src.stop(t0 + dur);
}

function sfxNormal() {
  // short "tick"
  playTone({ type:"triangle", f:650, fEnd:520, dur:0.055, gain:0.18, attack:0.008, release:0.06 });
}

function sfxBonus() {
  // "bling-bling": two tones
  playTone({ type:"sine", f:1040, fEnd:1500, dur:0.10, gain:0.22, attack:0.01, release:0.12 });
  setTimeout(() => playTone({ type:"sine", f:1560, fEnd:2100, dur:0.08, gain:0.18, attack:0.008, release:0.10 }), 60);
}

function sfxBig() {
  // lower, thicker bling
  playTone({ type:"sine", f:620, fEnd:880, dur:0.11, gain:0.22, attack:0.01, release:0.14 });
  setTimeout(() => playTone({ type:"sine", f:880, fEnd:1100, dur:0.08, gain:0.16, attack:0.008, release:0.10 }), 70);
}

function sfxBomb() {
  // thump + noise crackle
  playTone({ type:"sine", f:120, fEnd:55, dur:0.14, gain:0.28, attack:0.005, release:0.16 });
  playNoise({ dur:0.22, gain:0.32, lpStart:1500, lpEnd:180 });
}

function sfxGameOver() {
  playTone({ type:"sine", f:220, fEnd:110, dur:0.28, gain:0.22, attack:0.01, release:0.30 });
}

// =====================
// State
// =====================
let score = 0;
let lives = START_LIVES;
let gameOver = false;
let started = false;

let isCheering = false;
let cheerLeftMs = 0;

let slowLeft = 0;
let shakeLeft = 0;
let shakeAmp = 0;

let tSec = 0;
let spawnAcc = 0;

const player = {
  xN: 0.5,
  baseYN: 0.86,
  w: 0,
  h: 0
};
let bounceT = 0;

// UI effects
const pops = [];
const sparks = [];

// =====================
// Images
// =====================
const playerImg = {
  leanFlex: new Image(),
  leanCheer: new Image(),
  bellyFlex: new Image(),
  bellyCheer: new Image(),
};
playerImg.leanFlex.src  = "player/player_lean_flex.png";
playerImg.leanCheer.src = "player/player_lean_cheer.png";
playerImg.bellyFlex.src = "player/player_beerbelly_flex.png";
playerImg.bellyCheer.src= "player/player_beerbelly_cheer.png";

const itemImg = {
  normal: new Image(),
  bonus: new Image(),
  big: new Image(),
  bomb: new Image(),
};
itemImg.normal.src = "items/bottle_normal.png";
itemImg.bonus.src  = "items/bottle_bonus.png";
itemImg.big.src    = "items/bottle_big.png";
itemImg.bomb.src   = "items/bomb.png";

let loaded = 0;
const ALL_IMAGES = { ...playerImg, ...itemImg };
const totalToLoad = Object.keys(ALL_IMAGES).length;

for (const k in ALL_IMAGES) {
  ALL_IMAGES[k].onload = () => {
    loaded++;
    if (loaded === totalToLoad) initPlayerSize();
  };
}

function initPlayerSize() {
  const targetH = H * 0.38;
  const scale = targetH / playerImg.leanFlex.height;
  player.h = targetH;
  player.w = playerImg.leanFlex.width * scale;
}

// =====================
// Input
// =====================
function setPlayerXFromClient(clientX) {
  const rect = canvas.getBoundingClientRect();
  const nx = (clientX - rect.left) / rect.width;
  const halfWn = (player.w / W) / 2;
  player.xN = Math.max(halfWn, Math.min(1 - halfWn, nx));
}

window.addEventListener("mousemove", (e) => {
  if (loaded < totalToLoad) return;
  ensureAudio();
  setPlayerXFromClient(e.clientX);
  if (!started && !gameOver) started = true;
});

canvas.addEventListener("pointerdown", (e) => {
  ensureAudio();
  if (e.pointerType === "touch") {
    canvas.setPointerCapture(e.pointerId);
    setPlayerXFromClient(e.clientX);
  }
  if (gameOver) restart();
  else if (!started) started = true;
});
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") {
    ensureAudio();
    setPlayerXFromClient(e.clientX);
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (e.pointerType === "touch") {
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  }
});

// =====================
// Items
// =====================
const items = [];

function spawnItem() {
  const type = pickType(tSec);

  const level = getLevel(score);
  const speedNow = Math.min(SPEED_MAX, SPEED_START + (level - 1) * 0.06 + tSec * 0.002);

  const base = {
    normal: { vMul: 1.00, scale: 1.00 },
    bonus:  { vMul: 0.92, scale: 1.00 },
    big:    { vMul: 1.10, scale: 1.10 },
    bomb:   { vMul: 1.06, scale: 1.05 },
  }[type];

  const hit = (type === "bomb")
    ? { w: 0.55, h: 0.55 }
    : { w: 0.45, h: 0.60 };

  items.push({
    type,
    xN: Math.random() * 0.86 + 0.07,
    yN: -0.12,
    vYN: speedNow * base.vMul,
    rot: (Math.random() * 2 - 1) * 0.8,
    rV:  (Math.random() * 2 - 1) * 2.6,
    swayPhase: Math.random() * Math.PI * 2,
    scale: base.scale,
    hitW: hit.w,
    hitH: hit.h,
  });
}

function restart() {
  score = 0;
  lives = START_LIVES;
  gameOver = false;
  started = false;

  isCheering = false;
  cheerLeftMs = 0;

  slowLeft = 0;
  shakeLeft = 0;
  shakeAmp = 0;

  tSec = 0;
  spawnAcc = 0;
  items.length = 0;
  pops.length = 0;
  sparks.length = 0;
  bounceT = 0;
}

// =====================
// Effects helpers
// =====================
function triggerCheer() {
  isCheering = true;
  cheerLeftMs = CHEER_MS;
}
function triggerBombHit() {
  slowLeft = Math.max(slowLeft, 0.22);
  shakeLeft = Math.max(shakeLeft, 0.28);
  shakeAmp = Math.max(shakeAmp, 16 * dpr);
}
function getShakeOffset() {
  if (shakeLeft <= 0) return { sx: 0, sy: 0 };
  return {
    sx: (Math.random() * 2 - 1) * shakeAmp,
    sy: (Math.random() * 2 - 1) * shakeAmp,
  };
}
function addPop(x, y, text) {
  pops.push({ x, y, text, life: 0.9 });
}
function spawnSparks(x, y, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (120 + Math.random() * 220) * dpr;
    sparks.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.35 + Math.random() * 0.25
    });
  }
}

// =====================
// Collision helper
// =====================
function aabbHit(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// =====================
// Background
// =====================
function drawBackground(sx, sy) {
  const horizonY = H * 0.62;
  const sandY = H * 0.78;

  const skyGrad = ctx.createLinearGradient(0, -sy, 0, horizonY - sy);
  skyGrad.addColorStop(0, "#5ecbff");
  skyGrad.addColorStop(1, "#bff0ff");
  ctx.fillStyle = skyGrad;
  ctx.fillRect(-sx, -sy, W, horizonY);

  const sunX = W * 0.18;
  const sunY = horizonY * 0.28;
  const sunR = 110 * dpr;
  const sunGlow = ctx.createRadialGradient(sunX - sx, sunY - sy, 0, sunX - sx, sunY - sy, sunR);
  sunGlow.addColorStop(0, "rgba(255,245,210,0.75)");
  sunGlow.addColorStop(1, "rgba(255,245,210,0)");
  ctx.fillStyle = sunGlow;
  ctx.beginPath();
  ctx.arc(sunX - sx, sunY - sy, sunR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,240,0.9)";
  ctx.beginPath();
  ctx.arc(sunX - sx, sunY - sy, 28 * dpr, 0, Math.PI * 2);
  ctx.fill();

  function cloud(cx, cy, s, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.ellipse(cx, cy, 40*s, 18*s, 0, 0, Math.PI*2);
    ctx.ellipse(cx + 30*s, cy + 2*s, 34*s, 15*s, 0, 0, Math.PI*2);
    ctx.ellipse(cx - 30*s, cy + 4*s, 32*s, 14*s, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
  const drift1 = (tSec * 18 * dpr) % (W + 320 * dpr);
  const drift2 = (tSec * 10 * dpr) % (W + 320 * dpr);
  cloud(W - drift1 - sx, horizonY*0.25 - sy, 1.2*dpr, 0.45);
  cloud(W*0.55 - drift1*0.7 - sx, horizonY*0.18 - sy, 0.9*dpr, 0.35);
  cloud(W*0.30 - drift2 - sx, horizonY*0.32 - sy, 1.0*dpr, 0.30);

  const seaGrad = ctx.createLinearGradient(0, horizonY - sy, 0, sandY - sy);
  seaGrad.addColorStop(0, "#1976d2");
  seaGrad.addColorStop(1, "#0f5fa8");
  ctx.fillStyle = seaGrad;
  ctx.fillRect(-sx, horizonY - sy, W, sandY - horizonY);

  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fillRect(-sx, horizonY - sy, W, 55 * dpr);

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2 * dpr;
  const baseWaveY = sandY - 16 * dpr + Math.sin(tSec * 2.1) * 5 * dpr;
  for (let i = 0; i < 6; i++) {
    const y = baseWaveY - i * 10 * dpr;
    ctx.beginPath();
    ctx.moveTo(-sx, y - sy);
    ctx.quadraticCurveTo(W * 0.25 - sx, (y + 6*dpr) - sy, W * 0.5 - sx, y - sy);
    ctx.quadraticCurveTo(W * 0.75 - sx, (y - 6*dpr) - sy, W - sx, y - sy);
    ctx.stroke();
  }

  const sandGrad = ctx.createLinearGradient(0, sandY - sy, 0, H - sy);
  sandGrad.addColorStop(0, "#f3d28b");
  sandGrad.addColorStop(1, "#e2ad5b");
  ctx.fillStyle = sandGrad;
  ctx.fillRect(-sx, sandY - sy, W, H - sandY);

  ctx.strokeStyle = "rgba(0,0,0,0.05)";
  ctx.lineWidth = 2 * dpr;
  for (let y = sandY; y < H; y += 22 * dpr) {
    ctx.beginPath();
    ctx.moveTo(-sx, y - sy);
    ctx.lineTo(W - sx, y - sy);
    ctx.stroke();
  }

  const islandX = W * 0.76 + Math.sin(tSec * 0.25) * 35 * dpr;
  const islandY = horizonY + 38 * dpr;
  ctx.fillStyle = "#2e7d32";
  ctx.beginPath();
  ctx.ellipse(islandX - sx, islandY - sy, 92 * dpr, 26 * dpr, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#5d4037";
  ctx.fillRect(islandX - 3 * dpr - sx, islandY - 44 * dpr - sy, 6 * dpr, 42 * dpr);
  ctx.fillStyle = "#1b5e20";
  ctx.beginPath();
  ctx.arc(islandX - sx, islandY - 48 * dpr - sy, 28 * dpr, Math.PI, Math.PI * 2);
  ctx.fill();
}

// =====================
// Main loop
// =====================
let last = performance.now();
function loop(now) {
  let dt = Math.min(0.033, (now - last) / 1000);
  last = now;

  if (loaded < totalToLoad || player.w === 0) {
    ctx.fillStyle = "#87CEEB";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "white";
    ctx.font = `${Math.floor(22 * dpr)}px system-ui`;
    ctx.fillText("Lataan kuvia…", 12 * dpr, 34 * dpr);
    requestAnimationFrame(loop);
    return;
  }

  if (slowLeft > 0) {
    slowLeft -= dt;
    dt *= 0.35;
  }

  tSec += dt;
  bounceT += dt;

  if (isCheering) {
    cheerLeftMs -= dt * 1000;
    if (cheerLeftMs <= 0) isCheering = false;
  }

  if (shakeLeft > 0) {
    shakeLeft -= dt;
    if (shakeLeft <= 0) shakeAmp = 0;
  }

  const level = getLevel(score);
  let spawnEvery = Math.max(SPAWN_MIN, SPAWN_START - (level - 1) * 0.07);
  spawnEvery = clamp(spawnEvery, SPAWN_MIN, 2.0);

  if (started && !gameOver) {
    spawnAcc += dt;
    while (spawnAcc >= spawnEvery) {
      spawnAcc -= spawnEvery;
      spawnItem();
    }
  }

  const px = player.xN * W;
  const py = player.baseYN * H;
  const bounce = Math.sin(bounceT * 6.0) * (10 * dpr);

  const prog = clamp01(score / FULL_SCALE_SCORE);
  const sizeScale = 1 + prog * 0.20;

  const pW = player.w * sizeScale;
  const pH = player.h * sizeScale;
  const pX = px - pW / 2;
  const pY = py - pH + bounce;

  const pHitW = pW * 0.55;
  const pHitH = pH * 0.60;
  const pHitX = pX + (pW - pHitW) / 2;
  const pHitY = pY + (pH - pHitH) * 0.35;

  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];

    it.swayPhase += dt * 2.2;
    const sway = Math.sin(it.swayPhase) * 0.06;
    it.xN = Math.max(0.04, Math.min(0.96, it.xN + sway * dt));

    it.yN += it.vYN * dt;
    it.rot += it.rV * dt;

    const sprite = itemImg[it.type];
    const targetH = (it.type === "big" ? 160 : 128) * dpr;
    const sc = (targetH / sprite.height) * it.scale;
    const sW = sprite.width * sc;
    const sH = sprite.height * sc;

    const sX = it.xN * W - sW / 2;
    const sY = it.yN * H;

    if (sY > H + 100 * dpr) {
      items.splice(i, 1);
      if (it.type !== "bomb") {
        lives = Math.max(0, lives - 1);
        if (lives <= 0) { gameOver = true; sfxGameOver(); }
      }
      continue;
    }

    const iHitW = sW * it.hitW;
    const iHitH = sH * it.hitH;
    const iHitX = sX + (sW - iHitW) / 2;
    const iHitY = sY + (sH - iHitH) / 2;

    if (!aabbHit(pHitX, pHitY, pHitW, pHitH, iHitX, iHitY, iHitW, iHitH)) continue;

    items.splice(i, 1);

    const popX = pX + pW / 2;
    const popY = pY + pH * 0.25;

    if (it.type === "bomb") {
      lives = Math.max(0, lives - 1);
      triggerBombHit();
      spawnSparks(popX, popY, 28);
      sfxBomb();
      if (lives <= 0) { gameOver = true; sfxGameOver(); }
    } else if (it.type === "bonus") {
      score += 3; triggerCheer(); addPop(popX, popY, "+3"); sfxBonus();
    } else if (it.type === "big") {
      score += 5; addPop(popX, popY, "+5"); sfxBig();
    } else {
      score += 1; addPop(popX, popY, "+1"); sfxNormal();
    }
  }

  lives = Math.max(0, lives);

  const { sx, sy } = getShakeOffset();
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(sx, sy);

  drawBackground(sx, sy);

  const usingBelly = score >= BELLY_SCORE;
  const pSprite =
    usingBelly
      ? (isCheering ? playerImg.bellyCheer : playerImg.bellyFlex)
      : (isCheering ? playerImg.leanCheer : playerImg.leanFlex);

  ctx.drawImage(pSprite, pX, pY, pW, pH);

  for (const it of items) {
    const sprite = itemImg[it.type];
    const targetH = (it.type === "big" ? 160 : 128) * dpr;
    const sc = (targetH / sprite.height) * it.scale;
    const sW = sprite.width * sc;
    const sH = sprite.height * sc;

    const cx = it.xN * W;
    const y = it.yN * H;

    ctx.save();
    ctx.translate(cx, y + sH / 2);
    ctx.rotate(it.rot);

    ctx.drawImage(sprite, -sW / 2, -sH / 2, sW, sH);

    if (it.type === "bonus") {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.shadowBlur = 22 * dpr;
      ctx.shadowColor = "rgba(255,220,120,0.9)";
      ctx.drawImage(sprite, -sW / 2, -sH / 2, sW, sH);
      ctx.restore();
    }

    ctx.restore();
  }

  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life -= dt;
    if (s.life <= 0) { sparks.splice(i, 1); continue; }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 540 * dpr * dt;
    ctx.fillStyle = "rgba(255,210,80,0.9)";
    ctx.fillRect(s.x - sx, s.y - sy, 2 * dpr, 2 * dpr);
  }

  ctx.textAlign = "center";
  ctx.font = `${Math.floor(22 * dpr)}px system-ui`;
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    p.life -= dt;
    if (p.life <= 0) { pops.splice(i, 1); continue; }
    const rise = (1 - p.life) * 40 * dpr;
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, p.life + 0.2)})`;
    ctx.fillText(p.text, p.x - sx, (p.y - sy) - rise);
  }
  ctx.textAlign = "left";

  ctx.fillStyle = "white";
  ctx.font = `${Math.floor(20 * dpr)}px system-ui`;
  ctx.fillText(`Score: ${score}`, 12 * dpr, 30 * dpr);
  ctx.fillText(`Lives: ${lives}`, 12 * dpr, 56 * dpr);
  ctx.fillText(`Level: ${getLevel(score)}`, 12 * dpr, 82 * dpr);

  if (!started && !gameOver) {
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(-sx, -sy, W, H);
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.font = `${Math.floor(30 * dpr)}px system-ui`;
    ctx.fillText("TATU OLUTPELI", W/2 - sx, H*0.42 - sy);
    ctx.font = `${Math.floor(18 * dpr)}px system-ui`;
    ctx.fillText("Move mouse / drag finger", W/2 - sx, H*0.50 - sy);
    ctx.fillText("Tap / move to start", W/2 - sx, H*0.56 - sy);
    ctx.textAlign = "left";
  }

  if (gameOver) {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(-sx, -sy, W, H);
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.font = `${Math.floor(34 * dpr)}px system-ui`;
    ctx.fillText("GAME OVER", W / 2 - sx, H / 2 - sy);
    ctx.font = `${Math.floor(18 * dpr)}px system-ui`;
    ctx.fillText("Tap to restart", W / 2 - sx, H / 2 + 34 * dpr - sy);
    ctx.textAlign = "left";
  }

  ctx.restore();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
