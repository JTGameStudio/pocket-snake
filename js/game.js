'use strict';

// Gameplay tuning. All timing values are milliseconds.
const CONFIG = {
  foodCount: 5,
  foodPoints: 10,
  burstEvery: 50,
  shrinkFraction: 0.3,
  minLength: 4,
  expandEvery: 100,
  startSize: 20,
  maxSize: 32,
  expandBy: 2,
  startDelay: 220,
  minDelay: 65,
  burstSpeedStep: 18,
  scoreSpeedStep: 2
};
const getElement = id => document.getElementById(id);
// Storage can be blocked in private browsing; the game still runs without persistence.
const preferences = {
  get(k,
  d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k,
  v) {
    try {
      localStorage.setItem(k, v);
    } catch {
    }
  }
};
let currentLanguage = preferences.get('ps2_lang', 'en');
if (!translations[currentLanguage]) currentLanguage = 'en';

function translate(key) {
  return translations[currentLanguage][key] || translations.en[key] || key;
}
let controlHand = preferences.get('ps2_hand', 'left');
if (!['left', 'right'].includes(controlHand)) controlHand = 'left';
let soundEnabled = preferences.get('ps_sound', '1') === '1';
// Keep the existing storage keys so returning players retain their records.
let recentRuns;
try {
  recentRuns = JSON.parse(preferences.get('ps2_runs', '[]'));
  if (!Array.isArray(recentRuns)) recentRuns = [];
  recentRuns = recentRuns.filter(r => r && typeof r.id === 'string' && Number.isFinite(r.score) && r.score >= 0 && Number.isFinite(r.date)).slice(-10);
} catch {
  recentRuns = [];
}
let bestScore = Math.max(0, Number(preferences.get('ps_best', '0')) || 0, ...recentRuns.map(r => r.score));
if (preferences.get('ps2_migrated', '0') !== '1') {
  if (bestScore > 0) recentRuns.push({
    id: 'legacy',
    score: bestScore,
    date: 0,
    legacy: true
  });
  recentRuns = recentRuns.slice(-10);
  preferences.set('ps2_runs', JSON.stringify(recentRuns));
  preferences.set('ps2_migrated', '1');
}
let gameState = 'menu';
let snakeSegments = [];
let foodItems = [];
let dir = {
  x: 1,
  y: 0
};
let pendingTurns = [];
let score = 0;
let gridSize = 20;
let visibleGridSize = 20;
let speedBoostCount = 0;
let currentRunId = null;
let isGameOver = false;
let movementTimer = null;
let tutorialTimeout = null;
let tutorialStartedAt = 0;
let burstParticles = [];
let burstRings = [];
let burstFlash = 0;
let pendingStatusKeys = [];
let statusExpiresAt = 0;
let soundContext = null;
let previousFrameTime = 0;
const gameCanvas = getElement('canvas');
const gameContext = gameCanvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const DIRECTIONS = {
  up: {
    x: 0,
    y: -1
  },
  down: {
    x: 0,
    y: 1
  },
  left: {
    x: -1,
    y: 0
  },
  right: {
    x: 1,
    y: 0
  }
};

const FOOD_COLORS = ['#ff83bc', '#91e3ce', '#ffd58c', '#a6b9ff', '#d2a0ed'];

function playTone(frequency = 600, duration = 0.06) {
  if (!soundEnabled) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    soundContext ??= new AudioContextClass();
    soundContext.resume();

    const oscillator = soundContext.createOscillator();
    const volume = soundContext.createGain();
    const now = soundContext.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    volume.gain.setValueAtTime(0.04, now);
    volume.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    oscillator.connect(volume).connect(soundContext.destination);
    oscillator.start();
    oscillator.stop(now + duration);
  } catch {
    // Audio is optional: unsupported or blocked audio must not stop the game.
  }
}


