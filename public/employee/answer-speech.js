let speechPanel;

export function stopAnswerSpeech() {
  speechPanel?.stop();
}

export function mountAnswerSpeech(slot, context, version, text, focused) {
  const key = slot && JSON.stringify([context, version, text]);
  if (speechPanel && speechPanel.key !== key) {
    speechPanel.stop();
    speechPanel = null;
  }
  if (!slot) return;
  speechPanel ??= createSpeechPanel(key, version, text);
  slot.append(speechPanel.element);
  if (speechPanel.element.contains(focused)) focused.focus({preventScroll:true});
}

function createSpeechPanel(key, version, text) {
  const element = document.createElement("div");
  element.className = "answer-speech";
  element.innerHTML = '<button type="button" class="secondary" aria-describedby="speechScope">読み上げ</button>' +
    '<div><small id="speechScope" class="meta"></small><small class="meta" role="status"></small></div>';
  const control = element.querySelector("button");
  const scope = element.querySelector("#speechScope");
  const status = element.querySelector('[role="status"]');
  scope.textContent = `端末内で処理 · 第${version}版の本文のみ`;

  const synth = window.speechSynthesis;
  const unavailable = "端末内の読み上げを利用できません。本文はそのまま読めます。";
  const failed = "読み上げを開始または継続できませんでした。本文はそのまま読めます。";
  let playback;

  function stop(message = "読み上げを停止しました。") {
    if (!playback) return;
    playback = null;
    synth.cancel();
    control.textContent = "読み上げ";
    status.textContent = message;
  }

  if (!synth || typeof window.SpeechSynthesisUtterance !== "function") {
    control.disabled = true;
    status.textContent = unavailable;
    return {key, element, stop};
  }
  // Some browsers populate the voice list asynchronously. Only a fresh user action can start speech.
  synth.getVoices();
  control.addEventListener("click", event => {
    if (!event.isTrusted) return;
    if (playback) {
      stop();
      return;
    }

    const language = document.documentElement.lang.toLowerCase().split("-")[0];
    const voices = synth.getVoices().filter(voice => voice.localService === true &&
      voice.lang.toLowerCase().split("-")[0] === language);
    const voice = voices.find(candidate => candidate.default) ?? voices[0];
    if (!voice) {
      status.textContent = unavailable;
      return;
    }

    // Small utterances keep long answers playable and avoid queueing the entire answer at once.
    const chunks = (text.match(/[^\n。！？!?]{1,120}[。！？!?]*|[。！？!?]+/gu) ?? [])
      .filter(part => part.trim());
    const run = playback = {hash:location.hash, index:0};
    control.textContent = "読み上げを停止";
    status.textContent = `準備中 · ${voice.name}`;

    function speakNext() {
      if (playback !== run) return;
      if (!element.isConnected || document.hidden || location.hash !== run.hash) {
        stop();
        return;
      }
      const part = chunks[run.index++];
      if (part === undefined) {
        playback = null;
        control.textContent = "読み上げ";
        status.textContent = `読み上げが完了しました · ${voice.name}`;
        return;
      }
      if (!synth.getVoices().some(candidate => candidate.localService === true &&
        candidate.voiceURI === voice.voiceURI && candidate.lang === voice.lang)) {
        stop(unavailable);
        return;
      }
      try {
        const utterance = new SpeechSynthesisUtterance(part);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.onstart = () => {
          if (playback === run) status.textContent = `読み上げ中 · ${voice.name}`;
        };
        utterance.onend = speakNext;
        utterance.onerror = () => { if (playback === run) stop(failed); };
        synth.speak(utterance);
      } catch {
        stop(failed);
      }
    }
    speakNext();
  });
  return {key, element, stop};
}
