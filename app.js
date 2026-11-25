(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const powerBtn = $('power');
  const powerLabel = $('powerLabel');
  const powerSub = $('powerSub');
  const statusEl = $('status');
  const volumeEl = $('volume');
  const volumeValue = $('volumeValue');
  const noiseEl = $('noise');
  const meterBar = $('meterBar');
  const meterPeak = $('meterPeak');
  const clipNote = $('clipNote');
  const errorBox = $('errorBox');

  const AudioCtx = window.AudioContext || window.webkitAudioContext;

  let ctx = null;          // AudioContext (created on tap)
  let stream = null;       // MicrophoneStream
  let srcNode = null;
  let gainNode = null;
  let compNode = null;
  let limitNode = null;
  let analyser = null;
  let meterBuf = null;

  let running = false;
  let busy = false;
  let rafId = 0;
  let wakeLock = null;
  let peak = 0;
  let peakTime = 0;
  let clipUntil = 0;

  // ---------- UI helpers ----------
  function setStatus(text) { statusEl.textContent = text; }

  function showError(text) {
    errorBox.textContent = text || '';
    errorBox.hidden = !text;
  }

  function setVolumeLabel() {
    volumeValue.textContent = volumeEl.value + '%';
  }

  function renderPower() {
    powerBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
    powerLabel.textContent = running ? 'ON' : 'OFF';
    powerSub.textContent = running ? 'タップで停止' : 'タップで開始';
    powerBtn.disabled = busy;
  }

  // ---------- Error messages (Japanese) ----------
  function describeError(e) {
    const name = (e && e.name) || '';
    if (!window.isSecureContext) {
      return 'マイクは https:// で開いたときだけ使えます。\n対処：GitHub Pages の公開URL（https）から開き直してください。';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'マイクの使用が許可されていません。\n' +
        '対処：iPhone は「設定」アプリ → 使っているブラウザ（Safari など）→「マイク」を「許可」にしてください。\n' +
        'Android は Chrome のアドレスバー左のアイコン（または︙→設定→サイトの設定）からマイクを「許可」にしてください。\n' +
        '許可したら、もう一度ボタンを押してください。';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'マイクが見つかりません。\n対処：イヤホンやマイクの接続を確認してから、もう一度お試しください。';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'マイクが他のアプリで使われているようです。\n対処：電話やビデオ通話などを終えてから、もう一度お試しください。';
    }
    return '音声を開始できませんでした。（' + (name || 'unknown') + '）\n対処：ページを開き直してから、もう一度お試しください。';
  }

  // ---------- Audio ----------
  function getMicStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: noiseEl.checked,
        channelCount: 1
      },
      video: false
    });
  }

  function buildGraph() {
    gainNode = ctx.createGain();
    gainNode.gain.value = Number(volumeEl.value) / 100;

    // 音割れ防止：コンプレッサー（大きい声を押さえる）→ リミッター（出力の上限）
    compNode = ctx.createDynamicsCompressor();
    compNode.threshold.value = -24;
    compNode.knee.value = 12;
    compNode.ratio.value = 4;
    compNode.attack.value = 0.003;
    compNode.release.value = 0.25;

    limitNode = ctx.createDynamicsCompressor();
    limitNode.threshold.value = -1;
    limitNode.knee.value = 0;
    limitNode.ratio.value = 20;
    limitNode.attack.value = 0.001;
    limitNode.release.value = 0.1;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    meterBuf = new Float32Array(analyser.fftSize);

    gainNode.connect(compNode);
    compNode.connect(limitNode);
    limitNode.connect(ctx.destination);
    limitNode.connect(analyser); // メーターは出力される音量を表示
  }

  function connectStream(s) {
    srcNode = ctx.createMediaStreamSource(s);
    srcNode.connect(gainNode);
  }

  function disconnectStream() {
    if (srcNode) {
      try { srcNode.disconnect(); } catch (_) { /* ignore */ }
      srcNode = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  async function start() {
    if (busy || running) return;
    showError('');

    if (!AudioCtx) {
      showError('このブラウザは音声処理に対応していません。SafariかChromeで開いてください。');
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError(describeError({ name: window.isSecureContext ? '' : 'insecure' }));
      return;
    }

    busy = true;
    renderPower();
    setStatus('準備しています…');

    try {
      // Safari対策：AudioContext はタップの中で作り、すぐ resume する
      if (!ctx) {
        ctx = new AudioCtx({ latencyHint: 'interactive' });
        buildGraph();
      }
      const resumed = ctx.resume();
      stream = await getMicStream();
      await resumed;
      connectStream(stream);

      running = true;
      setStatus('話せます。つないだスピーカーから声が出ています');
      startMeter();
      acquireWakeLock();
    } catch (e) {
      disconnectStream();
      if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
      setStatus('停止中。ボタンを押すと話せます');
      showError(describeError(e));
    } finally {
      busy = false;
      renderPower();
    }
  }

  async function stop() {
    if (busy || !running) return;
    running = false;
    cancelAnimationFrame(rafId);
    disconnectStream();
    releaseWakeLock();
    meterBar.style.width = '0%';
    meterPeak.style.left = '0%';
    clipNote.textContent = '';
    if (ctx && ctx.state === 'running') {
      try { await ctx.suspend(); } catch (_) { /* ignore */ }
    }
    setStatus('停止中。ボタンを押すと話せます');
    renderPower();
  }

  // 雑音を減らす の切り替え：マイクを取り直す
  async function onNoiseChange() {
    if (!running || busy) return;
    busy = true;
    renderPower();
    noiseEl.disabled = true;
    try {
      disconnectStream();
      stream = await getMicStream();
      connectStream(stream);
    } catch (e) {
      running = false;
      cancelAnimationFrame(rafId);
      releaseWakeLock();
      setStatus('停止しました');
      showError(describeError(e));
    } finally {
      busy = false;
      noiseEl.disabled = false;
      renderPower();
    }
  }

  // ---------- Meter ----------
  function startMeter() {
    cancelAnimationFrame(rafId);
    const loop = (now) => {
      if (!running) return;
      analyser.getFloatTimeDomainData(meterBuf);
      let sum = 0;
      let max = 0;
      for (let i = 0; i < meterBuf.length; i++) {
        const v = meterBuf[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > max) max = a;
      }
      const rms = Math.sqrt(sum / meterBuf.length);
      // -60dB〜0dB を 0〜100% に割り当てる
      const db = 20 * Math.log10(rms + 1e-9);
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

      meterBar.style.width = pct.toFixed(1) + '%';
      meterBar.className = 'meter-bar' + (pct > 85 ? ' high' : pct > 65 ? ' mid' : '');

      // ピーク表示（少しずつ落ちてくる）
      if (pct >= peak || now - peakTime > 1200) {
        peak = pct;
        peakTime = now;
      }
      meterPeak.style.left = Math.max(0, Math.min(99, peak)).toFixed(1) + '%';

      // 音割れ警告（出力が上限付近に達したら一瞬表示）
      if (max > 0.97) clipUntil = now + 800;
      clipNote.textContent = now < clipUntil ? '音が大きすぎます' : '';

      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  // ---------- Volume ----------
  volumeEl.addEventListener('input', () => {
    setVolumeLabel();
    if (gainNode) gainNode.gain.setTargetAtTime(Number(volumeEl.value) / 100, ctx.currentTime, 0.02);
  });

  // ---------- Wake Lock（画面を消さない） ----------
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) {
      // 非対応や拒否の場合は無視（音声は続きます）
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running) {
      acquireWakeLock();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  });

  // ---------- Events ----------
  powerBtn.addEventListener('click', () => {
    if (running) stop();
    else start();
  });

  noiseEl.addEventListener('change', onNoiseChange);

  setVolumeLabel();
  renderPower();

  // ---------- Service Worker（オフラインで開けるように） ----------
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