// Apply the selected language and control layout without restarting the run.
function updateInterface() {
  document.documentElement.lang = currentLanguage;
  getElement('language').value = currentLanguage;
  document.querySelectorAll('[data-t]').forEach(e => {
    e.textContent = translate(e.dataset.t);
    e.dir = currentLanguage === 'ar' ? 'rtl': 'auto';
  });
  document.querySelectorAll('[data-hand]').forEach(e => {
    e.classList.toggle('active', controlHand === e.dataset.hand);
    e.setAttribute('aria-pressed', String(controlHand === e.dataset.hand));
  });
  document.querySelectorAll('[data-dir]').forEach(e => e.setAttribute('aria-label', translate(e.dataset.dir)));
  getElement('controls').classList.toggle('right', controlHand === 'right');
  getElement('pause').textContent = translate(gameState === 'paused' ? 'resume': 'pause');
  getElement('pause').disabled = !['playing', 'paused'].includes(gameState);
  getElement('sound').textContent = translate(soundEnabled ? 'soundOn': 'soundOff');
  getElement('sound').setAttribute('aria-pressed', String(soundEnabled));
  getElement('continueGame').classList.toggle('hidden', gameState !== 'paused');
  updateScoreDisplay();
  if (!getElement('ranking').classList.contains('hidden')) renderLeaderboard();
  updateMotionButtons();
}

function updateScoreDisplay() {
  getElement('score').textContent = String(score).padStart(3, '0');
  getElement('best').textContent = String(bestScore).padStart(3, '0');
  getElement('level').textContent = String(speedBoostCount + 1).padStart(2, '0');
}

function showPanel(id) {
  ['menu', 'ranking'].forEach(k => getElement(k).classList.toggle('hidden', k !== id));
  getElement('app').inert = !!id;
  if (id) getElement(id).querySelector('button,select').focus();
}

// Build a list of empty cells to avoid duplicate food and food inside the snake.
function replenishFood() {
  const emptyCells = [];

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const hasSnake = snakeSegments.some(segment => segment.x === x && segment.y === y);
      const hasFood = foodItems.some(food => food.x === x && food.y === y);

      if (!hasSnake && !hasFood) {
        emptyCells.push({ x, y });
      }
    }
  }

  while (foodItems.length < CONFIG.foodCount && emptyCells.length > 0) {
    const randomIndex = Math.floor(Math.random() * emptyCells.length);
    const position = emptyCells.splice(randomIndex, 1)[0];
    const color = FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)];
    foodItems.push({ ...position, color });
  }
}


function resetGame() {
  gridSize = CONFIG.startSize;
  visibleGridSize = gridSize;
  snakeSegments = [{
    x: 8,
    y: 10
  }, {
    x: 7,
    y: 10
  }, {
    x: 6,
    y: 10
  }, {
    x: 5,
    y: 10
  }];
  foodItems = [];
  dir = {
    x: 1,
    y: 0
  };
  pendingTurns = [];
  score = 0;
  speedBoostCount = 0;
  isGameOver = false;
  burstParticles = [];
  burstRings = [];
  burstFlash = 0;
  pendingStatusKeys = [];
  statusExpiresAt = 0;
  getElement('status').textContent = '';
  replenishFood();
  updateScoreDisplay();
}

function getMovementDelay() {
  return Math.max(CONFIG.minDelay, CONFIG.startDelay - speedBoostCount * CONFIG.burstSpeedStep - Math.floor(score / 10) * CONFIG.scoreSpeedStep);
}

function scheduleNextStep() {
  clearTimeout(movementTimer);
  movementTimer = setTimeout(stepGame, getMovementDelay());
}

// Buffer at most two turns, rejecting direct reversals.
function queueTurn(k) {
  if (gameState !== 'playing') return;
  let d = DIRECTIONS[k];
  let last = pendingTurns.length ? pendingTurns[pendingTurns.length - 1]: dir;
  if (pendingTurns.length >= 2 || (d.x === - last.x && d.y === - last.y) || (d.x === last.x && d.y === last.y)) return;
  pendingTurns.push(d);
}

function restartBoardAnimation(name) {
  getElement('board').classList.remove(name);
  void getElement('board').offsetWidth;
  getElement('board').classList.add(name);
}

