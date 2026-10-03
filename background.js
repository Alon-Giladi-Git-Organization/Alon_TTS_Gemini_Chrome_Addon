const HARDCODED_API_KEY = "";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "synthesize") {
    handleSynthesize(request.text).then(sendResponse);
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
  const match = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
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

        // פירוק גוף המסמך למחרוזות טקסט של פסקאות
        (data.body?.content || []).forEach(element => {
          if (element.paragraph) {
            let pText = "";
            (element.paragraph.elements || []).forEach(el => {
              if (el.textRun?.content) {
                pText += el.textRun.content;
              }
            });
            pText = pText.trim();
            if (pText.length > 5) {
              extractedParagraphs.push(pText);
            }
          }
        });

        resolve({ paragraphs: extractedParagraphs });
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  });
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