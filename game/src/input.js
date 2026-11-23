// Keyboard and mouse, read as a small state object. Keys are recorded by `code` so the layout
// does not matter; the mouse is tracked in logical game pixels (the canvas scales to the window).
// One-shot presses (enter a car, fire, pause) are latched until the frame that consumes them, so a
// 60 Hz simulation never misses a tap between steps.

const MOVE = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

export function createInput(canvas, view) {
  const held = new Set();
  const pressed = new Set();
  const mouse = { x: view.w / 2, y: view.h / 2, down: false, clicked: false, wheel: 0, inside: true };

  const idOf = (e) => e.code || e.key;

  const toLogical = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / Math.max(1, rect.width)) * view.w;
    mouse.y = ((clientY - rect.top) / Math.max(1, rect.height)) * view.h;
  };

  canvas.addEventListener('mousemove', (e) => toLogical(e.clientX, e.clientY));
  canvas.addEventListener('mouseenter', () => (mouse.inside = true));
  canvas.addEventListener('mouseleave', () => (mouse.inside = false));
  canvas.addEventListener('mousedown', (e) => {
    toLogical(e.clientX, e.clientY);
    if (e.button === 0) {
      mouse.down = true;
      mouse.clicked = true;
    }
    e.preventDefault();
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouse.down = false;
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      mouse.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.repeat) {
      if (e.code === 'Space') e.preventDefault();
      return;
    }
    held.add(idOf(e));
    pressed.add(idOf(e));
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    // The audio context may only start from a real gesture.
    if (input.onGesture) input.onGesture();
  });
  window.addEventListener('keyup', (e) => held.delete(idOf(e)));
  window.addEventListener('blur', () => {
    held.clear();
    mouse.down = false;
  });

  const input = {
    onGesture: null,
    mouse,
    /** Whether a key code is held. */
    down: (code) => held.has(code),
    /** Whether a key code was pressed since the last endFrame. */
    hit: (code) => pressed.has(code),
    /** Consume every latched press this frame (called once per frame, after the UI reads it). */
    endFrame() {
      pressed.clear();
      mouse.clicked = false;
      mouse.wheel = 0;
    },
    /** Movement axes in [-1, 1], from WASD and the arrows. */
    axis() {
      let x = 0;
      let y = 0;
      for (const code of held) {
        const dir = MOVE[code];
        if (dir === 'up') y -= 1;
        else if (dir === 'down') y += 1;
        else if (dir === 'left') x -= 1;
        else if (dir === 'right') x += 1;
      }
      return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    },
    /** Take one latched press, so two systems never both act on it. */
    take(code) {
      if (!pressed.has(code)) return false;
      pressed.delete(code);
      return true;
    },
    anyKey: () => pressed.size > 0,
    releaseAll() {
      held.clear();
      pressed.clear();
      mouse.down = false;
    },
  };
  return input;
}
