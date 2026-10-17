let backgroundMotionEnabled = preferences.get('ps3_motion', '1') === '1';
let backgroundScenes = [];
let backgroundMotionButtons = [];
let backgroundPointer = {
  x: -1000,
  y: -1000,
  until: 0
};

function updateMotionButtons() {
  backgroundMotionButtons.forEach(b => {
    let on = backgroundMotionEnabled && !reducedMotion.matches;
    b.textContent = on ? 'Ⅱ': '▶';
    b.setAttribute('aria-label', translate(on ? 'motionOff': 'motionOn'));
    b.setAttribute('aria-pressed', String(on));
  });
}

function createBackgroundScene(parent) {
  let wrap = document.createElement('div');
  wrap.className = 'world';
  wrap.setAttribute('aria-hidden', 'true');
  let canvas = document.createElement('canvas');
  wrap.append(canvas);
  parent.prepend(wrap);
  backgroundScenes.push({
    parent,
    canvas,
    ctx: canvas.getContext('2d'),
    snakes: [],
    food: [],
    last: 0
  });
  if (parent !== document.body) {
    let b = document.createElement('button');
    b.type = 'button';
    b.className = 'motion';
    b.onclick = () => {
      backgroundMotionEnabled = !backgroundMotionEnabled;
      preferences.set('ps3_motion', backgroundMotionEnabled ? '1': '0');
      updateMotionButtons();
    };
    parent.append(b);
    backgroundMotionButtons.push(b);
  }
}
createBackgroundScene(document.body);
createBackgroundScene(getElement('menu'));
createBackgroundScene(getElement('ranking'));
let viewportWidth = innerWidth;
let viewportHeight = innerHeight;
let backgroundCellSize = 24;
let backgroundColumns = 20;
let backgroundRows = 30;

function createBackgroundFood(w) {
  for (let tries = 0; tries < 200; tries++) {
    let p = {
      x: 1 + Math.floor(Math.random() * (backgroundColumns - 2)),
      y: 1 + Math.floor(Math.random() * (backgroundRows - 2)),
      color: FOOD_COLORS[Math.floor(Math.random() * 5)]
    };
    if (!w.snakes.some(s => s.body.some(q => q.x === p.x && q.y === p.y)) && !w.food.some(q => q.x === p.x && q.y === p.y)) return p;
  }
  return {
    x: 1,
    y: 1,
    color: FOOD_COLORS[0]
  }
}

function resizeBackground() {

  viewportWidth = innerWidth;
  viewportHeight = innerHeight;
  
  backgroundCellSize = viewportWidth < 600 ? 22: 27;
  backgroundColumns = Math.max(8, Math.floor(viewportWidth / backgroundCellSize));
  backgroundRows = Math.max(10, Math.floor(viewportHeight / backgroundCellSize));
  backgroundScenes.forEach(w => {
  
    let d = Math.min(devicePixelRatio || 1, 1.5);
    w.canvas.width = Math.ceil(viewportWidth * d);
    w.canvas.height = Math.ceil(viewportHeight * d);
    w.ctx.setTransform(d, 0, 0, d, 0, 0);
    w.snakes = [0, 1, 2].map(i => {
      let x = Math.min(backgroundColumns - 2, 5 + i * 2);
      let y = 2 + Math.floor((backgroundRows - 4) * (i + 1) / 4);
      return {
        body: Array.from({
          length: 5
        },
        (_,
        j) => ({
          x: Math.max(0,
          x - j),
          y
        })),
        dir: DIRECTIONS.right,
        color: ['#62c6b8',
        '#bd89da',
        '#d1ae73'][i],
        limit: 5,
        stuck: 0
      }
    });
    w.food = [];
  
    for (let j = 0; j < 12; j++) w.food.push(createBackgroundFood(w));
    w.last = 0;
  });
}

