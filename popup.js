document.addEventListener('DOMContentLoaded', () => {
  const startReadingBtn = document.getElementById('startReadingBtn');
  const apiKeySection = document.getElementById('apiKeySection');
  const apiKeySavedBadge = document.getElementById('apiKeySavedBadge');
  const apiKeyInput = document.getElementById('apiKey');
  const changeKeyBtn = document.getElementById('changeKeyBtn');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  chrome.storage.local.get(['gcpApiKey'], (result) => {
    if (result.gcpApiKey) {
      apiKeySection.classList.add('hidden');
      apiKeySavedBadge.classList.remove('hidden');
    } else {
      apiKeySection.classList.remove('hidden');
      apiKeySavedBadge.classList.add('hidden');
    }
  });

  changeKeyBtn.addEventListener('click', () => {
    apiKeySection.classList.remove('hidden');
    apiKeySavedBadge.classList.add('hidden');
  });

  saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      statusDiv.style.color = '#d93025';
      statusDiv.textContent = 'שגיאה: יש להזין מפתח תקין';
      return;
    }

    chrome.storage.local.set({ gcpApiKey: key }, () => {
      statusDiv.style.color = '#1e8e3e';
      statusDiv.textContent = 'המפתח נשמר!';
      setTimeout(() => {
        statusDiv.textContent = '';
        apiKeySection.classList.add('hidden');
        apiKeySavedBadge.classList.remove('hidden');
      }, 1000);
    });
  });

  startReadingBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: initializePagePlayer
    });
    window.close();
  });
});

