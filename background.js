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