function showStatusMessage(keys) {
  pendingStatusKeys = keys;
  statusExpiresAt = performance.now() + 2700;
  getElement('status').textContent = keys.map(translate).join(' · ');
}

// Remove from the tail only; the head stays in place and at least four segments remain.
function burstTail() {
  let count = Math.min(snakeSegments.length - CONFIG.minLength, Math.max(1, Math.round(snakeSegments.length * CONFIG.shrinkFraction)));
  let removed = count > 0 ? snakeSegments.splice(snakeSegments.length - count, count): [];
  removed.forEach((p, j) => {
    burstRings.push({
      x: p.x + 0.5,
      y: p.y + 0.5,
      r: 0.3,
      life: 0.65,
      max: 0.65
    });
    for (let i = 0; i < (reducedMotion.matches ? 2: 9); i++) {
      let a = Math.random() * Math.PI * 2;
      let s = 1.3 + Math.random() * 3;
      burstParticles.push({
        x: p.x + 0.5,
        y: p.y + 0.5,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0.5 + Math.random() * 0.35,
        max: 0.85,
        color: j % 2 ? '#ffd58c': '#ff8da5'
      });
    }
  });
  speedBoostCount++;
  burstFlash = reducedMotion.matches ? 0: 0.12;
  restartBoardAnimation('burst');
  playTone(260, 0.11);
}

// Shift world coordinates together so expansion appears centered around the current view.
function expandPlayfield() {
  if (gridSize >= CONFIG.maxSize) return false;
  let inc = Math.min(CONFIG.expandBy, CONFIG.maxSize - gridSize);
  let offset = inc / 2;
  gridSize += inc;
  snakeSegments.forEach(p => {
    p.x += offset;
    p.y += offset;
  });
  foodItems.forEach(p => {
    p.x += offset;
    p.y += offset;
  });
  burstParticles.forEach(p => {
    p.x += offset;
    p.y += offset;
  });
  burstRings.forEach(p => {
    p.x += offset;
    p.y += offset;
  });
  if (reducedMotion.matches) visibleGridSize = gridSize;
  restartBoardAnimation('grow');
  return true;
}

// One simulation step. Rendering uses a separate animation loop.
function stepGame() {
  if (gameState !== 'playing') return;

  if (pendingTurns.length > 0) {
    dir = pendingTurns.shift();
  }

  const nextHead = {
    x: snakeSegments[0].x + dir.x,
    y: snakeSegments[0].y + dir.y
  };
  const foodIndex = foodItems.findIndex(food => food.x === nextHead.x && food.y === nextHead.y);
  const isEating = foodIndex >= 0;

  // The last tail cell becomes free on a non-eating move.
  const collisionBody = isEating ? snakeSegments : snakeSegments.slice(0, -1);
  const hitsWall = nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= gridSize || nextHead.y >= gridSize;
  const hitsBody = collisionBody.some(segment => segment.x === nextHead.x && segment.y === nextHead.y);

  if (hitsWall || hitsBody) {
    finishRun(false);
    return;
  }

  snakeSegments.unshift(nextHead);

  if (isEating) {
    foodItems.splice(foodIndex, 1);
    score += CONFIG.foodPoints;
    bestScore = Math.max(bestScore, score);
    preferences.set('ps_best', bestScore);
    playTone(650, 0.055);

    const messages = [];
    if (score % CONFIG.burstEvery === 0) {
      burstTail();
      messages.push('burstMsg');
    }
    if (score % CONFIG.expandEvery === 0 && expandPlayfield()) {
      messages.push('mapMsg');
    }
    if (messages.length > 0) showStatusMessage(messages);

    replenishFood();
    updateScoreDisplay();

    if (snakeSegments.length === gridSize * gridSize) {
      finishRun(true);
      return;
    }
  } else {
    snakeSegments.pop();
  }

  if (gameState === 'playing') scheduleNextStep();
}


function startGame() {
  clearTimeout(tutorialTimeout);
  getElement('tutorial').classList.add('hidden');
  resetGame();
  gameState = 'playing';
  updateInterface();
  scheduleNextStep();
}

