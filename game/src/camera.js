// The follow camera: it trails the player with critically damped smoothing, leans toward where the
// player is heading (look-ahead), pulls back with speed, and shakes on impacts. It never shows the
// void: the view is clamped to the world and the zoom eases in and out.
//
// `camera.angle` is the direction the camera is looking (the player's heading, smoothed), which the
// police AI uses to decide what the player can and cannot see.

import { VIEW } from './config.js';
import { clamp, damp, dampAngle, dist, lerp } from './util.js';

export function createCamera(city) {
  return {
    x: city.spawn.x,
    y: city.spawn.y,
    zoom: 1,
    angle: 0,
    shakeAmount: 0,
    shakeTime: 0,
    offsetX: 0,
    offsetY: 0,
    lookX: 0,
    lookY: 0,
    targetZoom: 1,
    bounds: city.bounds,
    /** Shake the view for a moment. */
    shake(amount) {
      this.shakeAmount = Math.min(18, Math.max(this.shakeAmount, amount));
      this.shakeTime = 0.32;
    },
    /** Jump straight to the target (used on respawn and by the screenshot staging). */
    snap(x, y, zoom = this.zoom) {
      this.x = x;
      this.y = y;
      this.zoom = zoom;
      this.lookX = 0;
      this.lookY = 0;
      this.shakeAmount = 0;
      this.clampToWorld();
    },
    clampToWorld() {
      const halfW = VIEW.w / (2 * this.zoom);
      const halfH = VIEW.h / (2 * this.zoom);
      const b = this.bounds;
      if (b.x1 - b.x0 > halfW * 2) this.x = clamp(this.x, b.x0 + halfW, b.x1 - halfW);
      else this.x = (b.x0 + b.x1) / 2;
      if (b.y1 - b.y0 > halfH * 2) this.y = clamp(this.y, b.y0 + halfH, b.y1 - halfH);
      else this.y = (b.y0 + b.y1) / 2;
    },
  };
}

/**
 * Advance the camera toward the focus point. `focus` is {x,y,angle,speed}; speed drives the zoom
 * (walking is close, a fast car is wide) and the look-ahead along the heading.
 */
export function updateCamera(camera, focus, dt, opts = {}) {
  const speed = opts.speed ?? 0;
  const speedNorm = clamp(speed / 430, 0, 1);
  // Look-ahead: where the player is going, capped so a spin does not whip the view.
  const ahead = opts.foot ? 26 : 40 + speedNorm * 150;
  const targetLookX = Math.cos(focus.angle) * ahead;
  const targetLookY = Math.sin(focus.angle) * ahead;
  camera.lookX = damp(camera.lookX, targetLookX, 3.2, dt);
  camera.lookY = damp(camera.lookY, targetLookY, 3.2, dt);

  const tx = focus.x + camera.lookX;
  const ty = focus.y + camera.lookY;
  camera.x = damp(camera.x, tx, opts.foot ? 7.2 : 4.4, dt);
  camera.y = damp(camera.y, ty, opts.foot ? 7.2 : 4.4, dt);
  camera.angle = dampAngle(camera.angle, focus.angle, 2.2, dt);

  // Zoom: a little out for speed, a touch in while aiming.
  let zoom = 1 - speedNorm * 0.2;
  if (opts.aiming) zoom += 0.11;
  if (opts.zoom !== undefined) zoom = opts.zoom;
  camera.zoom = damp(camera.zoom, zoom, 2.4, dt);
  camera.clampToWorld();

  // Shake: a decaying wobble, not random jitter.
  if (camera.shakeTime > 0) {
    camera.shakeTime -= dt;
    camera.shakeAmount *= Math.exp(-7 * dt);
    const t = camera.shakeTime * 46;
    camera.offsetX = Math.cos(t * 1.7) * camera.shakeAmount;
    camera.offsetY = Math.sin(t * 2.3) * camera.shakeAmount;
    if (camera.shakeTime <= 0) {
      camera.shakeAmount = 0;
      camera.offsetX = 0;
      camera.offsetY = 0;
    }
  }
}

/** The camera's final translation: focus plus shake. */
export function cameraOffset(camera) {
  return { x: camera.x + camera.offsetX, y: camera.y + camera.offsetY };
}

/**
 * The view rect the renderer culls against, plus a margin for tall buildings whose roof is drawn
 * far above their footprint.
 */
export function viewRect(camera, margin = 140) {
  const halfW = VIEW.w / (2 * camera.zoom);
  const halfH = VIEW.h / (2 * camera.zoom);
  const ox = camera.x + camera.offsetX;
  const oy = camera.y + camera.offsetY;
  return {
    x0: ox - halfW - margin,
    x1: ox + halfW + margin,
    y0: oy - halfH - margin,
    y1: oy + halfH + margin,
    ox,
    oy,
  };
}

/** Screen point for a world point, at the camera's zoom. */
export function worldToScreen(camera, x, y, view) {
  return {
    x: (x - camera.x - camera.offsetX) * camera.zoom + view.w / 2,
    y: (y - camera.y - camera.offsetY) * camera.zoom + view.h / 2,
  };
}

export function screenToWorld(camera, x, y, view) {
  return {
    x: (x - view.w / 2) / camera.zoom + camera.x + camera.offsetX,
    y: (y - view.h / 2) / camera.zoom + camera.y + camera.offsetY,
  };
}

export { dist, lerp };
