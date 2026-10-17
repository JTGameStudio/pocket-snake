// Classic deferred scripts load in order; initialize after all helpers are defined.
resizeBackground();
resetGame();
updateInterface();
showPanel('menu');

// Movement uses its own timer. This loop draws the game and decorative backgrounds.
function animateFrame(now) {
  if (!document.hidden && now - previousFrameTime > 30) {
    let dt = Math.min(0.05, (now - previousFrameTime) / 1000);
    previousFrameTime = now;
    renderBackground(now);
    if (getElement('menu').classList.contains('hidden') && getElement('ranking').classList.contains('hidden')) renderGame(dt, now);
  }
  requestAnimationFrame(animateFrame);
}
requestAnimationFrame(animateFrame);
