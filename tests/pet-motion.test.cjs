const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPetMotion, dragDisplay, dockTarget } = require('../src/pet-motion.cjs');

test('从负坐标吸附到屏幕顶部时传给 Electron 的零坐标为正零', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const bounds = { x: -1, y: -1, width: 300, height: 450 };
  const window = {
    getBounds: () => ({ ...bounds }),
    isDestroyed: () => false,
    webContents: { send() {} },
    setPosition(x, y) {
      assert.ok(!Object.is(x, -0) && !Object.is(y, -0), 'Electron 拒绝负零坐标');
      Object.assign(bounds, { x, y });
    },
  };
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1200, height: 800 } };
  const screen = { getDisplayMatching: () => display, getDisplayNearestPoint: () => display };
  const motion = createPetMotion(window, screen, () => {}, () => ({ x: 150, y: 0 }));
  t.after(() => motion.stop());
  motion.start();
  motion.end();
  t.mock.timers.tick(96);
  assert.equal(bounds.x, 0);
  assert.equal(bounds.y, 0);
  t.mock.timers.tick(200);
  assert.equal(motion.pose().edge, 'top');
});

test('拖过双屏接缝一点仍贴原屏，继续深入可换屏，反向也一样', () => {
  const main = { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 900 }, workArea: { x: 0, y: 0, width: 1600, height: 860 } };
  const side = { id: 2, bounds: { x: 1600, y: -180, width: 1920, height: 1080 }, workArea: { x: 1600, y: -180, width: 1920, height: 1040 } };
  const near = { x: 1608, y: 450 };
  const bounds = { x: 1350, y: 230, width: 300, height: 450 };
  const retained = dragDisplay(near, main, side);
  assert.equal(retained, main);
  assert.deepEqual(dockTarget(near, retained.workArea, bounds), { edge: 'right', x: 1300, y: 247.5 });
  assert.equal(dragDisplay({ x: 1680, y: 450 }, main, side), side);
  assert.equal(dragDisplay({ x: 1593, y: 450 }, side, main), side);
  assert.equal(dragDisplay({ x: 1608, y: -80 }, main, side), side);
});
