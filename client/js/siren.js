// Emergency siren generated with the Web Audio API (no audio files needed).
// Browsers only allow sound after the user has interacted with the page, so the
// portal "arms" the siren on the first click / key press.
const Siren = (() => {
  let ctx = null;
  let master = null;
  let loop = null;
  let playing = false;

  function arm() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;                      // loud
      const comp = ctx.createDynamicsCompressor();  // keeps it loud without clipping
      master.connect(comp); comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx.state !== 'closed';
  }

  const armed = () => !!ctx && ctx.state === 'running';

  // One "wail" cycle: two detuned sawtooth oscillators sweeping 650 → 1450 → 650 Hz
  function wail(start) {
    const dur = 1.4;
    for (const detune of [0, 7]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.detune.value = detune * 100;
      osc.frequency.setValueAtTime(650, start);
      osc.frequency.linearRampToValueAtTime(1450, start + dur / 2);
      osc.frequency.linearRampToValueAtTime(650, start + dur);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.35, start + 0.05);
      g.gain.setValueAtTime(0.35, start + dur - 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g); g.connect(master);
      osc.start(start); osc.stop(start + dur + 0.02);
    }
    // high "beep-beep" alert tone on top so it cuts through a noisy room
    for (let i = 0; i < 2; i++) {
      const b = ctx.createOscillator(); const bg = ctx.createGain();
      b.type = 'square'; b.frequency.value = 1760;
      const t = start + dur + 0.08 + i * 0.22;
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      b.connect(bg); bg.connect(master); b.start(t); b.stop(t + 0.18);
    }
  }

  function start() {
    if (!armed() || playing) return false;
    playing = true;
    const cycle = () => wail(ctx.currentTime + 0.02);
    cycle();
    loop = setInterval(cycle, 2000);
    return true;
  }

  function stop() {
    playing = false;
    clearInterval(loop);
    loop = null;
    if (master && ctx) {               // cut anything still ringing
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.gain.setValueAtTime(0.9, ctx.currentTime + 0.3);
    }
  }

  // Spoken announcement after the siren (e.g. "Critical trauma, ambulance 11 minutes away")
  function announce(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05; u.volume = 1; u.lang = 'en-IN';
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch { /* optional */ }
  }

  return { arm, armed, start, stop, announce, isPlaying: () => playing };
})();