function startNewRun() {
  if (gameState === 'paused' && !confirm(translate('confirm'))) return;
  playTone(420);
  clearTimeout(movementTimer);
  clearTimeout(tutorialTimeout);
  currentRunId = null;
  resetGame();
  showPanel(null);
  getElement('pauseCover').classList.add('hidden');
  if (preferences.get('ps2_taught', '0') !== '1') {
    gameState = 'tutorial';
    tutorialStartedAt = performance.now();
    getElement('tutorial').classList.remove('hidden');
    updateInterface();
    animateTutorial();
  } else startGame();
}

function animateTutorial() {
  if (gameState !== 'tutorial') return;
  let e = performance.now() - tutorialStartedAt;
  let s = e < 2300 ? 0: 1;
  if (e >= 4600) {
    preferences.set('ps2_taught', '1');
    startGame();
    return;
  }
  let k = Math.floor((e % 2300) / 2300 * 6);
  let head = s ? {
    x: 8 + k, y: 7
  }: {
    x: 8,
    y: 13 - k
  };
  dir = s ? DIRECTIONS.right: DIRECTIONS.up;
  snakeSegments = Array.from({
    length: 5
  }, (_, i) => ({
    x: head.x - dir.x * i,
    y: head.y - dir.y * i
  }));
  foodItems = [{
    x: s ? 15: 8,
    y: s ? 7: 6,
    color: FOOD_COLORS[0]
  }];
  getElement('finger').classList.toggle('turn', !!s);
  getElement('dots').textContent = s ? '○●': '●○';
  tutorialTimeout = setTimeout(animateTutorial, 70);
}

function togglePause() {
  if (gameState === 'playing') {
    gameState = 'paused';
    clearTimeout(movementTimer);
    getElement('pauseCover').classList.remove('hidden');
  } else if (gameState === 'paused') {
    gameState = 'playing';
    getElement('pauseCover').classList.add('hidden');
    scheduleNextStep();
  }
  updateInterface();
}

function openMenu() {
  if (gameState === 'playing') togglePause();
  if (gameState === 'tutorial') {
    clearTimeout(tutorialTimeout);
    gameState = 'menu';
    getElement('tutorial').classList.add('hidden');
  }
  showPanel('menu');
  updateInterface();
}

// Save completed runs only. The leaderboard ranks the latest ten, not the all-time top ten.
function finishRun(win) {
  if (isGameOver) return;
  isGameOver = true;
  clearTimeout(movementTimer);
  gameState = 'over';
  currentRunId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  recentRuns.push({
    id: currentRunId,
    score,
    date: Date.now(),
    win,
    map: gridSize
  });
  recentRuns = recentRuns.slice(-10);
  preferences.set('ps2_runs', JSON.stringify(recentRuns));
  playTone(win ? 850: 160, 0.2);
  showPanel('ranking');
  updateInterface();
}

function renderLeaderboard() {
  let ordered = [...recentRuns].sort((a, b) => b.score - a.score || b.date - a.date);
  let i = ordered.findIndex(r => r.id === currentRunId);
  getElement('summary').classList.toggle('hidden', i < 0);
  if (i >= 0) getElement('summary').textContent = (ordered[i].win ? translate('win') + ' · ': '') + translate('score') + ': ' + ordered[i].score + ' · ' + translate('yourRank') + ': ' + (i + 1) + ' / ' + ordered.length;
  getElement('rankList').replaceChildren();
  if (!ordered.length) {
    let e = document.createElement('li');
    e.textContent = translate('empty');
    getElement('rankList').append(e);
  }
  ordered.forEach((r, j) => {
    let e = document.createElement('li');
    e.classList.toggle('current', r.id === currentRunId);
    let rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(j + 1).padStart(2, '0');
    let label = document.createElement('span');
    label.textContent = r.legacy ? translate('legacy'): r.id === currentRunId ? translate('you'): 'POCKET SNAKE';
    let meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = r.date ? new Intl.DateTimeFormat(currentLanguage, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(r.date)): '—';
    label.append(meta);
    let pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = r.score;
    e.append(rank, label, pts);
    getElement('rankList').append(e);
  });
}

