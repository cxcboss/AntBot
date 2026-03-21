const form = document.querySelector('#process-form');
const voiceSelect = document.querySelector('#voice-select');
const submitBtn = document.querySelector('#submit-btn');
const voiceHint = document.querySelector('#voice-hint');
const dubAudioFileInput = document.querySelector('#dub-audio-file');
const ttsModeSelect = document.querySelector('#tts-mode');
const cloneProfileSelect = document.querySelector('#clone-profile-select');
const cloneLanguageSelect = document.querySelector('#clone-language');
const originalAudioLevel = document.querySelector('#original-audio-level');
const originalAudioValue = document.querySelector('#original-audio-value');
const dubAudioLevel = document.querySelector('#dub-audio-level');
const dubAudioValue = document.querySelector('#dub-audio-value');

const cloneForm = document.querySelector('#clone-form');
const cloneSubmitBtn = document.querySelector('#clone-submit-btn');
const cloneStatusText = document.querySelector('#clone-status-text');

const statusPanel = document.querySelector('#status-panel');
const statusText = document.querySelector('#status-text');
const resultPanel = document.querySelector('#result-panel');
const resultVideo = document.querySelector('#result-video');
const resultTrack = document.querySelector('#result-track');
const downloadLink = document.querySelector('#download-link');
let baseVoiceHint = '';

function setStatus(message, isError = false) {
  statusPanel.classList.remove('hidden');
  statusText.textContent = message;
  statusText.classList.toggle('error', isError);
}

function setCloneStatus(message, isError = false) {
  cloneStatusText.textContent = message;
  cloneStatusText.classList.toggle('error', isError);
}

function syncRangeValue() {
  originalAudioValue.textContent = `${originalAudioLevel.value}%`;
  dubAudioValue.textContent = `${dubAudioLevel.value}%`;
}

function updateCloneProfileOptions(profiles, selectedId = '') {
  cloneProfileSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = profiles.length > 0 ? '请选择克隆档案' : '暂无克隆档案';
  cloneProfileSelect.append(placeholder);

  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} (${profile.language})`;
    if (selectedId && profile.id === selectedId) {
      option.selected = true;
    }
    cloneProfileSelect.append(option);
  }
}

async function loadVoices() {
  const resp = await fetch('/api/voices');
  const data = await resp.json();

  voiceSelect.innerHTML = '';
  for (const [voiceId, voiceName] of Object.entries(data.voices)) {
    const option = document.createElement('option');
    option.value = voiceId;
    option.textContent = `${voiceName} (${voiceId})`;
    if (voiceId === data.defaultVoice) {
      option.selected = true;
    }
    voiceSelect.append(option);
  }

  baseVoiceHint = data.voiceHint || '';
  voiceHint.textContent = baseVoiceHint;
}

async function loadCloneProfiles() {
  const resp = await fetch('/api/voice-clone/status');
  const data = await resp.json();

  if (!data.available) {
    updateCloneProfileOptions([]);
    setCloneStatus(data.message || '语音克隆后端不可用', true);
    return;
  }

  updateCloneProfileOptions(Array.isArray(data.profiles) ? data.profiles : []);
  setCloneStatus(data.message || '语音克隆后端已连接');
}

function syncDubMode() {
  const hasExternalDub = dubAudioFileInput.files && dubAudioFileInput.files.length > 0;
  const usingClone = ttsModeSelect.value === 'voice_clone';

  ttsModeSelect.disabled = hasExternalDub;
  cloneProfileSelect.disabled = hasExternalDub || !usingClone;
  cloneLanguageSelect.disabled = hasExternalDub || !usingClone;
  voiceSelect.disabled = hasExternalDub || usingClone;
  form.elements.rate.disabled = hasExternalDub || usingClone;

  if (hasExternalDub) {
    voiceHint.textContent = '已选择外部配音文件：将跳过系统 TTS/语音克隆。';
  } else if (usingClone) {
    voiceHint.textContent = '当前使用语音克隆档案进行配音。';
  } else {
    voiceHint.textContent = baseVoiceHint;
  }
}

async function handleCloneCreate(event) {
  event.preventDefault();
  cloneSubmitBtn.disabled = true;
  setCloneStatus('正在创建克隆档案，请稍候...');

  try {
    const formData = new FormData(cloneForm);
    const resp = await fetch('/api/voice-clone/create', {
      method: 'POST',
      body: formData,
    });
    const data = await resp.json();

    if (!resp.ok || !data.ok) {
      throw new Error(data.error || '创建克隆档案失败');
    }

    await loadCloneProfiles();
    if (data.profile && data.profile.id) {
      cloneProfileSelect.value = data.profile.id;
      ttsModeSelect.value = 'voice_clone';
      syncDubMode();
    }
    setCloneStatus('克隆档案创建成功。');
  } catch (error) {
    setCloneStatus(error instanceof Error ? error.message : '创建克隆档案失败', true);
  } finally {
    cloneSubmitBtn.disabled = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  resultPanel.classList.add('hidden');
  setStatus('正在处理，请稍候（长视频可能需要几分钟）...');

  try {
    const formData = new FormData(form);
    const hasExternalDub = dubAudioFileInput.files && dubAudioFileInput.files.length > 0;
    const usingClone = ttsModeSelect.value === 'voice_clone' && !hasExternalDub;

    if (usingClone && !String(formData.get('clone_profile_id') || '').trim()) {
      throw new Error('请选择一个克隆档案。');
    }

    const resp = await fetch('/api/process', {
      method: 'POST',
      body: formData,
    });

    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || '处理失败');
    }

    const outputUrl = data.outputUrl;
    const subtitleUrl = data.subtitleUrl;
    resultVideo.src = outputUrl;
    if (subtitleUrl) {
      resultTrack.src = subtitleUrl;
      resultTrack.default = true;
    } else {
      resultTrack.removeAttribute('src');
    }
    downloadLink.href = outputUrl;
    downloadLink.textContent = '下载结果视频';
    resultVideo.load();

    if (resultVideo.textTracks && resultVideo.textTracks[0]) {
      resultVideo.textTracks[0].mode = 'showing';
    }

    resultPanel.classList.remove('hidden');

    let sourceText = '已使用系统 TTS 生成配音。';
    if (data.dubSource === 'external') sourceText = '已使用外部配音音频。';
    if (data.dubSource === 'voice_clone') sourceText = '已使用语音克隆档案生成配音。';

    if (data.subtitleMode === 'soft-track') {
      setStatus(`处理完成。${sourceText} 当前环境不支持硬字幕，已自动提供可显示字幕轨。`);
    } else {
      setStatus(`处理完成。${sourceText}`);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '未知错误', true);
  } finally {
    submitBtn.disabled = false;
  }
});

cloneForm.addEventListener('submit', handleCloneCreate);
originalAudioLevel.addEventListener('input', syncRangeValue);
dubAudioLevel.addEventListener('input', syncRangeValue);
dubAudioFileInput.addEventListener('change', syncDubMode);
ttsModeSelect.addEventListener('change', syncDubMode);

syncRangeValue();
Promise.all([loadVoices(), loadCloneProfiles()])
  .then(() => syncDubMode())
  .catch((error) => {
    setStatus(error instanceof Error ? error.message : '初始化失败', true);
  });
