// =========================================================
// SONS DOMUS — biblioteca de sons assinatura
// =========================================================
// Sons sintetizados via Web Audio API. Cada um é gerado em
// tempo real (sem MP3, sem download), com caráter próprio.
//
// Uso:
//   import { tocarSomDomus, SONS } from '/sons-domus.js';
//   tocarSomDomus('domus');   // som assinatura
//   tocarSomDomus('drop');    // gota d'água
//   tocarSomDomus('pixie');   // ding alegre
//   tocarSomDomus('chime');   // sino japonês
//   tocarSomDomus('bossa');   // 3 notas jazz
//
// Volume global:
//   window.SOM_DOMUS_VOLUME = 0.6;   // 0 = mudo, 1 = max
// =========================================================

(function () {
  'use strict';

  // Volume global (0 a 1)
  window.SOM_DOMUS_VOLUME = window.SOM_DOMUS_VOLUME ?? 0.5;

  // AudioContext único — só cria depois da primeira interação do usuário
  // (browser bloqueia áudio antes de gesture de usuário)
  let _ctx = null;
  function ctx() {
    if (!_ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      _ctx = new C();
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  // --------- HELPER: tocar uma "nota" simples ---------
  // freq: Hz (ex: 880 = A5)
  // duracao: segundos
  // delay: segundos pra começar (relativo a agora)
  // tipo: 'sine' (suave), 'triangle' (médio), 'square' (duro), 'sawtooth' (rico)
  // ataque: subida do volume em segundos (0.01 = instantâneo)
  // decay: descida do volume em segundos
  // vol: volume da nota (0-1)
  function nota({ freq = 880, duracao = 0.3, delay = 0, tipo = 'sine', ataque = 0.01, decay = 0.3, vol = 0.3 } = {}) {
    const c = ctx();
    if (!c) return;
    const t = c.currentTime + delay;
    const masterVol = (typeof window.SOM_DOMUS_VOLUME === 'number') ? window.SOM_DOMUS_VOLUME : 0.5;

    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = tipo;
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(c.destination);

    // Envelope ADSR simplificado: silêncio → pico → silêncio
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol * masterVol, t + ataque);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ataque + decay);

    osc.start(t);
    osc.stop(t + duracao);
  }

  // --------- HELPER: reverb sutil (efeito "casa Domus") ---------
  // Adiciona uma cauda pra sensação de ambiente
  function notaComReverb(opts) {
    nota(opts);
    // Eco discreto 80ms depois, mais grave e baixo
    nota({
      ...opts,
      delay: (opts.delay || 0) + 0.08,
      vol: (opts.vol || 0.3) * 0.35,
      freq: (opts.freq || 880) * 0.5
    });
  }

  // =====================================================
  // SONS — cada um tem assinatura própria
  // =====================================================

  // 🌿 DOMUS — som ASSINATURA da casa
  // Três notas em harmonia maior (Mi-Sol-Si), suaves, acolhedoras.
  // É a "voz" da Domus tocando um sino.
  function domus() {
    notaComReverb({ freq: 659.25, duracao: 0.6, delay: 0,     tipo: 'sine', ataque: 0.02, decay: 0.55, vol: 0.32 }); // Mi5
    notaComReverb({ freq: 783.99, duracao: 0.6, delay: 0.10,  tipo: 'sine', ataque: 0.02, decay: 0.55, vol: 0.28 }); // Sol5
    notaComReverb({ freq: 987.77, duracao: 0.7, delay: 0.22,  tipo: 'sine', ataque: 0.02, decay: 0.65, vol: 0.24 }); // Si5
  }

  // 💧 DROP — gota d'água
  // Uma nota descendente curta, tipo plip.
  function drop() {
    const c = ctx();
    if (!c) return;
    const t = c.currentTime;
    const masterVol = window.SOM_DOMUS_VOLUME || 0.5;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    // Pitch slide de 1200Hz pra 600Hz em 0.15s = sensação de gota
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.15);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.4 * masterVol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // ✨ PIXIE — ding alegre e curto
  // Duas notas rápidas em quinta justa (do-sol), tipo iMessage.
  function pixie() {
    nota({ freq: 1046.5, duracao: 0.18, delay: 0,    tipo: 'triangle', ataque: 0.005, decay: 0.17, vol: 0.35 }); // Do6
    nota({ freq: 1567.98, duracao: 0.22, delay: 0.08, tipo: 'triangle', ataque: 0.005, decay: 0.21, vol: 0.30 }); // Sol6
  }

  // 🎐 CHIME — sino japonês (wind chime)
  // Duas notas suaves em quarta justa, longas, com reverb.
  function chime() {
    notaComReverb({ freq: 880,    duracao: 1.0, delay: 0,    tipo: 'sine', ataque: 0.03, decay: 0.95, vol: 0.30 }); // La5
    notaComReverb({ freq: 1174.66, duracao: 1.2, delay: 0.25, tipo: 'sine', ataque: 0.03, decay: 1.15, vol: 0.25 }); // Ré6
  }

  // 🎵 BOSSA — 3 notas tipo bossa nova
  // Acorde maior 7 quebrado (Do-Mi-Sol-Si) com timing humano.
  function bossa() {
    nota({ freq: 523.25, duracao: 0.35, delay: 0,    tipo: 'triangle', ataque: 0.01, decay: 0.33, vol: 0.28 }); // Do5
    nota({ freq: 659.25, duracao: 0.35, delay: 0.09, tipo: 'triangle', ataque: 0.01, decay: 0.33, vol: 0.26 }); // Mi5
    nota({ freq: 783.99, duracao: 0.40, delay: 0.18, tipo: 'triangle', ataque: 0.01, decay: 0.38, vol: 0.24 }); // Sol5
    nota({ freq: 987.77, duracao: 0.50, delay: 0.30, tipo: 'sine',     ataque: 0.02, decay: 0.47, vol: 0.20 }); // Si5
  }

  // 🌱 GARDEN — pássaro discreto + folha (experimental)
  // Som mais orgânico, leve trinado.
  function garden() {
    const c = ctx();
    if (!c) return;
    const t = c.currentTime;
    const masterVol = window.SOM_DOMUS_VOLUME || 0.5;
    // 2 notas rápidas tipo passarinho
    [0, 0.08].forEach((d, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      const f0 = i === 0 ? 1800 : 2200;
      osc.frequency.setValueAtTime(f0, t + d);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + d + 0.09);
      gain.gain.setValueAtTime(0, t + d);
      gain.gain.linearRampToValueAtTime(0.18 * masterVol, t + d + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.10);
      osc.connect(gain).connect(c.destination);
      osc.start(t + d);
      osc.stop(t + d + 0.12);
    });
  }

  // =====================================================
  // CATÁLOGO público + função de tocar
  // =====================================================

  const SONS = {
    domus:  { nome: 'Domus 🌿',      descricao: 'Sino acolhedor em harmonia maior — o som da casa',           toca: domus },
    drop:   { nome: 'Gota 💧',       descricao: 'Plip elegante, descendente',                                 toca: drop },
    pixie:  { nome: 'Pixie ✨',      descricao: 'Ding alegre tipo iMessage — leve e direto',                  toca: pixie },
    chime:  { nome: 'Sino Japonês 🎐', descricao: 'Duas notas suaves, longas, com reverberação',              toca: chime },
    bossa:  { nome: 'Bossa 🎵',      descricao: 'Quatro notas em acorde maior 7 — brasileiro e calmo',       toca: bossa },
    garden: { nome: 'Jardim 🌱',     descricao: 'Trinado discreto de passarinho',                            toca: garden }
  };

  function tocarSomDomus(nome) {
    const s = SONS[nome] || SONS.domus;
    try { s.toca(); } catch (e) { console.warn('[sons-domus]', e); }
  }

  // Exporta no escopo global
  window.SONS_DOMUS = SONS;
  window.tocarSomDomus = tocarSomDomus;
})();