// visibleGridSize eases toward gridSize to animate the expanded playfield.
function renderGame(dt, now) {
  if (gameState !== 'paused' && gameState !== 'menu') {
    visibleGridSize += (gridSize - visibleGridSize) * Math.min(1, dt * 3);
    if (Math.abs(gridSize - visibleGridSize) < 0.005) visibleGridSize = gridSize;
    burstParticles.forEach(p => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-dt * 1.6);
      p.vy *= Math.exp(-dt * 1.6);
      p.life -= dt;
    });
    burstParticles = burstParticles.filter(p => p.life > 0);
    burstRings.forEach(r => {
      r.life -= dt;
      r.r += dt * 2.8;
    });
    burstRings = burstRings.filter(r => r.life > 0);
    burstFlash = Math.max(0, burstFlash - dt);
  }
  let size = 600 / visibleGridSize;
  let left = gridSize / 2 - visibleGridSize / 2;
  const px = x => (x - left) * size;
  gameContext.clearRect(0, 0, 600, 600);
  gameContext.fillStyle = '#0d0920';
  gameContext.fillRect(0, 0, 600, 600);
  gameContext.strokeStyle = '#a077c61c';
  gameContext.lineWidth = 1;
  for (let n = 0; n <= gridSize; n++) {
    let q = px(n);
    gameContext.beginPath();
    gameContext.moveTo(q, 0);
    gameContext.lineTo(q, 600);
    gameContext.stroke();
    gameContext.beginPath();
    gameContext.moveTo(0, q);
    gameContext.lineTo(600, q);
    gameContext.stroke();
  }
  foodItems.forEach((f, i) => {
    let scale = reducedMotion.matches ? 0.65: 0.62 + 0.08 * Math.sin(now / 220 + i);
    let s = size * scale;
    gameContext.fillStyle = f.color;
    gameContext.shadowColor = f.color;
    gameContext.shadowBlur = 8;
    gameContext.fillRect(px(f.x + 0.5) - s / 2, px(f.y + 0.5) - s / 2, s, s);
  });
  gameContext.shadowBlur = 0;
  snakeSegments.forEach((p, i) => {
    gameContext.fillStyle = i ? '#4bd4bf': '#ffe18c';
    let pad = Math.max(1, size * 0.06);
    gameContext.fillRect(px(p.x) + pad, px(p.y) + pad, size - pad * 2, size - pad * 2);
    if (!i) {
      gameContext.fillStyle = '#17102b';
      let eye = Math.max(2, size * 0.13);
      let x = px(p.x);
      let y = px(p.y);
      if (dir.x) {
        gameContext.fillRect(x + size * (dir.x > 0 ? 0.65: 0.2), y + size * 0.2, eye, eye);
        gameContext.fillRect(x + size * (dir.x > 0 ? 0.65: 0.2), y + size * 0.65, eye, eye);
      } else {
        gameContext.fillRect(x + size * 0.2, y + size * (dir.y > 0 ? 0.65: 0.2), eye, eye);
        gameContext.fillRect(x + size * 0.65, y + size * (dir.y > 0 ? 0.65: 0.2), eye, eye);
      }
    }
  });
  burstRings.forEach(r => {
    gameContext.globalAlpha = Math.max(0, r.life / r.max);
    gameContext.strokeStyle = '#ffd08f';
    gameContext.lineWidth = 2;
    gameContext.beginPath();
    gameContext.arc(px(r.x), px(r.y), r.r * size, 0, Math.PI * 2);
    gameContext.stroke();
  });
  burstParticles.forEach(p => {
    gameContext.globalAlpha = Math.min(1, p.life / p.max);
    gameContext.fillStyle = p.color;
    let s = Math.max(2, size * 0.16);
    gameContext.fillRect(px(p.x) - s / 2, px(p.y) - s / 2, s, s);
  });
  gameContext.globalAlpha = 1;
  if (burstFlash > 0) {
    gameContext.fillStyle = 'rgba(255,180,128,' + Math.min(0.12, burstFlash) + ')';
    gameContext.fillRect(0, 0, 600, 600);
  }
  if (statusExpiresAt && now > statusExpiresAt) {
    getElement('status').textContent = '';
    statusExpiresAt = 0;
  }
}
// Input bindings: pointer, swipe, keyboard, and lifecycle events.
getElement('play').onclick = startNewRun;
getElement('again').onclick = startNewRun;
getElement('pause').onclick = togglePause;
getElement('resume').onclick = togglePause;
getElement('menuButton').onclick = openMenu;
getElement('continueGame').onclick = () => {
  showPanel(null);
  if (gameState === 'paused') togglePause();
};
getElement('ranksButton').onclick = () => {
  showPanel('ranking');
  updateInterface();
};
getElement('back').onclick = () => {
  showPanel('menu');
  updateInterface();
};
getElement('skip').onclick = () => {
  preferences.set('ps2_taught', '1');
  startGame();
};
getElement('sound').onclick = () => {
  soundEnabled = !soundEnabled;
  preferences.set('ps_sound', soundEnabled ? '1': '0');
  playTone();
  updateInterface();
};
getElement('language').onchange = e => {
  currentLanguage = e.target.value;
  preferences.set('ps2_lang', currentLanguage);
  updateInterface();
};
document.querySelectorAll('[data-hand]').forEach(b => b.onclick = () => {
  controlHand = b.dataset.hand;
  preferences.set('ps2_hand', controlHand);
  updateInterface();
});
document.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('pointerdown', e => {
  e.preventDefault();
  queueTurn(b.dataset.dir);
}));
let pointer = null;
getElement('board').addEventListener('pointerdown', e => {
  if (gameState !== 'playing') return;
  e.preventDefault();
  pointer = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY
  };
  getElement('board').setPointerCapture(e.pointerId);
});

