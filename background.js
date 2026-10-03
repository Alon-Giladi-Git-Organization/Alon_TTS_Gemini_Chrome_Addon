const HARDCODED_API_KEY = "";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "synthesize") {
    handleSynthesize(request.text).then(sendResponse);
    return true;
  }

  if (request.action === "startReading") {
    startReading(request.tabId, request.url).then(
      (result) => {
        try { sendResponse(result); } catch (e) {}
      },
      (err) => {
        try { sendResponse({ error: err.message }); } catch (e) {}
      }
    );
    return true;
  }
});

function getVoiceConfig(text) {
  const isHebrew = /[\u0590-\u05FF]/.test(text);
  if (isHebrew) {
    return { languageCode: 'he-IL', name: 'he-IL-Wavenet-A' };
  }
  return { languageCode: 'en-US', name: 'en-US-Journey-F' };
}

// חילוץ מזהה המסמך מתוך הכתובת ב-Google Docs
function getGoogleDocId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'docs.google.com') return null;
    const match = parsed.pathname.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function collectParagraphsFromElements(elements, bucket) {
  (elements || []).forEach((element) => {
    if (element.paragraph) {
      let pText = '';
      (element.paragraph.elements || []).forEach((el) => {
        if (el.textRun && el.textRun.content) {
          pText += el.textRun.content;
        }
      });
      pText = pText.replace(/\s+/g, ' ').trim();
      if (pText) bucket.push(pText);
    }

    if (element.table) {
      (element.table.tableRows || []).forEach((row) => {
        (row.tableCells || []).forEach((cell) => {
          collectParagraphsFromElements(cell.content, bucket);
        });
      });
    }

    if (element.tableOfContents) {
      collectParagraphsFromElements(element.tableOfContents.content, bucket);
    }
  });
}

function splitLongText(text) {
  const limit = 1400;
  if (text.length <= limit) return [text];

  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const windowText = rest.slice(0, limit);
    let cut = Math.max(
      windowText.lastIndexOf('. '),
      windowText.lastIndexOf('! '),
      windowText.lastIndexOf('? '),
      windowText.lastIndexOf(' ')
    );
    if (cut < limit * 0.4) cut = limit;
    const piece = rest.slice(0, cut + 1).trim();
    if (piece) parts.push(piece);
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function expandParagraphs(paragraphs) {
  return paragraphs.flatMap((text) => splitLongText(text));
}

function shortenError(raw) {
  const text = String(raw || '');
  let message = text;
  try {
    const obj = JSON.parse(text);
    if (obj.error && obj.error.message) message = obj.error.message;
  } catch (e) {}

  const lower = message.toLowerCase();
  if (lower.includes('permission') || lower.includes('forbidden') || text.includes('403')) {
    return 'החשבון שמחובר לכרום לא יכול לפתוח את המסמך הזה';
  }
  if (lower.includes('not been used') || lower.includes('accessnotconfigured') || lower.includes('service_disabled')) {
    return 'שירות המסמכים של גוגל לא מופעל בפרויקט';
  }
  if (lower.includes('oauth') || lower.includes('invalid_client') || lower.includes('bad client')) {
    return 'ההתחברות לגוגל לא מוגדרת נכון בתוסף';
  }
  if (!message) return 'לא הצלחתי לקרוא את המסמך';
  if (message.length > 180) return message.slice(0, 180) + '…';
  return message;
}

async function showOnPage(tabId, payload) {
  await chrome.tabs.sendMessage(tabId, Object.assign({ action: 'startPlayer' }, payload));
}

// שליפת תוכן הפסקאות ישירות מ-Google Docs API
async function fetchGoogleDocParagraphs(docId) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        return resolve({ error: chrome.runtime.lastError?.message || "אימות OAuth נכשל" });
      }

      try {
        const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (!res.ok) {
          const errData = await res.text();
          return resolve({ error: errData });
        }

        const data = await res.json();
        const extractedParagraphs = [];

        collectParagraphsFromElements(data.body && data.body.content, extractedParagraphs);

        if (data.footnotes) {
          Object.keys(data.footnotes).forEach((key) => {
            collectParagraphsFromElements(data.footnotes[key].content, extractedParagraphs);
          });
        }

        resolve({ paragraphs: extractedParagraphs });
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  });
}

async function fetchGoogleDocViaExport(tabId, docId) {
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      args: [docId],
      func: async (id) => {
        try {
          const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=txt`, {
            credentials: 'include',
            cache: 'no-store'
          });
          const text = await res.text();
          return {
            ok: res.ok,
            status: res.status,
            type: res.headers.get('content-type') || '',
            text: text
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      }
    });

    const result = injected && injected.result;
    if (!result || !result.ok || !result.text) {
      return { error: (result && result.error) || 'לא הצלחתי לייצא את המסמך' };
    }

    const type = String(result.type || '').toLowerCase();
    const trimmed = String(result.text).replace(/^\uFEFF/, '').trim();
    if (type.includes('text/html') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
      return { error: 'גוגל החזיר דף כניסה במקום את הטקסט של המסמך' };
    }

    const paragraphs = trimmed
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (!paragraphs.length) {
      return { error: 'המסמך ריק' };
    }

    return { paragraphs: paragraphs };
  } catch (err) {
    return { error: err.message };
  }
}

async function readGoogleDoc(tabId, docId) {
  await showOnPage(tabId, { loadingMessage: 'קורא את המסמך...' });

  const exported = await fetchGoogleDocViaExport(tabId, docId);
  if (exported.paragraphs && exported.paragraphs.length) {
    return { paragraphs: expandParagraphs(exported.paragraphs) };
  }

  await showOnPage(tabId, { loadingMessage: 'מבקש אישור מגוגל...' });
  const apiResult = await fetchGoogleDocParagraphs(docId);
  if (apiResult.paragraphs && apiResult.paragraphs.length) {
    return { paragraphs: expandParagraphs(apiResult.paragraphs) };
  }

  return { error: shortenError(apiResult.error || exported.error) };
}

async function startReading(tabId, url) {
  if (!tabId) {
    return { error: 'לא נמצא דף פתוח' };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['page-player.js']
    });
  } catch (err) {
    return { error: 'אי אפשר להפעיל את הנגן בדף הזה' };
  }

  const docId = getGoogleDocId(url || '');
  if (!docId) {
    try {
      await showOnPage(tabId, {});
    } catch (err) {
      return { error: 'הדף לא מוכן להקראה' };
    }
    return { ok: true };
  }

  try {
    const doc = await readGoogleDoc(tabId, docId);
    if (doc.error) {
      await showOnPage(tabId, { error: doc.error });
      return { error: doc.error };
    }

    await showOnPage(tabId, { paragraphs: doc.paragraphs });
    return { ok: true, count: doc.paragraphs.length };
  } catch (err) {
    const message = shortenError(err.message);
    try {
      await showOnPage(tabId, { error: message });
    } catch (e) {}
    return { error: message };
  }
}

async function handleSynthesize(text) {
  const settings = await chrome.storage.local.get(['gcpApiKey']);
  const apiKey = HARDCODED_API_KEY || settings.gcpApiKey;

  if (!apiKey) {
    return { error: "חסר מפתח API. הזן אותו בחלונית התוסף." };
  }

  const voice = getVoiceConfig(text);
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

  const requestBody = {
    input: { text: text },
    voice: { languageCode: voice.languageCode, name: voice.name },
    audioConfig: { audioEncoding: 'MP3' }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      return { error: errText };
    }

    const data = await response.json();
    return { audioContent: data.audioContent };
  } catch (err) {
    return { error: err.message };
  }
}