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
    if (!tab || !tab.id) return;

    startReadingBtn.disabled = true;
    statusDiv.style.color = '#202124';
    statusDiv.textContent = 'מתחיל...';

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'startReading',
        tabId: tab.id,
        url: tab.url || ''
      });

      if (response && response.error) {
        statusDiv.style.color = '#d93025';
        statusDiv.textContent = response.error;
        startReadingBtn.disabled = false;
        return;
      }

      window.close();
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (message.toLowerCase().includes('port closed')) return;
      statusDiv.style.color = '#d93025';
      statusDiv.textContent = 'לא הצלחתי להתחיל את ההקראה';
      startReadingBtn.disabled = false;
    }
  });
});