function handleSwipe(e) {
  if (!pointer || pointer.id !== e.pointerId) return;
  let x = e.clientX - pointer.x;
  let y = e.clientY - pointer.y;
  if (Math.max(Math.abs(x), Math.abs(y)) < 8) return;
  e.preventDefault();
  queueTurn(Math.abs(x) > Math.abs(y) ? x > 0 ? 'right': 'left': y > 0 ? 'down': 'up');
  pointer.x = e.clientX;
  pointer.y = e.clientY;
}
getElement('board').addEventListener('pointermove', handleSwipe);
getElement('board').addEventListener('pointerup', e => {
  handleSwipe(e);
  pointer = null;
});
getElement('board').addEventListener('pointercancel', () => pointer = null);
getElement('board').addEventListener('lostpointercapture', () => pointer = null);
window.addEventListener('keydown', e => {
  if (e.target.matches('select,input,textarea') || !getElement('menu').classList.contains('hidden') || !getElement('ranking').classList.contains('hidden')) return;
  let k = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    a: 'left',
    s: 'down',
    d: 'right'
  }
  [e.key];
  if (k) {
    e.preventDefault();
    queueTurn(k);
  }
  if (e.code === 'Space' && !e.target.matches('button')) {
    e.preventDefault();
    if (['playing', 'paused'].includes(gameState)) togglePause();
  }
});

function pauseWhenInactive() {
  pointer = null;
  if (gameState === 'playing') togglePause();
  if (gameState === 'tutorial') {
    clearTimeout(tutorialTimeout);
    gameState = 'menu';
    getElement('tutorial').classList.add('hidden');
    showPanel('menu');
    updateInterface();
  }
}
window.addEventListener('blur', pauseWhenInactive);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseWhenInactive();
});
document.querySelectorAll('.panel').forEach(p => p.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  let all = [...p.querySelectorAll('button,select')].filter(n => !n.disabled && !n.classList.contains('hidden'));
  let first = all[0];
  let last = all.at(-1);
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}));