// Prefer food, but add a distance penalty near the pointer to make the snakes steer away.
function advanceBackgroundSnakes(w, now) {
  w.snakes.forEach(s => {
    let h = s.body[0];
    let near = now < backgroundPointer.until;
    let target = [...w.food].sort((a, b) => (Math.abs(h.x - a.x) + Math.abs(h.y - a.y)) - (Math.abs(h.x - b.x) + Math.abs(h.y - b.y)))[0] || h;
    let options = Object.values(DIRECTIONS).filter(d => !(d.x === - s.dir.x && d.y === - s.dir.y)).map(d => {
      let x = h.x + d.x, y = h.y + d.y, r = Math.hypot((x + 0.5) * backgroundCellSize - backgroundPointer.x, (y + 0.5) * backgroundCellSize - backgroundPointer.y);
      return {
        x,
        y,
        d,
        cost: Math.abs(x - target.x) + Math.abs(y - target.y) + (near && r < 120 ? ((120 - r) / 13) ** 2: 0),
        blocked: x < 1 || y < 1 || x >= backgroundColumns - 1 || y >= backgroundRows - 1 || w.snakes.some(a => a.body.slice(0,
        -1).some(q => q.x === x && q.y === y))
      }
    }).filter(p => !p.blocked).sort((a, b) => a.cost - b.cost);
    if (!options.length) {
      s.stuck++;
      return;
    }
    s.stuck = 0;
    let p = options[0];
    s.dir = p.d;
    s.body.unshift({
      x: p.x,
      y: p.y
    });
    let fi = w.food.findIndex(f => f.x === p.x && f.y === p.y);
    if (fi >= 0) {
      s.limit = Math.min(12, s.limit + 1);
      w.food.splice(fi, 1);
      w.food.push(createBackgroundFood(w));
    }
    while (s.body.length > s.limit) s.body.pop();
  });
}

function renderBackground(now) {
  let front = !getElement('menu').classList.contains('hidden') ? getElement('menu'): !getElement('ranking').classList.contains('hidden') ? getElement('ranking'): document.body;
  backgroundScenes.forEach(w => {
    if (w.parent !== front) return;
    if (backgroundMotionEnabled && !reducedMotion.matches && now - w.last > 145) {
      advanceBackgroundSnakes(w, now);
      w.last = now;
    }
    let c = w.ctx;
    c.clearRect(0, 0, viewportWidth, viewportHeight);
    c.fillStyle = '#cbb1ed19';
    for (let x = 12; x < viewportWidth; x += backgroundCellSize) for (let y = 12; y < viewportHeight; y += backgroundCellSize) c.fillRect(x, y, 1, 1);
    w.food.forEach(f => {
      c.globalAlpha = 0.55;
      c.fillStyle = f.color;
      c.fillRect((f.x + 0.5) * backgroundCellSize - 3, (f.y + 0.5) * backgroundCellSize - 3, 6, 6);
    });
    w.snakes.forEach(s => s.body.forEach((p, i) => {
      c.globalAlpha = i ? 0.4: 0.65;
      c.fillStyle = s.color;
      c.fillRect(p.x * backgroundCellSize + 2, p.y * backgroundCellSize + 2, backgroundCellSize - 4, backgroundCellSize - 4);
      if (!i) {
        c.globalAlpha = 0.9;
        c.fillStyle = '#120b21';
        if (s.dir.x) {
          c.fillRect(p.x * backgroundCellSize + (s.dir.x > 0 ? backgroundCellSize - 8: 5), p.y * backgroundCellSize + 5, 3, 3);
          c.fillRect(p.x * backgroundCellSize + (s.dir.x > 0 ? backgroundCellSize - 8: 5), p.y * backgroundCellSize + backgroundCellSize - 8, 3, 3);
        } else {
          c.fillRect(p.x * backgroundCellSize + 5, p.y * backgroundCellSize + (s.dir.y > 0 ? backgroundCellSize - 8: 5), 3, 3);
          c.fillRect(p.x * backgroundCellSize + backgroundCellSize - 8, p.y * backgroundCellSize + (s.dir.y > 0 ? backgroundCellSize - 8: 5), 3, 3);
        }
      }
    }));
    c.globalAlpha = 1;
  });
}

function trackBackgroundPointer(e) {
  if (e.target.closest('.card,#board,button,select,input')) return;
  backgroundPointer.x = e.clientX;
  backgroundPointer.y = e.clientY;
  backgroundPointer.until = performance.now() + 1500;
}
document.addEventListener('pointermove', trackBackgroundPointer, {
  passive: true
});
document.addEventListener('pointerdown', trackBackgroundPointer, {
  passive: true
});
window.addEventListener('resize', resizeBackground);
