const limit = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value));

function dragDisplay(point, current, nearest) {
  if (current.id === nearest.id) return nearest;
  const a = current.bounds || current.workArea;
  const b = nearest.bounds || nearest.workArea;
  const tolerance = 26;
  const right = a.x + a.width, bottom = a.y + a.height;
  const nextRight = b.x + b.width, nextBottom = b.y + b.height;
  const sharedY = point.y >= Math.max(a.y, b.y) && point.y < Math.min(bottom, nextBottom);
  const sharedX = point.x >= Math.max(a.x, b.x) && point.x < Math.min(right, nextRight);
  // A narrow band across a shared seam belongs to the last occupied display.
  // Pull farther into the neighboring display to transfer ownership.
  if (sharedY && ((right === b.x && Math.abs(point.x - right) < tolerance)
    || (a.x === nextRight && Math.abs(point.x - a.x) < tolerance))) return current;
  if (sharedX && ((bottom === b.y && Math.abs(point.y - bottom) < tolerance)
    || (a.y === nextBottom && Math.abs(point.y - a.y) < tolerance))) return current;
  return nearest;
}

function dockTarget(point, area, bounds, velocity = { x: 0, y: 0 }) {
  const right = area.x + area.width, bottom = area.y + area.height;
  const reach = 34;
  const edges = [
    ['left', point.x - area.x - Math.max(0, -velocity.x) * .035],
    ['right', right - point.x - Math.max(0, velocity.x) * .035],
    ['top', point.y - area.y - Math.max(0, -velocity.y) * .035],
    ['bottom', bottom - point.y - Math.max(0, velocity.y) * .035],
  ].filter(([, distance]) => distance <= reach).sort((a, b) => a[1] - b[1]);
  let edge = edges[0]?.[0] || 'free';
  const cornerX = point.x - area.x <= 60 ? 'left' : right - point.x <= 60 ? 'right' : null;
  const cornerY = point.y - area.y <= reach ? 'top' : bottom - point.y <= reach ? 'bottom' : null;
  if (cornerX && cornerY) edge = cornerY + '-' + cornerX;
  const [vertical, horizontal] = edge.split('-');
  const x = limit(edge === 'free' ? bounds.x : point.x - bounds.width / 2, area.x, right - bounds.width);
  const y = limit(edge === 'free' ? bounds.y : point.y - bounds.height * .45, area.y, bottom - bounds.height);
  return { edge, x: edge === 'left' || horizontal === 'left' ? area.x : edge === 'right' || horizontal === 'right' ? right - bounds.width : x,
    y: vertical === 'top' ? area.y : vertical === 'bottom' ? bottom - bounds.height : y };
}

function createPetMotion(win, screen, save, cursorPoint) {
  let edge = 'free', timer, drag, velocity = { x: 0, y: 0 };
  function pose() { return { edge, dragging: Boolean(drag), vx: velocity.x, vy: velocity.y, shakeSpeed: drag?.shakeSpeed || 0 }; }
  function emit() { if (!win.isDestroyed()) win.webContents.send('pet-motion', pose()); }
  function stop() { clearInterval(timer); timer = null; drag = null; }
  function persist() { const b = win.getBounds(); save({ petX: b.x, petY: b.y, petEdge: edge }); }
  function place(x, y) {
    // Electron's native integer conversion rejects JavaScript's negative zero.
    const nx = Math.round(x) + 0, ny = Math.round(y) + 0;
    if (![nx, ny].every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) return;
    const b = win.getBounds();
    if (b.x !== nx || b.y !== ny) win.setPosition(nx, ny);
  }
  function settle(target) {
    stop(); const start = win.getBounds(), began = Date.now();
    edge = target.edge; emit();
    timer = setInterval(() => {
      const t = Math.min(1, (Date.now() - began) / 280);
      const eased = 1 - (1 - t) ** 3;
      place(start.x + (target.x - start.x) * eased, start.y + (target.y - start.y) * eased);
      velocity.x *= .78; velocity.y *= .78; emit();
      if (t === 1) { stop(); velocity = { x: 0, y: 0 }; emit(); persist(); }
    }, 16);
  }
  return {
    pose, stop,
    start() {
      stop(); const cursor = cursorPoint(), bounds = win.getBounds();
      // The cursor holds a rope tied to the back of Xiaojin's hood: the window is lifted so the cursor sits
      // at the rope's top (13/450 of the height), and the renderer hangs the figure from it.
      drag = { x: bounds.x, y: bounds.y, anchorX: bounds.width / 2, anchorY: bounds.height * 13 / 450, last: Date.now(), cursor,
        display: screen.getDisplayMatching(bounds) };
      velocity = { x: 0, y: 0 }; edge = 'free'; emit();
      timer = setInterval(() => {
        const p = cursorPoint(), now = Date.now();
        drag.display = dragDisplay(p, drag.display, screen.getDisplayNearestPoint(p));
        const dt = Math.min(.035, Math.max(.008, (now - drag.last) / 1000)); drag.last = now;
        const dx = p.x - drag.cursor.x, dy = p.y - drag.cursor.y;
        drag.shakeSpeed = (Math.abs(dx) >= Math.abs(dy) ? dx : dy) / dt;
        drag.cursor = p;
        // The window stays locked to the cursor (the rope top); the renderer's rope physics supplies the
        // inertia. A lagging window would pull the rope top to the window edge and fling Xiaojin out of it.
        const tx = p.x - drag.anchorX, ty = p.y - drag.anchorY;
        const k = 1 - Math.exp(-dt * 12);
        velocity.x += ((tx - drag.x) / dt - velocity.x) * k;
        velocity.y += ((ty - drag.y) / dt - velocity.y) * k;
        drag.x = tx; drag.y = ty;
        place(drag.x, drag.y); emit();
      }, 16);
    },
    end() {
      if (!drag) return;
      const p = cursorPoint(), b = win.getBounds();
      const area = dragDisplay(p, drag.display, screen.getDisplayNearestPoint(p)).workArea;
      settle(dockTarget(p, area, { ...b, x: b.x + velocity.x * .095, y: b.y + velocity.y * .095 }, velocity));
    },
    restore(savedEdge = edge) {
      stop(); velocity = { x: 0, y: 0 };
      const b = win.getBounds(), area = screen.getDisplayMatching(b).workArea;
      const point = { x: b.x + b.width / 2, y: b.y + b.height * .45 };
      if (savedEdge.endsWith('left')) point.x = area.x;
      if (savedEdge.endsWith('right')) point.x = area.x + area.width;
      if (savedEdge.startsWith('top')) point.y = area.y;
      if (savedEdge.startsWith('bottom')) point.y = area.y + area.height;
      const target = dockTarget(point, area, b);
      edge = savedEdge === 'free' ? 'free' : target.edge;
      place(target.x, target.y); emit(); persist();
    },
  };
}
module.exports = { createPetMotion, dockTarget, dragDisplay };