function initializePagePlayer() {
  if (window.__aiGlobalAudio) {
    try {
      window.__aiGlobalAudio.pause();
      window.__aiGlobalAudio.src = '';
      window.__aiGlobalAudio.load();
    } catch (e) {}
  }

  const oldBar = document.getElementById('ai-reader-float-bar');
  if (oldBar) oldBar.remove();

  window.__aiGlobalAudio = new Audio();
  const audio = window.__aiGlobalAudio;

  let paragraphs = [];
  let currentIndex = 0;
  let currentSpeed = 1.0;
  let isPageReady = false;
  let currentPlaySession = 0;
  const audioCache = new Map();
  const errorCache = new Map();

  const bar = document.createElement('div');
  bar.id = 'ai-reader-float-bar';
  bar.innerHTML = `
    <style>
      #ai-reader-float-bar {
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
        background: #202124; color: white; padding: 8px 16px;
        border-radius: 40px; display: flex; align-items: center; gap: 8px;
        box-shadow: 0 4px 18px rgba(0,0,0,0.35); font-family: system-ui, sans-serif;
        direction: rtl; user-select: none;
        width: auto;
        max-width: 90vw;
        transition: max-width 0.3s ease;
      }
      #ai-reader-float-bar button {
        background: transparent; border: none; color: white;
        cursor: pointer; font-size: 15px; padding: 6px 8px; border-radius: 20px;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      #ai-reader-float-bar button:disabled { opacity: 0.4; cursor: not-allowed; }
      #ai-reader-float-bar button:hover:not(:disabled) { background: rgba(255,255,255,0.2); }
      .speed-container {
        display: flex; align-items: center; gap: 6px;
        background: rgba(255,255,255,0.1); padding: 4px 10px;
        border-radius: 20px; font-size: 12px;
        flex-shrink: 0;
      }
      .speed-container input[type="range"] {
        width: 65px; cursor: pointer; accent-color: #1a73e8; margin: 0;
      }
      .ai-reading-highlight {
        background-color: #ffe082 !important;
        color: #000000 !important;
        transition: background-color 0.3s ease;
        border-radius: 4px;
      }
      .ai-clickable-para {
        cursor: pointer !important;
      }
      .ai-clickable-para:hover {
        outline: 2px dashed #1a73e8;
      }
      #aiReaderStatus {
        font-size: 12px;
        margin: 0 6px;
        white-space: normal;
        word-break: break-word;
        line-height: 1.3;
      }
    </style>
    <button id="aiBtnNextPara" title="פסקה הבאה" disabled>⏭</button>
    <button id="aiBtnForward" title="10 שניות קדימה" disabled>+10 ⏩</button>
    <button id="aiBtnPlayPause" title="נגן/השהה" style="font-size: 20px;" disabled>⏳</button>
    <button id="aiBtnRewind" title="10 שניות אחורה" disabled>⏪ 10-</button>
    <button id="aiBtnPrevPara" title="פסקה קודמת" disabled>⏮</button>
    
    <div class="speed-container">
      <span id="aiSpeedBadge">1.0x</span>
      <input type="range" id="aiSpeedSlider" min="0.5" max="2.0" step="0.1" value="1.0">
    </div>

    <span id="aiReaderStatus">טוען עמוד...</span>
    <button id="aiBtnClose" title="סגור נגן">✖</button>
  `;
  document.body.appendChild(bar);

  const btnPlayPause = bar.querySelector('#aiBtnPlayPause');
  const btnForward = bar.querySelector('#aiBtnForward');
  const btnRewind = bar.querySelector('#aiBtnRewind');
  const btnNextPara = bar.querySelector('#aiBtnNextPara');
  const btnPrevPara = bar.querySelector('#aiBtnPrevPara');
  const btnClose = bar.querySelector('#aiBtnClose');
  const statusSpan = bar.querySelector('#aiReaderStatus');
  const speedSlider = bar.querySelector('#aiSpeedSlider');
  const speedBadge = bar.querySelector('#aiSpeedBadge');

  speedSlider.addEventListener('input', () => {
    currentSpeed = parseFloat(speedSlider.value);
    speedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
    audio.playbackRate = currentSpeed;
  });

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
    });

    paragraphs = Array.from(new Set(paragraphs));
  }

  function fetchAudioForPara(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: "synthesize",
        text: text
      }, (response) => {
        if (response && response.audioContent) {
          resolve({ ok: true, src: `data:audio/mp3;base64,${response.audioContent}` });
        } else {
          const rawErr = response?.error || "תגובה לא ידועה";
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

  async function preloadEntirePage() {
    statusSpan.textContent = `מכין 0/${paragraphs.length}...`;
    let completedCount = 0;

    const loadTasks = paragraphs.map(async (el, index) => {
      const res = await fetchAudioForPara(el.innerText.trim());
      if (res.ok) {
        audioCache.set(index, res.src);
      } else {
        errorCache.set(index, res.error);
      }
      completedCount++;
      statusSpan.textContent = `מכין ${completedCount}/${paragraphs.length}...`;
    });

    await Promise.all(loadTasks);

    isPageReady = true;
    btnPlayPause.disabled = false;
    btnForward.disabled = false;
    btnRewind.disabled = false;
    btnNextPara.disabled = false;
    btnPrevPara.disabled = false;

    paragraphs.forEach((el, index) => {
      el.classList.add('ai-clickable-para');
      el.title = 'לחץ להשמעת פסקה זו';
      el.onclick = (e) => {
        e.stopPropagation();
        if (isPageReady) playIndex(index);
      };
    });

    playIndex(0);
  }

  function clearHighlight() {
    paragraphs.forEach(p => p.classList.remove('ai-reading-highlight'));
  }

  async function playIndex(index) {
    if (index < 0 || index >= paragraphs.length) return;

    currentPlaySession++;
    const sessionId = currentPlaySession;

    currentIndex = index;
    clearHighlight();
    audio.pause();

    const targetEl = paragraphs[currentIndex];
    targetEl.classList.add('ai-reading-highlight');
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    let audioSrc = audioCache.get(currentIndex);

    if (!audioSrc) {
      statusSpan.style.color = '#ffffff';
      statusSpan.textContent = `מנסה שוב פסקה ${currentIndex + 1}...`;
      const retryRes = await fetchAudioForPara(targetEl.innerText.trim());
      if (retryRes.ok) {
        audioSrc = retryRes.src;
        audioCache.set(currentIndex, audioSrc);
        errorCache.delete(currentIndex);
      } else {
        errorCache.set(currentIndex, retryRes.error);
      }
    }

    if (sessionId !== currentPlaySession) return;

    if (audioSrc) {
      statusSpan.style.color = '#ffffff';
      statusSpan.textContent = `פסקה ${currentIndex + 1}/${paragraphs.length}`;
      audio.src = audioSrc;
      audio.playbackRate = currentSpeed;

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          if (sessionId === currentPlaySession) {
            btnPlayPause.textContent = '⏸';
          } else {
            audio.pause();
          }
        }).catch(() => {});
      }
    } else {
      const specificError = errorCache.get(currentIndex) || "תקלה לא ידועה";
      console.error(`שגיאה בפסקה ${currentIndex + 1}:`, specificError);
      statusSpan.style.color = '#ff8a80';
      statusSpan.textContent = `שגיאה (${currentIndex + 1}): ${specificError}`;
      btnPlayPause.textContent = '▶';
    }
  }

  audio.onended = () => {
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
    currentPlaySession++;
    audio.pause();
    audio.src = '';
    clearHighlight();
    paragraphs.forEach(p => {
      p.classList.remove('ai-clickable-para');
      p.onclick = null;
    });
    bar.remove();
    window.__aiGlobalAudio = null;
  };

  scanParagraphs();
  if (paragraphs.length > 0) {
    preloadEntirePage();
  } else {
    statusSpan.textContent = 'לא נמצא טקסט';
  }
}