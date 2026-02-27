import * as THREE from "three";
import state from "./state.js";
import { updateCamera, cameraFrustum } from "./camera.js";
import { updateScreenSize, getViewports, getSplitViewports, getDividerRect, getAnimatedViewports } from "./viewport.js";
import { animateVehiclesOnline } from "./map.js";
import { animateExplosion, explodeAllVehicles } from "./explosion.js";
import { animatePlayer, hitTest } from "./movement.js";
import { updateMotorSound } from "./audio/vehicle-audio.js";
import { checkHonks } from "./audio/honk.js";
import { updateNightLights } from "./scene.js";

export function animate(): void {
  updateScreenSize();
  if (state.renderer.domElement.clientWidth !== state.screenW || state.renderer.domElement.clientHeight !== state.screenH) {
    state.renderer.setSize(state.screenW, state.screenH);
  }

  state.timer.update();
  const delta = state.timer.getDelta();

  if (state.pendingExplosion) {
    state.pendingExplosion = false;
    state.vehicleExplosionTimer = 0;
  }
  if (state.vehicleExplosionTimer !== null) {
    state.vehicleExplosionTimer += delta;
    if (state.vehicleExplosionTimer >= 1.0) {
      explodeAllVehicles();
      state.vehicleExplosionTimer = null;
    }
  }

  animateVehiclesOnline();
  animateExplosion(delta);
  for (let i = 0; i < state.players.length; i++) {
    if (state.players[i]) animatePlayer(i);
  }
  for (const pi of state.localPlayerIndices) {
    if (state.players[pi]) hitTest(pi);
  }
  updateMotorSound();
  updateNightLights();
  checkHonks();

  if (state.splitTransition) {
    state.splitTransition.elapsed += delta;
    if (state.splitTransition.elapsed >= 2) {
      state.splitTransition.progress = Math.min(
        1,
        state.splitTransition.progress + delta * 2,
      );
    }
  }

  const baseDir = state.nightMode ? 0 : 2;
  const hasLocalSplit = state.localPlayerIndices.length > 1;
  const lp0 = state.players[state.localPlayerIndices[0]];
  const lp1 = hasLocalSplit ? state.players[state.localPlayerIndices[1]] : null;
  const bothLocalAlive = lp0 && lp1 && lp0.alive && lp1.alive;
  const lp0x = lp0 ? lp0.mesh.position.x : 0;
  const lp0y = lp0 ? lp0.mesh.position.y : 0;
  const lp1x = lp1 ? lp1.mesh.position.x : 0;
  const lp1y = lp1 ? lp1.mesh.position.y : 0;
  const midX = hasLocalSplit ? (lp0x + lp1x) / 2 : lp0x;
  const midY = hasLocalSplit ? (lp0y + lp1y) / 2 : lp0y;

  if (hasLocalSplit && !state.alwaysSplit && bothLocalAlive && !state.splitTransition) {
    state.sharedCameraTarget.position.x = midX;
    state.sharedCameraTarget.position.y = midY;
    updateCamera(state.sharedCamera, state.screenW, state.screenH);
    state.sharedCameraTarget.updateMatrixWorld(true);
    state.sharedCamera.updateMatrixWorld(true);

    state._p1NDC.copy(lp0.mesh.position).project(state.sharedCamera);
    state._p2NDC.copy(lp1.mesh.position).project(state.sharedCamera);
    const maxExtent = Math.max(
      Math.abs(state._p1NDC.x),
      Math.abs(state._p1NDC.y),
      Math.abs(state._p2NDC.x),
      Math.abs(state._p2NDC.y),
    );

    if (maxExtent > 0.45) state.splitTarget = 1;
    else if (maxExtent < 0.3) state.splitTarget = 0;
  } else if (!hasLocalSplit) {
    state.splitTarget = 0;
  }

  if (hasLocalSplit && state.alwaysSplit) {
    state.splitAmount = 1;
    state.splitTarget = 1;
    state.focusAmount = 1;
  } else if (hasLocalSplit && !state.splitTransition) {
    if (state.splitTarget === 1 && state.splitAmount >= 0.99) {
      state.splitFullTime += delta;
      state.mergeWaitTime = 0;
    } else {
      state.splitFullTime = 0;
    }

    const focusTarget = state.splitFullTime >= 3.0 ? 1 : 0;
    const focusSpeed = 1.5;
    state.focusAmount +=
      (focusTarget - state.focusAmount) * (1 - Math.exp(-focusSpeed * delta));
    if (Math.abs(state.focusAmount - focusTarget) < 0.005)
      state.focusAmount = focusTarget;

    if (state.splitTarget === 1) {
      const splitSpeed = 2.5;
      state.splitAmount +=
        (1 - state.splitAmount) * (1 - Math.exp(-splitSpeed * delta));
      if (Math.abs(state.splitAmount - 1) < 0.005) state.splitAmount = 1;
    } else {
      if (state.focusAmount <= 0.01) {
        state.mergeWaitTime += delta;
      }
      if (state.mergeWaitTime >= 3.0) {
        const splitSpeed = 2.5;
        state.splitAmount +=
          (0 - state.splitAmount) * (1 - Math.exp(-splitSpeed * delta));
        if (Math.abs(state.splitAmount) < 0.005) state.splitAmount = 0;
      }
    }
  } else if (!hasLocalSplit) {
    state.splitAmount = 0;
    state.focusAmount = 0;
  }

  state.splitActive = state.splitAmount > 0.005;

  if (hasLocalSplit && bothLocalAlive && !state.splitTransition) {
    state.sharedCameraTarget.position.x = THREE.MathUtils.lerp(midX, lp0x, state.focusAmount);
    state.sharedCameraTarget.position.y = THREE.MathUtils.lerp(midY, lp0y, state.focusAmount);
    state.newcomerCameraTarget.position.x = THREE.MathUtils.lerp(midX, lp1x, state.focusAmount);
    state.newcomerCameraTarget.position.y = THREE.MathUtils.lerp(midY, lp1y, state.focusAmount);
  }

  if (hasLocalSplit && !state.splitTransition) {
    state.sharedDirLight.intensity = baseDir * (1 - state.focusAmount);
    if (lp0?.dirLight) lp0.dirLight.intensity = baseDir * state.focusAmount;
    if (lp1?.dirLight) lp1.dirLight.intensity = baseDir * state.focusAmount;
  }

  // --- Rendering ---
  const vpPlayers = hasLocalSplit ? [lp1, lp0] : [null, null];

  if (!hasLocalSplit) {
    if (!lp0) return;

    let targetX = lp0.mesh.position.x;
    let targetY = lp0.mesh.position.y;
    if (!lp0.alive && state.deathTime && performance.now() - state.deathTime > 2000) {
      const alive = state.players.filter(p => p && p.alive);
      if (alive.length > 0) {
        const best = alive.reduce((a, b) =>
          b!.position.currentRow > a!.position.currentRow ? b : a
        );
        targetX = best!.mesh.position.x;
        targetY = best!.mesh.position.y;
      }
    }

    const camLerp = 1 - Math.pow(0.05, delta);
    state.sharedCameraTarget.position.x +=
      (targetX - state.sharedCameraTarget.position.x) * camLerp;
    state.sharedCameraTarget.position.y +=
      (targetY - state.sharedCameraTarget.position.y) * camLerp;
    state.renderer.setViewport(0, 0, state.screenW, state.screenH);
    state.renderer.clear();
    updateCamera(state.sharedCamera, state.screenW, state.screenH);
    state.sharedDirLight.intensity = state.nightMode ? 0 : 2;
    state.renderer.render(state.scene, state.sharedCamera);
  } else if (!state.splitActive) {
    state.renderer.setViewport(0, 0, state.screenW, state.screenH);
    state.renderer.clear();
    updateCamera(state.sharedCamera, state.screenW, state.screenH);

    if (state.deathTime && !bothLocalAlive) {
      const aliveLocal = [lp0, lp1].filter(p => p && p.alive);
      const targets = aliveLocal.length > 0 ? aliveLocal : [lp0, lp1].filter(Boolean);
      const dMidX =
        targets.reduce((s, p) => s + p!.mesh.position.x, 0) /
        targets.length;
      const dMidY =
        targets.reduce((s, p) => s + p!.mesh.position.y, 0) /
        targets.length;
      if (performance.now() - state.deathTime > 1000) {
        const camLerp = 1 - Math.pow(0.02, delta);
        state.sharedCameraTarget.position.x +=
          (dMidX - state.sharedCameraTarget.position.x) * camLerp;
        state.sharedCameraTarget.position.y +=
          (dMidY - state.sharedCameraTarget.position.y) * camLerp;
      }
    }

    state.renderer.render(state.scene, state.sharedCamera);
  } else if (state.splitTransition) {
    state.renderer.clear();
    state.renderer.setScissorTest(true);

    const t = state.splitTransition.progress;
    const vps = getAnimatedViewports(t);
    const deadVpIdx = 1 - state.splitTransition.deadPlayer;
    const aliveVpIdx = state.splitTransition.deadPlayer;
    const ps = state.splitTransition.pixelScale;

    state.sharedDirLight.intensity = 0;

    const dvp = vps[deadVpIdx];
    state.renderer.setViewport(dvp.x, dvp.y, dvp.width, dvp.height);
    state.renderer.setScissor(dvp.x, dvp.y, dvp.width, dvp.height);
    state.renderer.clear();
    const dim = 0.3;
    const baseAmbient = state.nightMode ? 0.004 : 1;
    state.ambientLight.intensity = baseAmbient * dim;
    if (lp0?.dirLight) lp0.dirLight.intensity = baseDir * dim;
    if (lp1?.dirLight) lp1.dirLight.intensity = baseDir * dim;
    const deadPlayer = vpPlayers[deadVpIdx];
    if (deadPlayer?.camera) {
      updateCamera(deadPlayer.camera, dvp.width, dvp.height);
      state.renderer.render(state.scene, deadPlayer.camera);
    }
    state.ambientLight.intensity = baseAmbient;
    if (lp0?.dirLight) lp0.dirLight.intensity = baseDir;
    if (lp1?.dirLight) lp1.dirLight.intensity = baseDir;

    const avp = vps[aliveVpIdx];
    state.renderer.setViewport(avp.x, avp.y, avp.width, avp.height);
    state.renderer.setScissor(avp.x, avp.y, avp.width, avp.height);
    state.renderer.clear();
    const alivePlayer = vpPlayers[aliveVpIdx];
    if (alivePlayer?.camera) {
      updateCamera(alivePlayer.camera, avp.width, avp.height, ps);
      state.renderer.render(state.scene, alivePlayer.camera);
    }

    const divRect = getDividerRect(vps, aliveVpIdx);
    if (divRect && divRect.width > 0 && divRect.height > 0) {
      state.renderer.setViewport(divRect.x, divRect.y, divRect.width, divRect.height);
      state.renderer.setScissor(divRect.x, divRect.y, divRect.width, divRect.height);
      state.renderer.clear();
      state.renderer.render(state.dividerScene, state.dividerCamera);
    }

    state.renderer.setScissorTest(false);
  } else {
    state.renderer.clear();
    state.renderer.setScissorTest(true);

    const vps = getSplitViewports(state.splitAmount);
    const isLandscape = state.screenW >= state.screenH;
    const targetVps = getViewports();

    const vp1 = vps[1];
    state.renderer.setViewport(vp1.x, vp1.y, vp1.width, vp1.height);
    state.renderer.setScissor(vp1.x, vp1.y, vp1.width, vp1.height);
    updateCamera(state.sharedCamera, vp1.width, vp1.height);
    state.renderer.render(state.scene, state.sharedCamera);

    const vp0 = vps[0];
    if (vp0.width > 1 && vp0.height > 1) {
      const { width: tfw, height: tfh } = cameraFrustum(
        targetVps[0].width,
        targetVps[0].height,
      );
      const ps = isLandscape
        ? tfh / targetVps[0].height
        : tfw / targetVps[0].width;
      state.renderer.setViewport(vp0.x, vp0.y, vp0.width, vp0.height);
      state.renderer.setScissor(vp0.x, vp0.y, vp0.width, vp0.height);
      updateCamera(state.newcomerCamera, vp0.width, vp0.height, ps);
      state.renderer.render(state.scene, state.newcomerCamera);
    }

    let divRect;
    if (isLandscape) {
      const gapX = vp0.x + vp0.width;
      const gapW = vp1.x - gapX;
      divRect =
        gapW > 0
          ? { x: gapX, y: 0, width: gapW, height: state.screenH }
          : null;
    } else {
      const gapY = vp1.y + vp1.height;
      const gapH = vp0.y - gapY;
      divRect =
        gapH > 0
          ? { x: 0, y: gapY, width: state.screenW, height: gapH }
          : null;
    }
    if (divRect && divRect.width > 0 && divRect.height > 0) {
      state.renderer.setViewport(
        divRect.x,
        divRect.y,
        divRect.width,
        divRect.height,
      );
      state.renderer.setScissor(
        divRect.x,
        divRect.y,
        divRect.width,
        divRect.height,
      );
      state.renderer.clear();
      state.renderer.render(state.dividerScene, state.dividerCamera);
    }

    state.renderer.setScissorTest(false);
  }
}
