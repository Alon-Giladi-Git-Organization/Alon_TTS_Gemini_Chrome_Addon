if (!window.__aiPageReaderListening) {
  window.__aiPageReaderListening = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === 'startPlayer' && window.__aiReaderStart) {
      window.__aiReaderStart(message);
      sendResponse({ ok: true });
    }
  });
}

window.__aiReaderStart = function startPlayer(options) {
  const settings = options || {};

  if (window.__aiGlobalAudio) {
    try {
      window.__aiGlobalAudio.onended = null;
      window.__aiGlobalAudio.pause();
      window.__aiGlobalAudio.src = '';
      window.__aiGlobalAudio.load();
    } catch (e) {}
  }

  const oldBar = document.getElementById('ai-reader-float-bar');
  if (oldBar) oldBar.remove();

  window.__aiReaderGeneration = (window.__aiReaderGeneration || 0) + 1;
  const generation = window.__aiReaderGeneration;

  window.__aiGlobalAudio = new Audio();
  const audio = window.__aiGlobalAudio;

  let paragraphs = [];
  let currentIndex = 0;
  let currentSpeed = 1.0;
  let isPageReady = false;
  let currentPlaySession = 0;
  const audioCache = new Map();
  const errorCache = new Map();
  const prefetching = new Set();

  const bar = document.createElement('div');
  bar.id = 'ai-reader-float-bar';
  bar.style.position = 'fixed';
  bar.style.bottom = '20px';
  bar.style.right = '20px';
  bar.style.zIndex = '2147483647';
  bar.style.background = '#202124';
  bar.style.color = 'white';
  bar.style.padding = '8px 16px';
  bar.style.borderRadius = '40px';
  bar.style.display = 'flex';
  bar.style.alignItems = 'center';
  bar.style.gap = '8px';
  bar.style.boxShadow = '0 4px 18px rgba(0,0,0,0.35)';
  bar.style.fontFamily = 'system-ui, sans-serif';
  bar.style.direction = 'rtl';
  bar.style.userSelect = 'none';
  bar.style.width = 'auto';
  bar.style.maxWidth = '90vw';

  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `
    .ai-reading-highlight {
      background-color: #ffe082 !important;
      color: #000000 !important;
      transition: background-color 0.3s ease;
      border-radius: 4px;
    }
    .ai-clickable-para { cursor: pointer !important; }
    .ai-clickable-para:hover { outline: 2px dashed #1a73e8; }
  `;
  bar.appendChild(highlightStyle);

  function makeButton(id, title, label, disabled) {
    const button = document.createElement('button');
    button.id = id;
    button.title = title;
    button.textContent = label;
    button.disabled = disabled;
    button.style.background = 'transparent';
    button.style.border = 'none';
    button.style.color = 'white';
    button.style.cursor = 'pointer';
    button.style.fontSize = '15px';
    button.style.padding = '6px 8px';
    button.style.borderRadius = '20px';
    button.style.display = 'flex';
    button.style.alignItems = 'center';
    button.style.justifyContent = 'center';
    button.style.flexShrink = '0';
    button.style.opacity = disabled ? '0.4' : '1';
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) button.style.background = 'rgba(255,255,255,0.2)';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = 'transparent';
    });
    return button;
  }

  const btnNextPara = makeButton('aiBtnNextPara', 'פסקה הבאה', '⏭', true);
  const btnForward = makeButton('aiBtnForward', '10 שניות קדימה', '+10 ⏩', true);
  const btnPlayPause = makeButton('aiBtnPlayPause', 'נגן/השהה', '⏳', true);
  const btnRewind = makeButton('aiBtnRewind', '10 שניות אחורה', '⏪ 10-', true);
  const btnPrevPara = makeButton('aiBtnPrevPara', 'פסקה קודמת', '⏮', true);
  btnPlayPause.style.fontSize = '20px';

  const speedWrap = document.createElement('div');
  speedWrap.style.display = 'flex';
  speedWrap.style.alignItems = 'center';
  speedWrap.style.gap = '6px';
  speedWrap.style.background = 'rgba(255,255,255,0.1)';
  speedWrap.style.padding = '4px 10px';
  speedWrap.style.borderRadius = '20px';
  speedWrap.style.fontSize = '12px';
  speedWrap.style.flexShrink = '0';

  const speedBadge = document.createElement('span');
  speedBadge.id = 'aiSpeedBadge';
  speedBadge.textContent = '1.0x';

  const speedSlider = document.createElement('input');
  speedSlider.id = 'aiSpeedSlider';
  speedSlider.type = 'range';
  speedSlider.min = '0.5';
  speedSlider.max = '2.0';
  speedSlider.step = '0.1';
  speedSlider.value = '1.0';
  speedSlider.style.width = '65px';
  speedSlider.style.cursor = 'pointer';
  speedSlider.style.accentColor = '#1a73e8';
  speedSlider.style.margin = '0';
  speedWrap.appendChild(speedBadge);
  speedWrap.appendChild(speedSlider);

  const statusSpan = document.createElement('span');
  statusSpan.id = 'aiReaderStatus';
  statusSpan.textContent = 'טוען עמוד...';
  statusSpan.style.fontSize = '12px';
  statusSpan.style.margin = '0 6px';
  statusSpan.style.whiteSpace = 'normal';
  statusSpan.style.wordBreak = 'break-word';
  statusSpan.style.lineHeight = '1.3';
  statusSpan.style.maxWidth = '280px';

  const btnClose = makeButton('aiBtnClose', 'סגור נגן', '✖', false);

  bar.appendChild(btnNextPara);
  bar.appendChild(btnForward);
  bar.appendChild(btnPlayPause);
  bar.appendChild(btnRewind);
  bar.appendChild(btnPrevPara);
  bar.appendChild(speedWrap);
  bar.appendChild(statusSpan);
  bar.appendChild(btnClose);
  document.documentElement.appendChild(bar);

  speedSlider.addEventListener('input', () => {
    currentSpeed = parseFloat(speedSlider.value);
    speedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
    audio.playbackRate = currentSpeed;
  });

  function enableButtons() {
    [btnPlayPause, btnForward, btnRewind, btnNextPara, btnPrevPara].forEach((button) => {
      button.disabled = false;
      button.style.opacity = '1';
      button.style.cursor = 'pointer';
    });
  }

  function isCurrentRun() {
    return generation === window.__aiReaderGeneration;
  }

  function snippet(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= 48) return clean;
    return clean.slice(0, 48) + '…';
  }

  function scanParagraphs() {
    const primaryBlocks = Array.from(document.querySelectorAll(
      'p, li, h1, h2, h3, h4, h5, h6, blockquote, dt, dd'
    ));

    const genericContainers = Array.from(document.querySelectorAll('div, td, article, section')).filter(el => {
      if (bar.contains(el)) return false;
      const hasInternalBlock = el.querySelector('p, li, h1, h2, h3, h4, h5, h6, blockquote');
      return !hasInternalBlock;
    });

    const allCandidates = [...primaryBlocks, ...genericContainers];

    paragraphs = allCandidates.filter(el => {
      if (bar.contains(el) || el === bar) return false;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }

      const text = el.innerText ? el.innerText.trim() : '';
      return text.length > 20;
    }).map(el => ({
      text: el.innerText.trim(),
      el: el
    }));

    const seen = new Set();
    paragraphs = paragraphs.filter(item => {
      if (seen.has(item.el)) return false;
      seen.add(item.el);
      return true;
    });
  }

  function fetchAudioForPara(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'synthesize',
        text: text
      }, (response) => {
        if (response && response.audioContent) {
          resolve({ ok: true, src: `data:audio/mp3;base64,${response.audioContent}` });
        } else {
          const rawErr = response?.error || 'תגובה לא ידועה';
          let parsedMsg = rawErr;
          try {
            const errObj = JSON.parse(rawErr);
            if (errObj.error && errObj.error.message) {
              parsedMsg = errObj.error.message;
            }
          } catch (e) {}
          resolve({ ok: false, error: parsedMsg });
        }
      });
    });
  }

  function prefetch(index) {
    if (!isCurrentRun()) return;
    if (index < 0 || index >= paragraphs.length) return;
    if (audioCache.has(index) || prefetching.has(index)) return;

    prefetching.add(index);
    const text = paragraphs[index].text;
    fetchAudioForPara(text).then((res) => {
      prefetching.delete(index);
      if (!isCurrentRun()) return;
      if (res.ok) {
        audioCache.set(index, res.src);
        errorCache.delete(index);
      }
    });
  }

  async function preloadEntirePage() {
    statusSpan.textContent = `מכין 0/${paragraphs.length}...`;
    let completedCount = 0;

    const loadTasks = paragraphs.map(async (item, index) => {
      const res = await fetchAudioForPara(item.text);
      if (!isCurrentRun()) return;
      if (res.ok) {
        audioCache.set(index, res.src);
      } else {
        errorCache.set(index, res.error);
      }
      completedCount++;
      statusSpan.textContent = `מכין ${completedCount}/${paragraphs.length}...`;
    });

    await Promise.all(loadTasks);
    if (!isCurrentRun()) return;

    isPageReady = true;
    enableButtons();

    paragraphs.forEach((item, index) => {
      if (!item.el) return;
      item.el.classList.add('ai-clickable-para');
      item.el.title = 'לחץ להשמעת פסקה זו';
      item.el.onclick = (e) => {
        e.stopPropagation();
        if (isPageReady) playIndex(index);
      };
    });

    playIndex(0);
  }

  function clearHighlight() {
    paragraphs.forEach(item => {
      if (item.el) item.el.classList.remove('ai-reading-highlight');
    });
  }

  function showParagraphStatus(index) {
    const item = paragraphs[index];
    const position = `פסקה ${index + 1}/${paragraphs.length}`;
    if (item.el) {
      statusSpan.textContent = position;
      return;
    }
    statusSpan.textContent = `${position}: ${snippet(item.text)}`;
  }

  async function playIndex(index) {
    if (!isCurrentRun()) return;
    if (index < 0 || index >= paragraphs.length) return;

    currentPlaySession++;
    const sessionId = currentPlaySession;

    currentIndex = index;
    clearHighlight();
    audio.pause();
    prefetch(index + 1);

    const target = paragraphs[currentIndex];
    if (target.el) {
      target.el.classList.add('ai-reading-highlight');
      target.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    let audioSrc = audioCache.get(currentIndex);

    if (!audioSrc) {
      statusSpan.style.color = '#ffffff';
      statusSpan.textContent = `מנסה פסקה ${currentIndex + 1}/${paragraphs.length}...`;
      const retryRes = await fetchAudioForPara(target.text);
      if (!isCurrentRun() || sessionId !== currentPlaySession) return;
      if (retryRes.ok) {
        audioSrc = retryRes.src;
        audioCache.set(currentIndex, audioSrc);
        errorCache.delete(currentIndex);
      } else {
        errorCache.set(currentIndex, retryRes.error);
      }
    }

    if (!isCurrentRun() || sessionId !== currentPlaySession) return;

    if (audioSrc) {
      statusSpan.style.color = '#ffffff';
      showParagraphStatus(currentIndex);
      audio.src = audioSrc;
      audio.playbackRate = currentSpeed;
      btnPlayPause.textContent = '▶';

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          if (sessionId === currentPlaySession && isCurrentRun()) {
            btnPlayPause.textContent = '⏸';
          } else {
            audio.pause();
          }
        }).catch(() => {});
      }
    } else {
      const specificError = errorCache.get(currentIndex) || 'תקלה לא ידועה';
      console.error(`שגיאה בפסקה ${currentIndex + 1}:`, specificError);
      statusSpan.style.color = '#ff8a80';
      statusSpan.textContent = `שגיאה (${currentIndex + 1}): ${specificError}`;
      btnPlayPause.textContent = '▶';
    }
  }

  audio.onended = () => {
    if (!isCurrentRun()) return;
    if (currentIndex + 1 < paragraphs.length) {
      playIndex(currentIndex + 1);
    } else {
      clearHighlight();
      statusSpan.style.color = '#ffffff';
      statusSpan.textContent = 'הסתיים';
      btnPlayPause.textContent = '▶';
    }
  };

  btnPlayPause.onclick = (e) => {
    e.stopPropagation();
    if (!isPageReady) return;

    if (audio.paused) {
      audio.play();
      btnPlayPause.textContent = '⏸';
    } else {
      audio.pause();
      btnPlayPause.textContent = '▶';
    }
  };

  btnForward.onclick = (e) => {
    e.stopPropagation();
    if (!isPageReady) return;
    if (audio.currentTime + 10 >= (audio.duration || 0)) {
      playIndex(currentIndex + 1);
    } else {
      audio.currentTime += 10;
    }
  };

  btnRewind.onclick = (e) => {
    e.stopPropagation();
    if (!isPageReady) return;
    if (audio.currentTime - 10 <= 0 && currentIndex > 0) {
      playIndex(currentIndex - 1);
    } else {
      audio.currentTime = Math.max(0, audio.currentTime - 10);
    }
  };

  btnNextPara.onclick = (e) => {
    e.stopPropagation();
    if (isPageReady && currentIndex + 1 < paragraphs.length) playIndex(currentIndex + 1);
  };

  btnPrevPara.onclick = (e) => {
    e.stopPropagation();
    if (isPageReady && currentIndex > 0) playIndex(currentIndex - 1);
  };

  btnClose.onclick = (e) => {
    e.stopPropagation();
    window.__aiReaderGeneration = (window.__aiReaderGeneration || 0) + 1;
    currentPlaySession++;
    audio.onended = null;
    audio.pause();
    audio.src = '';
    clearHighlight();
    paragraphs.forEach(item => {
      if (!item.el) return;
      item.el.classList.remove('ai-clickable-para');
      item.el.onclick = null;
    });
    bar.remove();
    window.__aiGlobalAudio = null;
  };

  if (settings.loadingMessage) {
    statusSpan.textContent = settings.loadingMessage;
    return;
  }

  if (settings.error) {
    statusSpan.style.color = '#ff8a80';
    statusSpan.textContent = settings.error;
    btnPlayPause.textContent = '⚠';
    return;
  }

  if (Array.isArray(settings.paragraphs)) {
    paragraphs = settings.paragraphs
      .map(text => String(text || '').trim())
      .filter(text => text.length > 0)
      .map(text => ({ text: text, el: null }));

    if (!paragraphs.length) {
      statusSpan.textContent = 'לא נמצא טקסט';
      return;
    }

    bar.style.flexWrap = 'wrap';
    bar.style.maxWidth = '460px';
    bar.style.borderRadius = '24px';
    isPageReady = true;
    enableButtons();
    playIndex(0);
    return;
  }

  scanParagraphs();
  if (paragraphs.length > 0) {
    preloadEntirePage();
  } else {
    statusSpan.textContent = 'לא נמצא טקסט';
  }
};
