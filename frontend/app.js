const API_BASE = '';

// Detect file:// access — redirect user
if (location.protocol === 'file:') {
	document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;padding:20px;">
      <div style="max-width:500px;text-align:center;">
        <h2 style="color:#b85c5c;">&#10007; Cannot open directly</h2>
        <p style="color:#6b5d4f;margin:16px 0;font-size:15px;line-height:1.6;">
          This app must be accessed through the backend server.
        </p>
        <ol style="text-align:left;color:#3d3529;font-size:14px;line-height:1.8;">
          <li>Run <code>run_api.bat</code> (or <code>run_api_cpu.bat</code>) — keep it running</li>
          <li>Open your browser to <strong><a href="http://localhost:8000">http://localhost:8000</a></strong></li>
        </ol>
      </div>
    </div>`;
	throw new Error('File protocol detected — use http://localhost:8000');
}

let STATE = 'idle';
let POLL_INTERVAL = null;
let CURRENT_TASK_ID = null;
let CURRENT_AUDIO_URL = null;
let CHUNK_DATA = [];
let GENERATION_PAUSED = false;
let GENERATION_START_TIME = null;
let CURRENT_FILTER = 'all';
let AUTOSAVE_TIMER = null;
let CHUNK_PAGE = 0;
const CHUNK_PER_PAGE = 10;
let CURRENT_VOICE_MODE = 'low';
let CURRENT_VOICE_ID = 'banmai';
let ALL_VOICES = { low: [], medium: [], high: [] };
let VOICE_RATES = { preset: 18, custom: {} };
let PAUSE_CFG = { enabled: true, pauses: { '.': 0.4, ',': 0.2, ';': 0.3, ':': 0.3, '?': 0.4, '!': 0.4, linebreak: 0.6 } };

const QUALITY_LABELS = { low: 'Piper', medium: 'F5', high: 'OmniVoice' };
const QUALITY_BADGE_CLASS = { low: 'piper', medium: 'f5', high: 'omnivoice' };

const textInput = document.getElementById('textInput');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const charCount = document.getElementById('charCount');
const wordCount = document.getElementById('wordCount');
const estDuration = document.getElementById('estDuration');
const estSegments = document.getElementById('estSegments');
const voiceModeToggle = document.getElementById('voiceModeToggle');
const previewBtn = document.getElementById('previewBtn');
const newVoiceBtn = document.getElementById('newVoiceBtn');
const generateBtn = document.getElementById('generateBtn');
const progressFloat = document.getElementById('progressFloat');
const floatFill = document.getElementById('floatFill');
const floatStatus = document.getElementById('floatStatus');
const floatCount = document.getElementById('floatCount');
const floatEta = document.getElementById('floatEta');
const floatCancelBtn = document.getElementById('floatCancelBtn');
const finalAudioBar = document.getElementById('finalAudioBar');
const finalAudioOverlay = document.getElementById('finalAudioOverlay');
const reopenFinalBtn = document.getElementById('reopenFinalBtn');
const audioPlayer = document.getElementById('audioPlayer');
const formatSelect = document.getElementById('formatSelect');
const downloadBtn = document.getElementById('downloadBtn');
const errorDisplay = document.getElementById('errorDisplay');
const chunkList = document.getElementById('chunkList');
const mergeSection = document.getElementById('mergeSection');
const mergeBtn = document.getElementById('mergeBtn');
const resetBtn = document.getElementById('resetBtn');
const chunkCount = document.getElementById('chunkCount');
const chunkPagination = document.getElementById('chunkPagination');
const pagePrev = document.getElementById('pagePrev');
const pageNext = document.getElementById('pageNext');
const pageInfo = document.getElementById('pageInfo');
const segmentFilters = document.getElementById('segmentFilters');
const batchActions = document.getElementById('batchActions');
const autosaveIndicator = document.getElementById('autosaveIndicator');
const autosaveText = document.getElementById('autosaveText');

function showFinalAudio() {
	finalAudioBar.classList.add('visible');
	finalAudioOverlay.classList.add('visible');
	reopenFinalBtn.classList.remove('visible');
}

function hideFinalAudio() {
	finalAudioBar.classList.remove('visible');
	finalAudioOverlay.classList.remove('visible');
	if (CURRENT_AUDIO_URL) reopenFinalBtn.classList.add('visible');
}

// Slider fills
['speedSlider', 'pitchSlider', 'volumeSlider'].forEach(id => {
	const el = document.getElementById(id);
	if (!el) return;
	const valEl = document.getElementById(id.replace('Slider', 'Val'));
	function updateSliderFill() {
		const min = parseFloat(el.min);
		const max = parseFloat(el.max);
		const val = parseFloat(el.value);
		const pct = ((val - min) / (max - min)) * 100;
		el.style.background = `linear-gradient(to right, var(--accent-primary) 0%, var(--accent-primary) ${pct}%, var(--card-border) ${pct}%, var(--card-border) 100%)`;
	}
	el.addEventListener('input', function () {
		const v = this.value;
		if (id === 'speedSlider' && valEl) valEl.textContent = parseFloat(v).toFixed(1) + '×';
		else if (id === 'volumeSlider' && valEl) valEl.textContent = v + ' dB';
		else if (valEl) valEl.textContent = v;
		updateSliderFill();
	});
	updateSliderFill();
});

// Model config sliders
['cfgSlider', 'stepsSlider', 'swaySlider', 'numStepSlider'].forEach(id => {
	const el = document.getElementById(id);
	if (!el) return;
	const valEl = document.getElementById(id.replace('Slider', 'Val'));
	if (!valEl) return;
	el.addEventListener('input', function () {
		valEl.textContent = id === 'cfgSlider' || id === 'swaySlider' ? parseFloat(this.value).toFixed(1) : this.value;
		const min = parseFloat(el.min); const max = parseFloat(el.max);
		const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
		el.style.background = `linear-gradient(to right, var(--accent-primary) 0%, var(--accent-primary) ${pct}%, var(--card-border) ${pct}%, var(--card-border) 100%)`;
	});
	const min = parseFloat(el.min); const max = parseFloat(el.max);
	const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
	el.style.background = `linear-gradient(to right, var(--accent-primary) 0%, var(--accent-primary) ${pct}%, var(--card-border) ${pct}%, var(--card-border) 100%)`;
});

// ─── Multi-file queue ───
let FILE_QUEUE = [];

let _fqSelected = null;
let _fqPage = 0;
const FQ_PER_PAGE = 7;

function _updateGenIndicator() {
	const sel = _fqSelected !== null ? FILE_QUEUE[_fqSelected] : null;
	document.getElementById('fileGenIndicator').textContent = sel ? 'File: ' + sel.name : '';
}

function _saveFileConfig(idx) {
	const f = FILE_QUEUE[idx];
	if (!f) return;
	const mode = document.querySelector('#voiceModeToggle .toggle-btn.active')?.dataset.mode || 'low';
	f.config = {
		voice_mode: mode,
		voice_id: CURRENT_VOICE_ID,
		voice_label: (ALL_VOICES[mode] || []).find(v => v.id === CURRENT_VOICE_ID)?.label || CURRENT_VOICE_ID,
		normalize: document.getElementById('normalizeCheckbox').checked,
		clean: document.getElementById('cleanCheckbox').checked,
		normalize_audio: document.getElementById('normalizeAudioCheckbox').checked,
		split_segments: document.getElementById('splitSegmentsCheckbox').checked,
		split_mode: document.getElementById('splitSegmentsCheckbox').checked ? document.getElementById('splitModeSelect').value : 'default',
		speed: parseFloat(document.getElementById('speedSlider').value),
		pitch: parseFloat(document.getElementById('pitchSlider').value),
		volume: parseFloat(document.getElementById('volumeSlider').value),
	};
	f._configured = true;
	showToast('Config saved for ' + f.name);
	renderFileQueue();
}

function renderFileQueue() {
	const container = document.getElementById('fileQueue');
	if (FILE_QUEUE.length === 0) { container.style.display = 'none'; _updateGenIndicator(); return; }
	container.style.display = '';
	_updateGenIndicator();
	const hasPending = FILE_QUEUE.some(f => f.status === 'pending');
	const totalPages = Math.max(1, Math.ceil(FILE_QUEUE.length / FQ_PER_PAGE));
	if (_fqPage >= totalPages) _fqPage = totalPages - 1;
	const start = _fqPage * FQ_PER_PAGE;
	const pageItems = FILE_QUEUE.slice(start, start + FQ_PER_PAGE);
	container.innerHTML = `
          <div class="fq-header">
            <span>${FILE_QUEUE.length} / ${MAX_QUEUE} files${totalPages > 1 ? ' · Page ' + (_fqPage + 1) + '/' + totalPages : ''}</span>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              ${hasPending ? `<button onclick="for(let i=0;i<FILE_QUEUE.length;i++){if(FILE_QUEUE[i].status==='pending')_saveFileConfig(i)}renderFileQueue();showToast('Config applied to all pending files')" style="background:var(--bg-secondary);color:var(--text-secondary);border-color:var(--card-border);font-size:11px;">Apply to all</button>` : ''}
              ${hasPending ? `<button onclick="processAllFiles()" id="processAllBtn">Process All</button>` : ''}
              ${totalPages > 1 && _fqPage > 0 ? `<button onclick="_fqPage--;renderFileQueue()" style="background:var(--bg-secondary);color:var(--text-secondary);border-color:var(--card-border);font-size:11px;">&#9664;</button>` : ''}
              ${totalPages > 1 && _fqPage < totalPages - 1 ? `<button onclick="_fqPage++;renderFileQueue()" style="background:var(--bg-secondary);color:var(--text-secondary);border-color:var(--card-border);font-size:11px;">&#9654;</button>` : ''}
              <button onclick="FILE_QUEUE=[];_fqSelected=null;renderFileQueue()" style="background:var(--bg-secondary);color:var(--text-secondary);border-color:var(--card-border);">Clear</button>
            </div>
          </div>
          ${pageItems.map((f, i) => {
		const fi = start + i;
		const isSel = _fqSelected === fi;
		const statusLabel = f.status === 'done' ? 'Done' : f.status === 'processing' ? 'Processing...' : f.status === 'error' ? 'Error' : 'Pending';
		const segCount = f.chunks ? f.chunks.filter(c => c.status === 'done').length : 0;
		const segTotal = f.chunks ? f.chunks.length : 0;
		const cfg = f.config;
		const cfgSummary = cfg ? `${cfg.voice_label || cfg.voice_id} ${cfg.split_segments ? cfg.split_mode : 'nosplit'}` : '';
		return `<div class="file-queue-item" style="cursor:pointer;flex-wrap:wrap;${isSel ? 'border-color:var(--accent-primary);background:rgba(91,122,106,0.04);' : ''}" onclick="if(event.target.closest('button'))return;_fqSelected=_fqSelected===${fi}?null:${fi};_loadFileToEditor(${fi});renderFileQueue()">
              <span class="fq-name" title="${f.name}">${escapeHtml(f.name)}</span>
              <span style="font-size:11px;color:var(--text-muted);font-family:monospace;">
                ${cfgSummary ? cfgSummary + ' ' : ''}${segTotal > 0 ? segCount + '/' + segTotal + ' seg' : ''}${f.duration ? ' ' + formatDuration(f.duration) : ''}
              </span>
              <span class="fq-status ${f.status}">${statusLabel}</span>
              <span class="fq-actions">
                ${f.status === 'pending' ? `<button onclick="event.stopPropagation();_saveFileConfig(${fi})" title="Save config" style="border:none;background:none;cursor:pointer;font-size:14px;color:${f._configured ? 'var(--success)' : 'var(--text-muted)'};">${f._configured ? '\u2713' : '\u2699'}</button>` : ''}
                <button onclick="event.stopPropagation();FILE_QUEUE.splice(${fi},1);_fqSelected=_fqSelected===${fi}?null:_fqSelected;renderFileQueue()" style="color:var(--error);border:none;background:none;cursor:pointer;font-size:14px;">&#10005;</button>
              </span>
            </div>`;
	}).join('')}`;
}

function _loadFileToEditor(idx) {
	if (idx < 0 || idx >= FILE_QUEUE.length) {
		CHUNK_DATA = []; CURRENT_TASK_ID = null; CURRENT_AUDIO_URL = null;
		renderChunks([]); hideFinalAudio(); return;
	}
	const f = FILE_QUEUE[idx];
	if (!f || !f.text) return;
	textInput.value = f.text;
	textInput.dispatchEvent(new Event('input'));
	if (f.config) {
		const c = f.config;
		const mode = c.voice_mode || document.querySelector('#voiceModeToggle .toggle-btn.active')?.dataset.mode || 'low';
		document.querySelectorAll('#voiceModeToggle .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
		CURRENT_VOICE_MODE = mode;
		if (c.voice_id) CURRENT_VOICE_ID = c.voice_id;
		updateVoiceLabel();
		updateSplitCheckbox();
		updateModelConfig();
		document.getElementById('normalizeCheckbox').checked = c.normalize || false;
		document.getElementById('cleanCheckbox').checked = c.clean || false;
		document.getElementById('normalizeAudioCheckbox').checked = c.normalize_audio !== false;
		document.getElementById('splitSegmentsCheckbox').checked = c.split_segments || false;
		document.getElementById('splitSegmentsCheckbox').dispatchEvent(new Event('change'));
		if (c.split_mode) document.getElementById('splitModeSelect').value = c.split_mode;
		if (c.speed !== undefined) { document.getElementById('speedSlider').value = c.speed; document.getElementById('speedSlider').dispatchEvent(new Event('input')); }
		if (c.pitch !== undefined) { document.getElementById('pitchSlider').value = c.pitch; document.getElementById('pitchSlider').dispatchEvent(new Event('input')); }
		if (c.volume !== undefined) { document.getElementById('volumeSlider').value = c.volume; document.getElementById('volumeSlider').dispatchEvent(new Event('input')); }
	}
	// Load results into main UI if file is done
	if (f.status === 'done' && f.chunks && f.chunks.length > 0) {
		CHUNK_DATA = f.chunks;
		CURRENT_TASK_ID = f.task_id || ('_file_' + idx);
		CURRENT_AUDIO_URL = f.audio_url || null;
		renderChunks(CHUNK_DATA);
		if (f.audio_url) {
			CURRENT_AUDIO_URL = f.audio_url;
			loadAudio(`${API_BASE}${f.audio_url}`);
			showFinalAudio();
		}
		if (f.chunks.length > 1) mergeSection.classList.remove('hidden');
		else mergeSection.classList.add('hidden');
	} else {
		CHUNK_DATA = [];
		CURRENT_TASK_ID = null;
		CURRENT_AUDIO_URL = null;
		renderChunks([]);
		mergeSection.classList.add('hidden');
		hideFinalAudio();
	}
}

const MAX_QUEUE = 20;

function addFilesToQueue(files) {
	if (FILE_QUEUE.length >= MAX_QUEUE) {
		showToast('Max ' + MAX_QUEUE + ' files allowed'); return;
	}
	let added = 0;
	for (const file of files) {
		if (!file.name.endsWith('.txt') && !file.name.endsWith('.md')) continue;
		if (file.size === 0) { showToast('Skipped empty: ' + file.name); continue; }
		const name = file.name.replace(/\.(txt|md)$/i, '');
		if (FILE_QUEUE.some(f => f.name === name)) continue;
		if (FILE_QUEUE.length >= MAX_QUEUE) { showToast('Queue full, skipped remaining'); break; }
		const idx = FILE_QUEUE.length;
		FILE_QUEUE.push({ name, file, text: '', status: 'pending', task_id: null, audio_url: null, duration: null });
		const reader = new FileReader();
		reader.onload = function () {
			const txt = (this.result || '').trim();
			if (!txt) {
				FILE_QUEUE.splice(idx, 1);
				showToast('Removed empty: ' + name);
			} else {
				FILE_QUEUE[idx].text = txt;
			}
			renderFileQueue();
		};
		reader.readAsText(file);
		added++;
	}
	renderFileQueue();
	if (added > 0) showToast('Added ' + added + ' file' + (added > 1 ? 's' : ''));
}

async function processSingleFile(idx) {
	const f = FILE_QUEUE[idx];
	if (!f || f.status !== 'pending' || !f.text) return;
	f.status = 'processing'; renderFileQueue();
	try {
		const c = f.config || {};
		const mode = c.voice_mode || document.querySelector('#voiceModeToggle .toggle-btn.active')?.dataset.mode || 'low';
		const vid = c.voice_id || CURRENT_VOICE_ID || 'banmai';
		f.voice = (ALL_VOICES[mode] || []).find(v => v.id === vid)?.label || vid;
		const res = await fetch(`${API_BASE}/tts/generate`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				text: f.text, voice_mode: mode, voice_id: vid, output_format: 'mp3',
				normalize: c.normalize !== undefined ? c.normalize : document.getElementById('normalizeCheckbox').checked,
				clean: c.clean !== undefined ? c.clean : document.getElementById('cleanCheckbox').checked,
				normalize_audio: c.normalize_audio !== undefined ? c.normalize_audio : document.getElementById('normalizeAudioCheckbox').checked,
				speed: c.speed !== undefined ? c.speed : parseFloat(document.getElementById('speedSlider').value),
				pitch: c.pitch !== undefined ? c.pitch : parseFloat(document.getElementById('pitchSlider').value),
				volume: c.volume !== undefined ? c.volume : parseFloat(document.getElementById('volumeSlider').value),
				split_segments: c.split_segments !== undefined ? c.split_segments : document.getElementById('splitSegmentsCheckbox').checked,
				split_mode: c.split_mode || (document.getElementById('splitSegmentsCheckbox').checked ? document.getElementById('splitModeSelect').value : 'default'),
				cfg_strength: parseFloat(document.getElementById('cfgSlider').value),
				steps: parseInt(document.getElementById('stepsSlider').value),
				sway: parseFloat(document.getElementById('swaySlider').value),
				num_step: parseInt(document.getElementById('numStepSlider').value),
			}),
		});
		if (!res.ok) throw new Error('Generation failed');
		const data = await res.json();
		f.task_id = data.task_id;
		for (let poll = 0; poll < 120; poll++) {
			await new Promise(r => setTimeout(r, 1000));
			const sr = await fetch(`${API_BASE}/tts/status/${data.task_id}`);
			if (!sr.ok) throw new Error('Status failed');
			const sd = await sr.json();
			if (sd.status === 'chunks_done' || sd.status === 'done') {
				f.chunks = sd.chunks || [];
				if (sd.audio_url) {
					f.audio_url = sd.audio_url;
				} else if (f.chunks.length > 1) {
					// Auto-merge multi-segment
					try {
						const m = await fetch(`${API_BASE}/tts/merge`, {
							method: 'POST', headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ task_id: data.task_id, output_format: 'mp3' }),
						});
						if (m.ok) { const md = await m.json(); f.audio_url = md.audio_url; f.duration = md.duration; }
					} catch (_) { }
				}
				if (!f.audio_url && f.chunks.length > 0) {
					const done = f.chunks.find(c => c.audio_url);
					if (done) f.audio_url = done.audio_url;
				}
				f.duration = sd.duration || f.duration || null;
				f.status = 'done';
				showToast(`Done: ${f.name}`);
				break;
			} else if (sd.status === 'error') {
				throw new Error(sd.error || 'Generation error');
			}
		}
		if (f.status === 'processing') { f.status = 'error'; f.error = 'Timeout'; }
	} catch (e) {
		f.status = 'error'; f.error = e.message;
		showToast(`Failed: ${f.name} — ${e.message}`);
	}
	_fqSelected = idx;
	renderFileQueue();
	_loadFileToEditor(idx);
}

async function processAllFiles() {
	const pending = FILE_QUEUE.map((f, i) => i).filter(i => FILE_QUEUE[i].status === 'pending');
	if (pending.length === 0) return;
	document.getElementById('processAllBtn').disabled = true;
	for (const idx of pending) {
		if (FILE_QUEUE[idx].status !== 'pending') continue;
		await processSingleFile(idx);
	}
	renderFileQueue();
}

// Drop zone handling
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
	e.preventDefault();
	dropZone.classList.remove('dragover');
	const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.txt') || f.name.endsWith('.md'));
	if (files.length === 0) return;
	if (files.length === 1 && FILE_QUEUE.length === 0) {
		// Single file — load into textarea (backward compatible)
		const reader = new FileReader();
		reader.onload = ev => { textInput.value = ev.target.result; textInput.dispatchEvent(new Event('input')); showToast(`Loaded ${files[0].name}`); };
		reader.readAsText(files[0]);
	} else {
		addFilesToQueue(files);
	}
});
dropZone.addEventListener('click', e => {
	if (e.target === dropZone || e.target.closest('.drop-zone-hint')) {
		fileInput.click();
	}
});
fileInput.addEventListener('change', e => {
	const files = Array.from(e.target.files).filter(f => f.name.endsWith('.txt') || f.name.endsWith('.md'));
	if (files.length > 0) addFilesToQueue(files);
	e.target.value = '';
});

// Text input handling
textInput.addEventListener('input', () => {
	updateCharCount();
	if (textInput.value.trim()) {
		dropZone.classList.remove('empty');
	} else {
		dropZone.classList.add('empty');
	}
	clearTimeout(AUTOSAVE_TIMER);
	AUTOSAVE_TIMER = setTimeout(() => {
		localStorage.setItem('tts_draft', textInput.value);
		updateAutosaveIndicator();
	}, 2000);
});

// Load draft on startup
const savedDraft = localStorage.getItem('tts_draft');
if (savedDraft) {
	textInput.value = savedDraft;
	dropZone.classList.remove('empty');
	textInput.dispatchEvent(new Event('input'));
}

// Input action buttons
document.getElementById('clearTextBtn').addEventListener('click', () => {
	if (textInput.value && !confirm('Clear all text?')) return;
	textInput.value = '';
	textInput.dispatchEvent(new Event('input'));
});

document.getElementById('saveDraftBtn').addEventListener('click', () => {
	localStorage.setItem('tts_draft', textInput.value);
	showToast('Draft saved');
	updateAutosaveIndicator();
});

function updateAutosaveIndicator() {
	autosaveIndicator.style.display = 'flex';
	const now = new Date();
	autosaveText.textContent = `Saved ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
}

voiceModeToggle.addEventListener('click', e => {
	const btn = e.target.closest('.toggle-btn');
	if (!btn) return;
	const mode = btn.dataset.mode;
	const list = ALL_VOICES[mode] || [];
	if (list.length === 0) {
		const names = { medium: 'F5-TTS', high: 'OmniVoice' };
		showToast(`Load ${names[mode] || mode} model in Resources tab first`);
		return;
	}
	voiceModeToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
	btn.classList.add('active');
	CURRENT_VOICE_MODE = mode;
	document.getElementById('newVoiceBtn').style.display = (CURRENT_VOICE_MODE === 'medium' || CURRENT_VOICE_MODE === 'high') ? 'inline-block' : 'none';
	updateSplitCheckbox();
	updateModelConfig();
	if (!list.find(v => v.id === CURRENT_VOICE_ID)) {
		selectVoice(list[0].id, list[0].label, list[0].gender || '');
	}
	updateVoiceLabel();
	updateCharCount();
});

async function loadVoices() {
	try {
		const res = await fetch(`${API_BASE}/tts/voices`);
		const data = await res.json();
		ALL_VOICES = data;

		// Hide quality tiers with no loaded voices
		['low', 'medium', 'high'].forEach(mode => {
			const hasVoices = (data[mode] && data[mode].length > 0);
			const toggleBtn = document.querySelector(`#voiceModeToggle .toggle-btn[data-mode="${mode}"]`);
			const modalTab = document.querySelector(`#voiceModal .dict-tab[data-tab="${mode}"]`);
			if (toggleBtn) toggleBtn.style.display = hasVoices ? '' : 'none';
			if (modalTab) modalTab.style.display = hasVoices ? '' : 'none';
		});

		// If no voices at all, show a "download needed" message
		if (!anyVoiceExists()) {
			document.getElementById('currentVoiceLabel').innerHTML =
				'<span style="color:var(--accent-gold);font-size:13px;">&#9888; Download voices in Resources tab</span>';
			document.querySelectorAll('#voiceModeToggle .toggle-btn').forEach(b => b.style.display = '');
			return;
		}

		checkGpuAndShowInfo();

		// If current mode has no voices, pick first available
		if (!(ALL_VOICES[CURRENT_VOICE_MODE] && ALL_VOICES[CURRENT_VOICE_MODE].length > 0)) {
			const available = ['low', 'medium', 'high'].find(m => ALL_VOICES[m] && ALL_VOICES[m].length > 0);
			if (available) {
				CURRENT_VOICE_MODE = available;
				document.querySelectorAll('#voiceModeToggle .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === available));
			}
		}

		// Activate first visible toggle if none is active
		if (!document.querySelector('#voiceModeToggle .toggle-btn.active')) {
			const first = document.querySelector('#voiceModeToggle .toggle-btn');
			if (first) { first.classList.add('active'); CURRENT_VOICE_MODE = first.dataset.mode; }
		}

		if (data.low && data.low.length && data.low[0].rate) VOICE_RATES.preset = data.low[0].rate;
		const cr = {};
		(data.medium || []).forEach(v => { cr[v.id] = v.rate || 18; });
		(data.high || []).forEach(v => { cr[v.id] = v.rate || 8; });
		VOICE_RATES.custom = cr;
		if (ALL_VOICES[CURRENT_VOICE_MODE] && ALL_VOICES[CURRENT_VOICE_MODE].length > 0) {
			const first = ALL_VOICES[CURRENT_VOICE_MODE][0];
			selectVoice(first.id, first.label, first.gender || '');
		}
	} catch (e) { console.error(e); }
}

function selectVoice(id, label, gender) {
	CURRENT_VOICE_ID = id;
	updateVoiceLabel();
	updateSplitCheckbox();
	updateModelConfig();
}

async function checkGpuAndShowInfo() {
	try {
		const res = await fetch(`${API_BASE}/tts/model_status`);
		const data = await res.json();
		const gpu = data.gpu || {};
		const badge = document.getElementById('gpuBadge');
		if (gpu.available) {
			const labels = { low: 'CPU', medium: 'GPU', high: 'GPU' };
			const rec = (data.recommended_quality || ['low']).map(q => labels[q] || q).join('/');
			badge.innerHTML = `<span style="color:var(--accent-primary);">&#9679;</span> ${gpu.name} (${gpu.vram_gb}GB) · <span style="color:var(--text-primary);">${rec}</span>`;
			badge.style.display = 'flex';
		} else {
			badge.innerHTML = `<span style="color:var(--text-muted);">&#9679;</span> No GPU · CPU`;
			badge.style.display = 'flex';
		}
	} catch (e) {
		// silently ignore
	}
}

function anyVoiceExists() {
	return ['low', 'medium', 'high'].some(m => ALL_VOICES[m] && ALL_VOICES[m].length > 0);
}

function updateVoiceLabel() {
	if (!anyVoiceExists()) {
		document.getElementById('currentVoiceLabel').innerHTML =
			'<span style="color:var(--accent-gold);font-size:13px;">&#9888; Go to Resources to download voices</span>';
		return;
	}
	const list = ALL_VOICES[CURRENT_VOICE_MODE] || [];
	const v = list.find(x => x.id === CURRENT_VOICE_ID);
	const genderIcon = v && v.gender === 'male' ? '&#9794;' : v && v.gender === 'female' ? '&#9792;' : '';
	const badgeClass = QUALITY_BADGE_CLASS[CURRENT_VOICE_MODE] || 'piper';
	const engineBadge = `<span class="voice-engine-badge ${badgeClass}">${QUALITY_LABELS[CURRENT_VOICE_MODE]}</span>`;
	const label = v ? `${v.label} <span class="gender-icon">${genderIcon}</span>${engineBadge}` : (CURRENT_VOICE_ID || 'Unknown');
	document.getElementById('currentVoiceLabel').innerHTML = label;
}

function updateSplitCheckbox() {
	const label = document.getElementById('splitSegmentsLabel');
	const cb = document.getElementById('splitSegmentsCheckbox');
	label.style.display = '';
	cb.disabled = false;
	document.getElementById('splitModeOptions').style.display = cb.checked ? '' : 'none';
}

document.getElementById('splitSegmentsCheckbox').addEventListener('change', function () {
	document.getElementById('splitModeOptions').style.display = this.checked ? '' : 'none';
});

function updateModelConfig() {
	const panel = document.getElementById('modelConfig');
	if (!panel) return;
	const cfgRow = document.getElementById('cfgRow');
	const stepsRow = document.getElementById('stepsRow');
	const swayRow = document.getElementById('swayRow');
	const numStepRow = document.getElementById('numStepRow');
	const title = panel.querySelector('div');
	if (CURRENT_VOICE_MODE === 'low') {
		panel.classList.add('hidden');
	} else {
		panel.classList.remove('hidden');
		if (cfgRow) cfgRow.style.display = '';
		if (CURRENT_VOICE_MODE === 'medium') {
			if (title) title.textContent = 'Model Config \u2014 Medium (F5)';
			if (stepsRow) stepsRow.style.display = '';
			if (swayRow) swayRow.style.display = '';
			if (numStepRow) numStepRow.style.display = 'none';
		} else {
			if (title) title.textContent = 'Model Config \u2014 High (OmniVoice)';
			if (stepsRow) stepsRow.style.display = 'none';
			if (swayRow) swayRow.style.display = 'none';
			if (numStepRow) numStepRow.style.display = '';
		}
	}
}

function getCurrentVoiceLabel() {
	const list = ALL_VOICES[CURRENT_VOICE_MODE] || [];
	const v = list.find(x => x.id === CURRENT_VOICE_ID);
	return v ? v.label : CURRENT_VOICE_ID;
}

function updateCharCount() {
	const text = textInput.value;
	const len = text.length;
	const words = len > 0 ? text.split(/\s+/).filter(w => w.length > 0).length : 0;

	charCount.textContent = `${len.toLocaleString()} chars`;
	charCount.style.color = len > 4800 ? 'var(--error)' : 'var(--text-muted)';

	if (wordCount) wordCount.textContent = `${words.toLocaleString()} words`;

	const mode = document.querySelector('.toggle-btn.active').dataset.mode;
	let rate = VOICE_RATES.preset;
	if (CURRENT_VOICE_MODE === 'custom') {
		rate = VOICE_RATES.custom[CURRENT_VOICE_ID] || 18;
	}
	let estSec = len > 0 ? len / rate : 0;
	if (PAUSE_CFG.enabled) {
		const p = PAUSE_CFG.pauses;
		for (const ch of Object.keys(p)) {
			if (ch === 'linebreak') continue;
			const count = (text.match(new RegExp('\\' + ch, 'g')) || []).length;
			estSec += count * p[ch];
		}
		const lb = (text.match(/\n\s*\n/g) || []).length;
		estSec += lb * (p.linebreak || 0);
		const markers = text.match(/\[(\d+(?:\.\d+)?)\s*s\]/gi) || [];
		for (const m of markers) {
			const val = parseFloat(m.match(/[\d.]+/)[0]);
			estSec += val;
		}
	}

	const rounded = Math.round(estSec);
	const estMin = Math.floor(rounded / 60);
	const estRem = rounded % 60;
	const durationStr = estMin > 0 ? `~${estMin}m ${estRem}s` : `~${estRem}s`;

	if (estDuration) estDuration.textContent = `${durationStr} audio`;

	const splitEnabled = document.getElementById('splitSegmentsCheckbox').checked;
	const estSegCount = splitEnabled && len > 0 ? Math.ceil(len / 400) : 1;
	if (estSegments) estSegments.textContent = `${estSegCount} segment${estSegCount !== 1 ? 's' : ''}`;
}

/* Voice Modal */
function switchVoiceTab(tab) {
	document.querySelectorAll('#voiceModal .dict-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
	document.getElementById('voiceLowList').classList.toggle('hidden', tab !== 'low');
	document.getElementById('voiceMediumList').classList.toggle('hidden', tab !== 'medium');
	document.getElementById('voiceHighList').classList.toggle('hidden', tab !== 'high');
	renderCurrentVoiceTab();
}

function renderCurrentVoiceTab() {
	const active = document.querySelector('#voiceModal .dict-tab.active');
	renderVoiceList(active ? active.dataset.tab : CURRENT_VOICE_MODE);
}

function renderVoiceList(mode) {
	const containerId = mode === 'low' ? 'voiceLowList' : mode === 'medium' ? 'voiceMediumList' : 'voiceHighList';
	const container = document.getElementById(containerId);
	const genderFilter = document.getElementById('voiceGenderFilter')?.value || '';
	const typeFilter = document.getElementById('voiceTypeFilter')?.value || '';
	let list = ALL_VOICES[mode] || [];
	if (genderFilter) list = list.filter(v => v.gender === genderFilter);
	if (typeFilter === 'clone') list = list.filter(v => v.is_clone);
	else if (typeFilter === 'default') list = list.filter(v => !v.is_clone);
	if (list.length === 0) {
		container.innerHTML = '<div class="hist-empty">No voices match the filter</div>'; return;
	}
	container.innerHTML = list.map(v => {
		const isSelected = v.id === CURRENT_VOICE_ID && CURRENT_VOICE_MODE === mode;
		const genderIcon = v.gender === 'male' ? '&#9794;' : v.gender === 'female' ? '&#9792;' : '&#9733;';
		const genderColor = v.gender === 'male' ? 'var(--accent-primary)' : v.gender === 'female' ? '#c47a9e' : 'var(--text-muted)';
		const cloneBadge = v.is_clone ? '<span style="font-size:10px;background:var(--accent-gold);color:#fff;padding:1px 6px;border-radius:8px;margin-left:6px;font-weight:600;">CLONE</span>' : '<span style="font-size:10px;background:var(--bg-secondary);color:var(--text-muted);padding:1px 6px;border-radius:8px;margin-left:6px;">DEFAULT</span>';
		return `<div class="voice-card ${isSelected ? 'selected' : ''}" onclick="selectVoiceFromCard('${mode}','${v.id}')">
      <div class="voice-card-avatar" style="background:${genderColor}15;color:${genderColor};border-color:${genderColor}40;">${genderIcon}</div>
      <div class="voice-card-info">
        <div class="voice-card-name">${escapeHtml(v.label)}${cloneBadge}</div>
        <div class="voice-card-desc" title="${escapeHtml(v.description || v.ref_text || '')}">${escapeHtml(v.description || v.ref_text || '')}</div>
      </div>
      <div class="voice-card-actions" style="display:flex;gap:4px;align-items:center;">
        <button onclick="event.stopPropagation();previewVoice('${mode}','${v.id}')" title="Preview">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        ${v.is_clone ? `<button onclick="event.stopPropagation();editVoiceDesc('${mode}','${v.id}')" title="Edit description">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>` : ''}
        ${v.is_clone ? `<button onclick="event.stopPropagation();deleteVoice('${mode}','${v.id}')" title="Delete voice" style="color:var(--error);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>` : ''}
      </div>
    </div>`;
	}).join('');
}

function selectVoiceFromCard(mode, id) {
	const list = ALL_VOICES[mode] || [];
	const v = list.find(x => x.id === id);
	if (v) {
		CURRENT_VOICE_MODE = mode;
		CURRENT_VOICE_ID = id;
		updateVoiceLabel();
		updateSplitCheckbox();
		updateModelConfig();
		document.querySelectorAll('#voiceModeToggle .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
		document.getElementById('newVoiceBtn').style.display = (mode === 'medium' || mode === 'high') ? 'inline-block' : 'none';
		updateCharCount();
		renderVoiceList(mode);
	}
}

function editVoiceDesc(mode, id) {
	const list = ALL_VOICES[mode] || [];
	const v = list.find(x => x.id === id);
	if (!v) return;
	const newDesc = prompt('Edit description:', v.description || '');
	if (newDesc === null) return;
	fetch(`${API_BASE}/tts/voices/${id}`, {
		method: 'PATCH', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ description: newDesc.trim() || 'No description' }),
	}).then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); })
		.then(() => { loadVoices().then(() => renderCurrentVoiceTab()); showToast('Description updated'); })
		.catch(() => alert('Failed to update description'));
}

function deleteVoice(mode, id) {
	if (!confirm('Delete this cloned voice?')) return;
	fetch(`${API_BASE}/tts/voices/${id}`, { method: 'DELETE' })
		.then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); })
		.then(() => {
			loadVoices().then(() => {
				renderCurrentVoiceTab();
				if (CURRENT_VOICE_ID === id) {
					const first = Object.values(ALL_VOICES).flat()[0];
					if (first) selectVoiceFromCard(first.engine === 'f5' ? 'medium' : first.engine === 'omnivoice' ? 'high' : first.engine || 'low', first.id);
				}
			});
			showToast('Voice deleted');
		})
		.catch(() => alert('Cannot delete default voice'));
}

function previewVoice(mode, id) {
	const list = ALL_VOICES[mode] || [];
	const v = list.find(x => x.id === id);
	if (!v) return;
	if (mode === 'low') {
		const text = 'Xin chào đây là đoạn thử giọng nói, cảm ơn bạn đã lắng nghe.';
		fetch(`${API_BASE}/tts/preview`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text, voice_mode: 'low', voice_id: id, normalize: false, clean: false, normalize_audio: true, speed: 1, pitch: 0, volume: 0 }),
		}).then(r => r.json()).then(data => {
			const wrap = getOrCreateMiniPlayer();
			const aud = wrap.querySelector('audio');
			aud.src = `${API_BASE}${data.audio_url}`;
			aud.play().catch(() => { });
		}).catch(() => { });
	} else {
		const engine = mode === 'medium' ? 'f5' : 'omnivoice';
		const url = `${API_BASE}/tts/voice_audio/${engine}/${id}`;
		const wrap = getOrCreateMiniPlayer();
		const aud = wrap.querySelector('audio');
		aud.src = url;
		aud.play().catch(() => { });
	}
}

function getOrCreateMiniPlayer() {
	const old = document.getElementById('chunkPlayer');
	if (old) return old;
	const wrap = document.createElement('div');
	wrap.id = 'chunkPlayer';
	wrap.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius-md);padding:10px 18px;box-shadow:var(--shadow-lg);z-index:300;display:flex;align-items:center;gap:12px;';
	const aud = document.createElement('audio');
	aud.controls = true;
	aud.style.cssText = 'height:34px;width:280px;';
	const close = document.createElement('button');
	close.innerHTML = '&times;';
	close.style.cssText = 'border:none;background:none;font-size:22px;cursor:pointer;color:var(--text-muted);padding:0 4px;line-height:1;';
	close.onclick = () => wrap.remove();
	wrap.appendChild(aud);
	wrap.appendChild(close);
	document.body.appendChild(wrap);
	return wrap;
}

document.getElementById('selectVoiceBtn').addEventListener('click', () => {
	const modal = document.getElementById('voiceModal');
	modal.classList.remove('hidden');
	document.getElementById('voiceGenderFilter').value = '';
	document.getElementById('voiceTypeFilter').value = '';
	switchVoiceTab(CURRENT_VOICE_MODE);
});
document.getElementById('voiceCloseBtn').addEventListener('click', () => {
	document.getElementById('voiceModal').classList.add('hidden');
});
document.getElementById('voiceModal').addEventListener('click', e => {
	if (e.target === e.currentTarget) document.getElementById('voiceModal').classList.add('hidden');
});

document.getElementById('insertPauseBtn').addEventListener('click', () => {
	const ta = document.getElementById('textInput');
	const sel = document.getElementById('pauseDurSelect');
	const marker = `[${sel.value}s]`;
	const start = ta.selectionStart, end = ta.selectionEnd;
	const pos = end;
	ta.value = ta.value.slice(0, pos) + marker + ta.value.slice(pos);
	const newPos = pos + marker.length;
	ta.setSelectionRange(newPos, newPos);
	ta.focus();
	ta.dispatchEvent(new Event('input'));
});

previewBtn.addEventListener('click', async () => {
	const text = textInput.value.trim();
	if (!text) return;
	const normalize = document.getElementById('normalizeCheckbox').checked;
	previewBtn.disabled = true; previewBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;animation:spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-dasharray="30 70"/></svg> Preview';
	try {
		const res = await fetch(`${API_BASE}/tts/preview`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text, voice_mode: CURRENT_VOICE_MODE, voice_id: CURRENT_VOICE_ID, normalize, clean: document.getElementById('cleanCheckbox').checked, normalize_audio: document.getElementById('normalizeAudioCheckbox').checked, speed: parseFloat(document.getElementById('speedSlider').value), pitch: parseFloat(document.getElementById('pitchSlider').value), volume: parseFloat(document.getElementById('volumeSlider').value), cfg_strength: parseFloat(document.getElementById('cfgSlider').value), steps: parseInt(document.getElementById('stepsSlider').value), sway: parseFloat(document.getElementById('swaySlider').value), num_step: parseInt(document.getElementById('numStepSlider').value) }),
		});
		if (!res.ok) throw new Error('Preview failed');
		const data = await res.json();
		loadAudio(`${API_BASE}${data.audio_url}`);
		audioPlayer.play().catch(() => { });
	} catch (e) { showError('Preview: ' + e.message); }
	previewBtn.disabled = false; previewBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;"><polygon points="5 3 19 12 5 21 5 3"/></svg> Preview';
});

generateBtn.addEventListener('click', startGeneration);

async function startGeneration() {
	const selFile = _fqSelected !== null ? FILE_QUEUE[_fqSelected] : null;
	if (selFile) {
		// File mode: use file's stored text (ignore textarea edits)
		if (!selFile.text) { showError('File has no text'); return; }
		// Save current UI settings as file config before generating
		_saveFileConfig(_fqSelected);
	} else {
		// Normal mode: use textarea
		const text = textInput.value.trim();
		if (!text) { showError('Enter some text'); return; }
	}
	if (!CURRENT_VOICE_ID) { showError('Select a voice'); return; }

	hideError();
	hideFinalAudio();
	progressFloat.classList.add('visible');
	mergeSection.classList.add('hidden');
	resetBtn.style.display = 'inline-flex';
	generateBtn.disabled = true;
	STATE = 'loading';
	GENERATION_PAUSED = false;
	GENERATION_START_TIME = Date.now();

	const text = selFile ? selFile.text : textInput.value.trim();
	const c = selFile?.config || {};
	const mode = c.voice_mode || CURRENT_VOICE_MODE;
	const vid = c.voice_id || CURRENT_VOICE_ID;

	if (selFile) {
		selFile.status = 'processing';
		renderFileQueue();
	}

	setProgress(0, selFile ? 'Generating: ' + selFile.name : 'Starting...');

	try {
		const res = await fetch(`${API_BASE}/tts/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				text, voice_mode: mode, voice_id: vid, output_format: 'mp3',
				normalize: c.normalize !== undefined ? c.normalize : document.getElementById('normalizeCheckbox').checked,
				clean: c.clean !== undefined ? c.clean : document.getElementById('cleanCheckbox').checked,
				normalize_audio: c.normalize_audio !== undefined ? c.normalize_audio : document.getElementById('normalizeAudioCheckbox').checked,
				speed: c.speed !== undefined ? c.speed : parseFloat(document.getElementById('speedSlider').value),
				pitch: c.pitch !== undefined ? c.pitch : parseFloat(document.getElementById('pitchSlider').value),
				volume: c.volume !== undefined ? c.volume : parseFloat(document.getElementById('volumeSlider').value),
				split_segments: c.split_segments !== undefined ? c.split_segments : document.getElementById('splitSegmentsCheckbox').checked,
				split_mode: c.split_mode || (document.getElementById('splitSegmentsCheckbox').checked ? document.getElementById('splitModeSelect').value : 'default'),
				cfg_strength: parseFloat(document.getElementById('cfgSlider').value),
				steps: parseInt(document.getElementById('stepsSlider').value),
				sway: parseFloat(document.getElementById('swaySlider').value),
				num_step: parseInt(document.getElementById('numStepSlider').value),
			}),
		});
		if (!res.ok) throw new Error('Generation failed');
		const data = await res.json();
		CURRENT_TASK_ID = data.task_id;
		if (selFile) selFile.task_id = data.task_id;
		pollStatus(CURRENT_TASK_ID, selFile);
	} catch (e) { onError(e.message); }
}

function pollStatus(taskId, fileRef) {
	if (POLL_INTERVAL) clearInterval(POLL_INTERVAL);
	POLL_INTERVAL = setInterval(async () => {
		try {
			const res = await fetch(`${API_BASE}/tts/status/${taskId}`);
			if (!res.ok) throw new Error('Status fetch failed');
			const data = await res.json();
			setProgress(data.progress, data.stage || '');
			renderChunks(data.chunks || []);

			if (data.status === 'chunks_done') {
				clearInterval(POLL_INTERVAL); POLL_INTERVAL = null;
				const chunks = data.chunks || [];
				if (chunks.length > 1) {
					// Auto-merge multi-segment results
					try {
						const mergeRes = await fetch(`${API_BASE}/tts/merge`, {
							method: 'POST', headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ task_id: taskId, output_format: 'mp3' }),
						});
						if (mergeRes.ok) {
							const mergeData = await mergeRes.json();
							data.audio_url = mergeData.audio_url;
							data.duration = mergeData.duration;
							data.status = 'done';
						}
					} catch (_) { }
				}
				if (fileRef) {
					fileRef.status = 'done';
					fileRef.chunks = chunks;
					fileRef.audio_url = data.audio_url || (chunks.find(c => c.audio_url)?.audio_url) || null;
					fileRef.duration = data.duration || null;
					fileRef.voice = (ALL_VOICES[CURRENT_VOICE_MODE] || []).find(v => v.id === CURRENT_VOICE_ID)?.label || CURRENT_VOICE_ID;
					renderFileQueue();
				}
				if (data.status === 'done') {
					renderChunks(data.chunks || []);
					if (chunks.length > 1) mergeSection.classList.remove('hidden');
					progressFloat.classList.remove('visible');
					showFinalAudio();
					CURRENT_AUDIO_URL = `${API_BASE}${data.audio_url}`;
					loadAudio(CURRENT_AUDIO_URL);
					generateBtn.disabled = false; resetBtn.style.display = 'inline-flex'; STATE = 'done';
				} else {
					onChunksDone(data);
				}
			} else if (data.status === 'done') {
				clearInterval(POLL_INTERVAL); POLL_INTERVAL = null;
				if (fileRef) {
					fileRef.status = 'done';
					fileRef.audio_url = data.audio_url || fileRef.audio_url;
					fileRef.duration = data.duration || fileRef.duration;
					renderFileQueue();
				}
				progressFloat.classList.remove('visible');
				showFinalAudio();
				CURRENT_AUDIO_URL = `${API_BASE}${data.audio_url}`;
				loadAudio(CURRENT_AUDIO_URL);
				generateBtn.disabled = false; resetBtn.style.display = 'inline-flex'; STATE = 'done';
			} else if (data.status === 'error') {
				clearInterval(POLL_INTERVAL); POLL_INTERVAL = null;
				if (fileRef) {
					fileRef.status = 'error';
					fileRef.error = data.error || 'Unknown error';
					renderFileQueue();
				}
				onError(data.error || 'Unknown error');
			}
		} catch (e) {
			clearInterval(POLL_INTERVAL); POLL_INTERVAL = null;
			onError(e.message);
		}
	}, 500);
}

function onChunksDone(data) {
	STATE = 'chunks_done';
	generateBtn.disabled = false;
	progressFloat.classList.remove('visible');
	const chunks = data.chunks || [];
	if (chunks.length > 1) {
		mergeSection.classList.remove('hidden');
	} else if (chunks.length === 1 && chunks[0].status === 'done') {
		// Single chunk (split OFF) — show in Final Audio bar
		CURRENT_AUDIO_URL = `${API_BASE}${chunks[0].audio_url}`;
		loadAudio(CURRENT_AUDIO_URL);
		showFinalAudio();
	}
	resetBtn.style.display = 'inline-flex';
	updateAutosaveIndicator();
}

async function doMerge() {
	if (!CURRENT_TASK_ID) return;
	try {
		const res = await fetch(`${API_BASE}/tts/merge`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ task_id: CURRENT_TASK_ID, output_format: 'mp3' }),
		});
		if (!res.ok) throw new Error('Merge failed');
		const data = await res.json();
		showFinalAudio();
		CURRENT_AUDIO_URL = `${API_BASE}${data.audio_url}`;
		loadAudio(CURRENT_AUDIO_URL);
	} catch (e) { showError('Auto-merge: ' + e.message); }
}

function setProgress(pct, label) {
	floatFill.style.width = Math.min(pct, 100) + '%';

	const chunks = CHUNK_DATA || [];
	const done = chunks.filter(c => c.status === 'done').length;
	const total = chunks.length;

	if (total > 0) {
		floatCount.textContent = `${done} / ${total}`;
	} else if (label) {
		floatCount.textContent = `${Math.round(pct)}%`;
	} else {
		floatCount.textContent = `${Math.round(pct)}%`;
	}

	if (GENERATION_PAUSED) {
		floatStatus.textContent = 'Paused';
	} else if (pct < 100) {
		floatStatus.textContent = 'Generating audio...';
	} else {
		floatStatus.textContent = 'Complete';
	}

	// Elapsed time
	if (GENERATION_START_TIME && pct < 100) {
		const elapsed = (Date.now() - GENERATION_START_TIME) / 1000;
		const min = Math.floor(elapsed / 60);
		const sec = Math.floor(elapsed % 60);
		floatEta.textContent = `${min}:${sec.toString().padStart(2, '0')} elapsed`;
	} else if (pct >= 100) {
		const total = (Date.now() - GENERATION_START_TIME) / 1000;
		const min = Math.floor(total / 60);
		const sec = Math.floor(total % 60);
		floatEta.textContent = `Done in ${min}:${sec.toString().padStart(2, '0')}`;
	} else {
		floatEta.textContent = '0:00';
	}
}

function drawWaveform(audioUrl) {
	const canvas = document.getElementById('waveformCanvas');
	if (!canvas) return;
	canvas.style.display = 'block';
	const ctx = canvas.getContext('2d');
	const w = 600;
	const h = 160;
	canvas.width = w;
	canvas.height = h;
	ctx.clearRect(0, 0, w, h);
	ctx.fillStyle = '#2a2a2a';
	ctx.fillRect(0, 0, w, h);

	fetch(audioUrl).then(r => r.arrayBuffer()).then(buf => {
		const actx = new (window.AudioContext || window.webkitAudioContext)();
		return actx.decodeAudioData(buf);
	}).then(audioBuffer => {
		const data = audioBuffer.getChannelData(0);
		const step = Math.max(1, Math.floor(data.length / w));
		for (let i = 0; i < w; i++) {
			let peak = 0;
			const start = i * step;
			const end = Math.min(start + step, data.length);
			for (let j = start; j < end; j++) {
				const v = Math.abs(data[j]);
				if (v > peak) peak = v;
			}
			const barH = peak * h * 0.8;
			const progress = audioPlayer.duration > 0 ? audioPlayer.currentTime / audioPlayer.duration : 0;
			if (i / w < progress) {
				ctx.fillStyle = '#5b7a6a';
			} else {
				ctx.fillStyle = '#4a4a4a';
			}
			ctx.fillRect(i, (h - barH) / 2, 1, Math.max(1, barH));
		}
	}).catch(e => {
		ctx.fillStyle = '#666';
		ctx.font = '12px sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('Waveform unavailable', w / 2, h / 2);
	});
}

// Custom player controls
const cpPlayBtn = document.getElementById('cpPlayBtn');
const cpProgressBg = document.getElementById('cpProgressBg');
const cpProgressFill = document.getElementById('cpProgressFill');
const cpVolBtn = document.getElementById('cpVolBtn');
const cpVolSlider = document.getElementById('cpVolSlider');
const faCurrentTime = document.getElementById('faCurrentTime');
const faTotalTime = document.getElementById('faTotalTime');
const cpRewindBtn = document.getElementById('cpRewindBtn');
const cpForwardBtn = document.getElementById('cpForwardBtn');
const faSpeedSelect = document.getElementById('faSpeedSelect');

function formatTime(s) {
	if (!s || isNaN(s)) return '0:00';
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, '0')}`;
}

function updatePlayIcon() {
	cpPlayBtn.innerHTML = audioPlayer.paused
		? '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
		: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
}

cpPlayBtn.addEventListener('click', () => {
	if (audioPlayer.paused) audioPlayer.play().catch(() => { });
	else audioPlayer.pause();
});

cpProgressBg.addEventListener('click', e => {
	if (!audioPlayer.duration) return;
	const rect = cpProgressBg.getBoundingClientRect();
	const pct = (e.clientX - rect.left) / rect.width;
	const target = pct * audioPlayer.duration;
	audioPlayer.currentTime = target;
});

cpRewindBtn.addEventListener('click', () => {
	if (!audioPlayer.duration) return;
	const ct = audioPlayer.currentTime || 0;
	const target = Math.max(0, ct - 2);
	audioPlayer.currentTime = target;
});

cpForwardBtn.addEventListener('click', () => {
	if (!audioPlayer.duration) return;
	const ct = audioPlayer.currentTime || 0;
	const target = Math.min(audioPlayer.duration, ct + 2);
	audioPlayer.currentTime = target;
});

cpVolSlider.addEventListener('input', () => {
	audioPlayer.volume = parseFloat(cpVolSlider.value);
});

faSpeedSelect.addEventListener('change', () => {
	audioPlayer.playbackRate = parseFloat(faSpeedSelect.value);
});

audioPlayer.addEventListener('play', updatePlayIcon);
audioPlayer.addEventListener('pause', updatePlayIcon);
audioPlayer.addEventListener('timeupdate', () => {
	if (!audioPlayer.duration) return;
	const ct = audioPlayer.currentTime;
	if (typeof ct !== 'number' || !isFinite(ct)) {
		return;
	}
	faCurrentTime.textContent = formatTime(ct);
	faTotalTime.textContent = formatTime(audioPlayer.duration);
	cpProgressFill.style.width = ((ct / audioPlayer.duration) * 100) + '%';
});
audioPlayer.addEventListener('loadedmetadata', () => {
	faTotalTime.textContent = formatTime(audioPlayer.duration);
});


// Waveform seek interaction
const waveformWrap = document.getElementById('waveformWrap');
const waveformSeek = document.getElementById('waveformSeek');
const waveformTime = document.getElementById('waveformTime');

if (waveformWrap) {
	waveformWrap.addEventListener('click', e => {
		if (!audioPlayer.duration) return;
		const rect = waveformWrap.getBoundingClientRect();
		const pct = (e.clientX - rect.left) / rect.width;
		const target = pct * audioPlayer.duration;
		audioPlayer.currentTime = target;
	});

	waveformWrap.addEventListener('mousemove', e => {
		if (!audioPlayer.duration) return;
		const rect = waveformWrap.getBoundingClientRect();
		let pct = (e.clientX - rect.left) / rect.width;
		if (pct < 0) pct = 0;
		if (pct > 1) pct = 1;
		const ht = pct * audioPlayer.duration;
		waveformTime.textContent = `${Math.floor(ht / 60)}:${Math.floor(ht % 60).toString().padStart(2, '0')}`;
		waveformSeek.style.width = (pct * 100) + '%';
		waveformTime.style.opacity = '1';
	});

	waveformWrap.addEventListener('mouseleave', () => {
		if (!audioPlayer.duration) return;
		const progress = audioPlayer.currentTime / audioPlayer.duration;
		waveformSeek.style.width = (progress * 100) + '%';
		waveformTime.style.opacity = '0';
	});

	audioPlayer.addEventListener('timeupdate', () => {
		if (!audioPlayer.duration) return;
		const progress = audioPlayer.currentTime / audioPlayer.duration;
		waveformSeek.style.width = (progress * 100) + '%';
	});
}

function loadAudio(url) {
	audioPlayer.src = url;
	audioPlayer.load();
	drawWaveform(url);
}

function onError(msg) {
	STATE = 'error';
	generateBtn.disabled = false;
	progressFloat.classList.remove('visible');
	showError(msg);
}

mergeBtn.addEventListener('click', async () => {
	if (!CURRENT_TASK_ID) return;
	mergeBtn.disabled = true; mergeBtn.textContent = 'Merging...';
	progressFloat.classList.add('visible');
	setProgress(90, 'Merging audio...');
	await doMerge();
	mergeBtn.disabled = false; mergeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;"><path d="M8 6L21 6"/><path d="M8 12L21 12"/><path d="M8 18L21 18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> Merge &amp; Download All';
	progressFloat.classList.remove('visible');
});

document.getElementById('downloadAllBtn').addEventListener('click', () => {
	downloadAllChunks();
});

downloadBtn.addEventListener('click', () => {
	if (!CURRENT_AUDIO_URL) return;
	const fmt = formatSelect.value;
	const url = CURRENT_AUDIO_URL + '&format=' + fmt;
	const ext = fmt === 'mp3_320' ? 'mp3' : fmt;
	const ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
	const a = document.createElement('a');
	a.href = url; a.download = `capcap_${ts}.${ext}`; a.click();
});

document.getElementById('remergeBtn').addEventListener('click', async () => {
	if (!CURRENT_TASK_ID) return;
	await doMerge();
	showToast('Re-merged audio');
});

// Close final audio bar
document.getElementById('closeFinalAudio').addEventListener('click', hideFinalAudio);
finalAudioOverlay.addEventListener('click', hideFinalAudio);

// Reopen final audio bar
reopenFinalBtn.addEventListener('click', showFinalAudio);

resetBtn.addEventListener('click', async () => {
	if (!CURRENT_TASK_ID) return;
	if (!confirm('Reset this session? All generated audio will be deleted.')) return;
	try {
		await fetch(`${API_BASE}/tts/reset/${CURRENT_TASK_ID}`, { method: 'POST' });
	} catch (_) { }
	CURRENT_TASK_ID = null;
	CURRENT_AUDIO_URL = null;
	CHUNK_DATA = [];
	if (POLL_INTERVAL) { clearInterval(POLL_INTERVAL); POLL_INTERVAL = null; }
	STATE = 'idle';
	generateBtn.disabled = false;
	progressFloat.classList.remove('visible');
	hideFinalAudio();
	reopenFinalBtn.classList.remove('visible');
	mergeSection.classList.add('hidden');
	chunkList.innerHTML = '<div class="no-chunks">Enter text and click Generate to see segments</div>';
	resetBtn.style.display = 'none';
	hideError();
});

floatCancelBtn.addEventListener('click', async () => {
	if (!CURRENT_TASK_ID) return;
	if (!confirm('Cancel generation?')) return;
	if (POLL_INTERVAL) { clearInterval(POLL_INTERVAL); POLL_INTERVAL = null; }
	try {
		await fetch(`${API_BASE}/tts/reset/${CURRENT_TASK_ID}`, { method: 'POST' });
	} catch (_) { }
	CURRENT_TASK_ID = null;
	STATE = 'idle';
	generateBtn.disabled = false;
	progressFloat.classList.remove('visible');
	resetBtn.style.display = 'none';
	showToast('Generation cancelled');
});

/* Dictionary button */
document.getElementById('dictBtn').addEventListener('click', () => {
	loadDict();
	document.getElementById('dictModal').classList.remove('hidden');
	document.querySelector('#dictModal .dict-tab[data-tab=acronyms]').click();
});
document.getElementById('dictCloseBtn').addEventListener('click', () => {
	document.getElementById('dictModal').classList.add('hidden');
});
document.getElementById('dictModal').addEventListener('click', e => {
	if (e.target === e.currentTarget) document.getElementById('dictModal').classList.add('hidden');
});

/* Pause modal */
const PAUSE_LABELS = { '.': 'Period (.)', ',': 'Comma (,)', ';': 'Semicolon (;)', ':': 'Colon (:)', '?': 'Question (?)', '!': 'Exclamation (!)', 'linebreak': 'Line break' };

async function loadPauseConfig() {
	try {
		const res = await fetch(`${API_BASE}/tts/pause_config`);
		const cfg = await res.json();
		const enabled = cfg.enabled !== false;
		const pauses = cfg.pauses || {};
		const toggle = document.getElementById('pauseToggle');
		toggle.checked = enabled;
		updatePauseToggleUI(enabled);
		const container = document.getElementById('pauseSliders');
		container.innerHTML = Object.keys(pauses).map(k => `
      <div class="pause-slider-row">
        <span class="pause-slider-label">${PAUSE_LABELS[k] || k}</span>
        <input type="range" min="0" max="2" step="0.05" value="${pauses[k]}" data-key="${k}">
        <span class="pause-slider-val">${pauses[k].toFixed(2)}s</span>
      </div>`).join('');
		container.querySelectorAll('input[type=range]').forEach(slider => {
			slider.addEventListener('input', onPauseSliderChange);
		});
	} catch (e) { console.error('Pause load:', e); }
}

function onPauseSliderChange(e) {
	const val = parseFloat(e.target.value);
	e.target.nextElementSibling.textContent = val.toFixed(2) + 's';
}

function onPauseToggle() {
	const enabled = document.getElementById('pauseToggle').checked;
	updatePauseToggleUI(enabled);
}

function updatePauseToggleUI(enabled) {
	const label = document.getElementById('pauseToggleLabel');
	label.textContent = enabled ? 'ON' : 'OFF';
	document.querySelectorAll('#pauseSliders input').forEach(s => s.disabled = !enabled);
}

async function savePauseConfig() {
	const enabled = document.getElementById('pauseToggle').checked;
	const sliders = document.querySelectorAll('#pauseSliders input[type=range]');
	const pauses = {};
	sliders.forEach(s => { pauses[s.dataset.key] = parseFloat(s.value); });
	try {
		const r = await fetch(`${API_BASE}/tts/pause_config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ config: { enabled, pauses } }),
		});
		PAUSE_CFG = await r.json();
		updateCharCount();
	} catch (e) { console.error('Pause save:', e); }
}

document.getElementById('pauseBtn').addEventListener('click', () => {
	loadPauseConfig();
	document.getElementById('pauseModal').classList.remove('hidden');
});
document.getElementById('pauseCloseBtn').addEventListener('click', () => {
	document.getElementById('pauseModal').classList.add('hidden');
});
document.getElementById('pauseSaveBtn').addEventListener('click', async () => {
	await savePauseConfig();
	document.getElementById('pauseModal').classList.add('hidden');
});
document.getElementById('pauseModal').addEventListener('click', e => {
	if (e.target === e.currentTarget) document.getElementById('pauseModal').classList.add('hidden');
});

/* History */
document.getElementById('historyBtn').addEventListener('click', async () => {
	const modal = document.getElementById('historyModal');
	modal.classList.remove('hidden');
	await loadHistory();
});
document.getElementById('historyCloseBtn').addEventListener('click', () => {
	document.getElementById('historyModal').classList.add('hidden');
});
document.getElementById('historyClearBtn').addEventListener('click', async () => {
	if (!confirm('Clear all history and audio files?')) return;
	await fetch(`${API_BASE}/tts/history`, { method: 'DELETE' });
	await loadHistory();
});
document.getElementById('historyModal').addEventListener('click', e => {
	if (e.target === e.currentTarget) document.getElementById('historyModal').classList.add('hidden');
});

async function loadHistory() {
	try {
		const res = await fetch(`${API_BASE}/tts/history`);
		const entries = await res.json();
		const container = document.getElementById('historyList');
		if (!entries || entries.length === 0) {
			container.innerHTML = '<div class="hist-empty">No history yet</div>';
			return;
		}
		container.innerHTML = entries.map((e, i) => {
			const date = new Date((e.timestamp || 0) * 1000);
			const timeStr = date.toLocaleString();
			const txt = (e.text || '').slice(0, 80);
			return `<div class="hist-item">
        <div class="hist-info">
          <div class="hist-text">${escapeHtml(txt)}</div>
          <div class="hist-meta">${timeStr} &middot; ${e.duration || '?'}s &middot; ${e.voice_id || ''}</div>
        </div>
        <div class="hist-actions">
          <button onclick="playHistory('${e.id}')" title="Play">
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
          <button onclick="downloadHistory('${e.id}')" title="Download">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button onclick="deleteHistory('${e.id}')" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;
		}).join('');
	} catch (e_) { console.error('History:', e_); }
}

function playHistory(id) {
	const url = `${API_BASE}/tts/download_file?path=${id}/final.mp3`;
	const old = document.getElementById('chunkPlayer');
	if (old) old.remove();
	const wrap = document.createElement('div');
	wrap.id = 'chunkPlayer';
	wrap.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius-md);padding:10px 18px;box-shadow:var(--shadow-lg);z-index:300;display:flex;align-items:center;gap:12px;';
	const aud = document.createElement('audio');
	aud.src = url;
	aud.controls = true;
	aud.style.cssText = 'height:34px;';
	const close = document.createElement('button');
	close.innerHTML = '&times;';
	close.style.cssText = 'border:none;background:none;font-size:22px;cursor:pointer;color:var(--text-muted);padding:0 4px;line-height:1;';
	close.onclick = () => wrap.remove();
	wrap.appendChild(aud);
	wrap.appendChild(close);
	document.body.appendChild(wrap);
	aud.play().catch(() => { });
}

function downloadHistory(id) {
	const a = document.createElement('a');
	a.href = `${API_BASE}/tts/download_file?path=${id}/final.mp3`;
	a.download = `tts_${id}.mp3`;
	a.click();
}

async function deleteHistory(id) {
	await fetch(`${API_BASE}/tts/history/${id}`, { method: 'DELETE' });
	await loadHistory();
}

function toggleSingleEdit() {
	const display = document.getElementById('singleTextDisplay');
	const ta = document.getElementById('singleTextEdit');
	const btn = document.getElementById('singleEditBtn');
	if (!display || !ta) return;
	if (ta.style.display === 'none') {
		display.style.display = 'none';
		ta.style.display = 'block';
		ta.focus();
		ta.style.borderColor = 'var(--accent-primary)';
		btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><polyline points="20 6 9 17 4 12"/></svg> Save';
	} else {
		display.style.display = 'block';
		ta.style.display = 'none';
		display.textContent = ta.value;
		const c = CHUNK_DATA.find(x => x.index === 0);
		if (c) c.text = ta.value.trim();
		btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit';
		showToast('Text updated');
	}
}

async function retrySingle() {
	const btn = document.getElementById('singleRetryBtn');
	if (!btn) return;
	const ta = document.getElementById('singleTextEdit');
	const display = document.getElementById('singleTextDisplay');
	const text = ta && ta.style.display !== 'none' ? ta.value.trim() : (display ? display.textContent.trim() : '');
	if (!text) return;

	btn.disabled = true;
	btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;animation:spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-dasharray="30 70"/></svg> Retrying...';

	await _regenChunk(0, text);

	btn.disabled = false;
	btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Retry';
}

/* Chunk rendering */
function renderChunks(chunks) {
	if (!chunks || chunks.length === 0) {
		chunkList.innerHTML = '<div class="no-chunks">No segments yet. Generate audio to begin.</div>';
		chunkCount.textContent = '';
		chunkPagination.style.display = 'none';
		mergeSection.classList.add('hidden');
		segmentFilters.style.display = 'none';
		batchActions.style.display = 'none';
		return;
	}

	CHUNK_DATA = chunks;
	const doneCount = chunks.filter(c => c.status === 'done').length;
	const warningCount = chunks.filter(c => c.warning).length;
	const errorCount = chunks.filter(c => c.status === 'error').length;

	chunkCount.textContent = `(${chunks.length} segments · ${doneCount} done${warningCount > 0 ? ` · ${warningCount} ⚠` : ''}${errorCount > 0 ? ` · ${errorCount} ✗` : ''})`;

	// Show filters and batch actions when multiple chunks
	if (chunks.length > 1) {
		segmentFilters.style.display = 'flex';
		batchActions.style.display = 'flex';
	} else {
		segmentFilters.style.display = 'none';
		batchActions.style.display = 'none';
	}

	chunkPagination.style.display = 'none';

	// Filter chunks
	let filteredChunks = chunks;
	if (CURRENT_FILTER !== 'all') {
		if (CURRENT_FILTER === 'done') filteredChunks = chunks.filter(c => c.status === 'done');
		else if (CURRENT_FILTER === 'warning') filteredChunks = chunks.filter(c => c.warning);
		else if (CURRENT_FILTER === 'failed') filteredChunks = chunks.filter(c => c.status === 'error');
		else if (CURRENT_FILTER === 'processing') filteredChunks = chunks.filter(c => c.status === 'processing');
	}

	// Single chunk (non-split mode)
	if (chunks.length === 1) {
		const c = chunks[0];
		const isDone = c.status === 'done';
		const isProcessing = c.status === 'processing';
		chunkList.innerHTML = `
      <div class="card" style="margin:0;padding:16px;background:var(--bg-primary);border-radius:var(--radius-md);min-height:200px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span style="font-size:12px;color:var(--text-muted);font-weight:600;text-transform:uppercase;">Generated Audio</span>
          <div style="display:flex;gap:6px;">
            ${isDone ? `<button class="btn-sm" id="singleEditBtn" onclick="toggleSingleEdit()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>` : ''}
            ${isDone ? `<button class="btn-sm" id="singleRetryBtn" onclick="retrySingle()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Retry
            </button>` : ''}
          </div>
        </div>
        <div id="singleTextDisplay" style="width:100%;min-height:120px;font-size:13px;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:10px;color:var(--text-primary);white-space:pre-wrap;word-break:break-word;">${escapeHtml(c.text)}</div>
        <textarea id="singleTextEdit" style="display:none;width:100%;min-height:120px;font-size:13px;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:10px;color:var(--text-primary);font-family:inherit;resize:vertical;outline:none;">${escapeHtml(c.text)}</textarea>
        ${isDone ? `<div style="margin-top:12px;text-align:center;color:var(--text-muted);font-size:13px;">✓ Audio ready — see Final Audio bar below</div>` : `
        <div style="margin-top:12px;text-align:center;color:var(--text-muted);font-size:13px;padding:20px;">
          ${isProcessing ? '<span style="display:inline-block;width:12px;height:12px;border:2px solid var(--card-border);border-top-color:var(--accent-primary);border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:6px;"></span>Generating...' : 'Queued...'}
        </div>`}
      </div>`;
		mergeSection.classList.add('hidden');
		return;
	}

	// Multiple chunks (split mode) — show compact list with pagination
	const totalPages = Math.ceil(filteredChunks.length / CHUNK_PER_PAGE);
	if (CHUNK_PAGE >= totalPages) CHUNK_PAGE = totalPages - 1;
	if (CHUNK_PAGE < 0) CHUNK_PAGE = 0;

	const start = CHUNK_PAGE * CHUNK_PER_PAGE;
	const pageChunks = filteredChunks.slice(start, start + CHUNK_PER_PAGE);

	if (totalPages > 1) {
		chunkPagination.style.display = 'flex';
		pageInfo.textContent = `${CHUNK_PAGE + 1}/${totalPages}`;
		pagePrev.disabled = CHUNK_PAGE === 0;
		pageNext.disabled = CHUNK_PAGE >= totalPages - 1;
	} else {
		chunkPagination.style.display = 'none';
	}

	let html = '';
	for (const c of pageChunks) {
		const hasWarning = c.warning || false;
		const statusClass = c.status === 'processing' ? 'processing' : c.status === 'done' ? (hasWarning ? 'warning' : 'done') : c.status === 'error' ? 'error' : '';
		const icon = c.status === 'pending' ? '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><circle cx="12" cy="12" r="4"/></svg>' : c.status === 'processing' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px;animation:spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-dasharray="30 70"/></svg>' : c.status === 'done' ? (hasWarning ? '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M12 2L1 21h22L12 2zm0 4l7.53 13H4.47L12 6z"/><circle cx="12" cy="15" r="1.5"/><line x1="12" y1="9" x2="12" y2="12" stroke="currentColor" stroke-width="2"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="width:14px;height:14px;"><polyline points="20 6 9 17 4 12"/></svg>') : c.status === 'error' ? '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><circle cx="12" cy="12" r="4"/></svg>';
		const iconColor = c.status === 'pending' ? 'var(--text-muted)' : c.status === 'processing' ? '#4a9e7a' : c.status === 'done' ? (hasWarning ? '#d4a832' : 'var(--success)') : '#c44';
		const preview = c.text.length > 60 ? c.text.slice(0, 60) + '...' : c.text;
		const duration = c.duration ? ` ${formatDuration(c.duration)}` : '';
		const glowClass = c.status === 'processing' ? 'segment-glow' : '';

		html += `
      <div class="chunk-item ${statusClass} ${glowClass}" data-index="${c.index}" data-status="${c.status}" data-warning="${hasWarning}">
        <div class="chunk-header" onclick="toggleChunk(${c.index})">
          <span class="chunk-index">${c.index + 1}</span>
          <span class="chunk-status-icon" style="color:${iconColor}">${icon}</span>
          <span class="chunk-text-preview">${escapeHtml(preview)}</span>
          ${duration ? `<span style="font-size:11px;color:var(--text-muted);font-family:'JetBrains Mono',monospace;flex-shrink:0;">${duration}</span>` : ''}
          <span class="chunk-actions">
            ${c.status === 'done' ? `<button onclick="event.stopPropagation();playChunk(${c.index})" title="Play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>` : ''}
            ${c.status === 'done' ? `<button onclick="event.stopPropagation();downloadChunk(${c.index})" title="Download"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>` : ''}
            ${c.status === 'done' || c.status === 'error' ? `<button onclick="event.stopPropagation();retryChunk(${c.index})" title="Retry"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>` : ''}
            <button onclick="event.stopPropagation();toggleEdit(${c.index})" title="Edit" id="editBtn_${c.index}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          </span>
        </div>
        <div class="chunk-body" id="chunkBody_${c.index}">
          ${chunks.length > 1 ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--text-muted);flex-shrink:0;font-weight:600;">Voice:</span>
            <select id="chunkVoice_${c.index}" onchange="updateChunkVoice(${c.index},this.value)" style="flex:1;min-width:120px;padding:5px 8px;border:1px solid var(--card-border);border-radius:var(--radius-sm);font-size:12px;background:var(--card-bg);color:var(--text-secondary);font-family:inherit;">
              ${_voiceOptGroups(CURRENT_VOICE_MODE, c.voice_id || CURRENT_VOICE_ID, '', '')}
            </select>
            <select id="chunkVoiceGender_${c.index}" onchange="_refreshChunkVoices(${c.index})" style="padding:5px 6px;border:1px solid var(--card-border);border-radius:var(--radius-sm);font-size:11px;background:var(--card-bg);color:var(--text-secondary);font-family:inherit;">
              <option value="">Gender</option>
              <option value="male">♂ Male</option>
              <option value="female">♀ Female</option>
            </select>
            <select id="chunkVoiceType_${c.index}" onchange="_refreshChunkVoices(${c.index})" style="padding:5px 6px;border:1px solid var(--card-border);border-radius:var(--radius-sm);font-size:11px;background:var(--card-bg);color:var(--text-secondary);font-family:inherit;">
              <option value="">Type</option>
              <option value="clone">Clone</option>
              <option value="default">Default</option>
            </select>
          </div>` : ''}
          <textarea id="chunkText_${c.index}" readonly>${escapeHtml(c.text)}</textarea>
          ${hasWarning || (c.issues && c.issues.length > 0) ? `<div style="margin-top:8px;padding:8px 12px;background:var(--warning-light);border-radius:var(--radius-sm);font-size:12px;color:var(--warning);">${(c.issues || []).map(i => `<div style="margin:2px 0">⚠ <strong>${i.message}</strong>${i.details && i.details.duration_sec ? ` (${i.details.duration_sec}s)` : ''}</div>`).join('') || '⚠ Audio quality warning detected'}</div>` : ''}
        </div>
      </div>`;
	}
	chunkList.innerHTML = html;
}

function formatDuration(seconds) {
	const min = Math.floor(seconds / 60);
	const sec = Math.floor(seconds % 60);
	return min > 0 ? `${min}:${sec.toString().padStart(2, '0')}` : `0:${sec.toString().padStart(2, '0')}`;
}

pagePrev.addEventListener('click', () => { if (CHUNK_PAGE > 0) { CHUNK_PAGE--; renderChunks(CHUNK_DATA); } });
pageNext.addEventListener('click', () => {
	const totalPages = Math.ceil(CHUNK_DATA.length / CHUNK_PER_PAGE);
	if (CHUNK_PAGE < totalPages - 1) { CHUNK_PAGE++; renderChunks(CHUNK_DATA); }
});

// Segment filters
document.querySelectorAll('.segment-filter-btn').forEach(btn => {
	btn.addEventListener('click', () => {
		document.querySelectorAll('.segment-filter-btn').forEach(b => b.classList.remove('active'));
		btn.classList.add('active');
		CURRENT_FILTER = btn.dataset.filter;
		CHUNK_PAGE = 0;
		renderChunks(CHUNK_DATA);
	});
});

// Batch actions
document.getElementById('retryFailedBtn').addEventListener('click', async () => {
	const failed = CHUNK_DATA.filter(c => c.status === 'error');
	if (failed.length === 0) { showToast('No failed segments'); return; }
	for (const c of failed) {
		await _regenChunk(c.index, c.text);
	}
	showToast(`Retrying ${failed.length} failed segment${failed.length > 1 ? 's' : ''}`);
});

document.getElementById('retryWarningBtn').addEventListener('click', async () => {
	const warnings = CHUNK_DATA.filter(c => c.warning);
	if (warnings.length === 0) { showToast('No warning segments'); return; }
	for (const c of warnings) {
		await _regenChunk(c.index, c.text);
	}
	showToast(`Retrying ${warnings.length} warning segment${warnings.length > 1 ? 's' : ''}`);
});

document.getElementById('collapseAllBtn').addEventListener('click', () => {
	document.querySelectorAll('.chunk-body').forEach(body => body.classList.remove('open'));
});

document.getElementById('expandFailedBtn').addEventListener('click', () => {
	document.querySelectorAll('.chunk-body').forEach(body => body.classList.remove('open'));
	CHUNK_DATA.filter(c => c.status === 'error' || c.warning).forEach(c => {
		const body = document.getElementById(`chunkBody_${c.index}`);
		if (body) body.classList.add('open');
	});
});

function toggleAdv(el) {
	const p = document.getElementById('advPanel');
	p.classList.toggle('hidden');
	el.classList.toggle('open');
}

function toggleChunk(index) {
	const body = document.getElementById(`chunkBody_${index}`);
	if (body) body.classList.toggle('open');
}

function toggleEdit(index) {
	const ta = document.getElementById(`chunkText_${index}`);
	const body = document.getElementById(`chunkBody_${index}`);
	const btn = document.getElementById(`editBtn_${index}`);
	if (!ta || !body) return;

	// Expand body if collapsed
	if (!body.classList.contains('open')) {
		body.classList.add('open');
	}

	// Toggle readonly
	if (ta.readOnly) {
		ta.readOnly = false;
		ta.focus();
		ta.style.borderColor = 'var(--accent-primary)';
		ta.style.boxShadow = '0 0 0 3px rgba(91,122,106,0.1)';
		btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
		btn.title = 'Save';
	} else {
		ta.readOnly = true;
		ta.style.borderColor = '';
		ta.style.boxShadow = '';
		btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
		btn.title = 'Edit';
		// Update chunk data with edited text
		const c = CHUNK_DATA.find(x => x.index === index);
		if (c) c.text = ta.value.trim();
		showToast('Segment ' + (index + 1) + ' updated');
	}
}

function escapeHtml(s) {
	const d = document.createElement('div');
	d.textContent = s;
	return d.innerHTML;
}

function downloadChunk(index) {
	const d = CHUNK_DATA.find(x => x.index === index);
	if (!d || !d.audio_url) return;
	const a = document.createElement('a');
	a.href = `${API_BASE}${d.audio_url}&format=wav`;
	a.download = `segment_${index + 1}.wav`;
	a.click();
}

function downloadAllChunks() {
	const done = CHUNK_DATA.filter(c => c.status === 'done' && c.audio_url);
	if (done.length === 0) { showToast('No segments to download'); return; }
	if (typeof JSZip !== 'undefined') {
		const zip = new JSZip();
		showToast('Preparing zip...');
		Promise.all(done.map(async c => {
			try {
				const res = await fetch(`${API_BASE}${c.audio_url}&format=wav`);
				if (res.ok) zip.file(`segment_${c.index + 1}.wav`, await res.blob());
			} catch (_) { }
		})).then(() => zip.generateAsync({ type: 'blob' })).then(blob => {
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = `segments_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.zip`;
			a.click(); URL.revokeObjectURL(a.href);
			showToast(`Downloaded ${done.length} segments`);
		});
	} else {
		for (const c of done) {
			setTimeout(() => {
				const a = document.createElement('a');
				a.href = `${API_BASE}${c.audio_url}&format=wav`;
				a.download = `segment_${c.index + 1}.wav`;
				a.click();
			}, c.index * 500);
		}
		showToast(`Downloading ${done.length} segments`);
	}
}

function _refreshChunkVoices(index) {
	const sel = document.getElementById('chunkVoice_' + index);
	if (!sel) return;
	const c = CHUNK_DATA.find(x => x.index === index);
	if (!c) return;
	const gf = document.getElementById('chunkVoiceGender_' + index)?.value || '';
	const tf = document.getElementById('chunkVoiceType_' + index)?.value || '';
	const cur = c.voice_id || CURRENT_VOICE_ID;
	sel.innerHTML = _voiceOptGroups(CURRENT_VOICE_MODE, cur, gf, tf);
}

function _voiceOptGroups(mode, selectedId, genderFilter, typeFilter) {
	let list = ALL_VOICES[mode] || [];
	if (genderFilter) list = list.filter(v => v.gender === genderFilter);
	if (typeFilter === 'clone') list = list.filter(v => v.is_clone);
	else if (typeFilter === 'default') list = list.filter(v => !v.is_clone);
	const clones = list.filter(v => v.is_clone);
	const defaults = list.filter(v => !v.is_clone);
	const opt = (v) => {
		const g = v.gender === 'male' ? '\u2642 ' : v.gender === 'female' ? '\u2640 ' : '';
		const sel = v.id === selectedId ? ' selected' : '';
		return `<option value="${v.id}"${sel}>${g}${escapeHtml(v.label)}</option>`;
	};
	let html = '';
	if (clones.length) html += `<optgroup label="\u2605 Clone Voices">${clones.map(opt).join('')}</optgroup>`;
	if (defaults.length) html += `<optgroup label="Default Voices">${defaults.map(opt).join('')}</optgroup>`;
	return html;
}

function updateChunkVoice(index, voiceId) {
	const c = CHUNK_DATA.find(x => x.index === index);
	if (c) {
		c.voice_id = voiceId;
	}
}

function playChunk(index) {
	const c = CHUNK_DATA.find(x => x.index === index);
	if (!c || !c.audio_url) return;
	const old = document.getElementById('chunkPlayer');
	if (old) old.remove();
	const wrap = document.createElement('div');
	wrap.id = 'chunkPlayer';
	wrap.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius-md);padding:10px 18px;box-shadow:var(--shadow-lg);z-index:300;display:flex;align-items:center;gap:12px;';
	const label = document.createElement('span');
	label.style.cssText = 'font-size:13px;color:var(--text-primary);white-space:nowrap;font-weight:600;';
	label.textContent = 'Segment ' + (index + 1) + ':';
	const aud = document.createElement('audio');
	aud.src = `${API_BASE}${c.audio_url}`;
	aud.controls = true;
	aud.style.cssText = 'height:34px;';
	const close = document.createElement('button');
	close.innerHTML = '&times;';
	close.style.cssText = 'border:none;background:none;font-size:22px;cursor:pointer;color:var(--text-muted);padding:0 4px;line-height:1;';
	close.onclick = () => wrap.remove();
	wrap.appendChild(label);
	wrap.appendChild(aud);
	wrap.appendChild(close);
	document.body.appendChild(wrap);
	aud.play().catch(() => { });
}

async function retryChunk(index) {
	const btn = document.querySelector(`.chunk-item[data-index="${index}"] .chunk-actions button[title="Retry"]`);
	if (btn) {
		btn.disabled = true;
		btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;animation:spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-dasharray="30 70"/></svg>';
	}
	const ta = document.getElementById(`chunkText_${index}`);
	const text = ta ? ta.value.trim() : (CHUNK_DATA.find(x => x.index === index)?.text || '');
	if (!text) return;
	const c = CHUNK_DATA.find(x => x.index === index);
	if (c && ta) c.text = text;
	await _regenChunk(index, text);
	if (btn) {
		btn.disabled = false;
		btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
	}
}

async function _regenChunk(index, text) {
	if (!CURRENT_TASK_ID) return;
	const c = CHUNK_DATA.find(x => x.index === index);
	const vid = c?.voice_id || CURRENT_VOICE_ID;
	try {
		const res = await fetch(`${API_BASE}/tts/regenerate_chunk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ task_id: CURRENT_TASK_ID, chunk_index: index, text, voice_id: vid }),
		});
		if (!res.ok) throw new Error('Regen failed');
		const data = await res.json();
		const c = CHUNK_DATA.find(x => x.index === index);
		if (c) { c.status = 'done'; c.audio_url = data.audio_url; c.text = text; }
		renderChunks(CHUNK_DATA);
		const statusRes = await fetch(`${API_BASE}/tts/status/${CURRENT_TASK_ID}`);
		if (statusRes.ok) {
			const statusData = await statusRes.json();
			renderChunks(statusData.chunks || []);
		}
		showToast('Segment ' + (index + 1) + ' regenerated');
	} catch (e) { showError('Regen chunk: ' + e.message); }
}

function showToast(msg) {
	const old = document.querySelector('.toast');
	if (old) old.remove();
	const t = document.createElement('div');
	t.className = 'toast'; t.textContent = msg;
	document.body.appendChild(t);
	setTimeout(() => t.remove(), 2000);
}

/* Dictionary */
function switchDictTab(tab) {
	document.querySelectorAll('.dict-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
	document.getElementById('dictAcronyms').classList.toggle('hidden', tab !== 'acronyms');
	document.getElementById('dictWords').classList.toggle('hidden', tab !== 'words');
}

async function loadDict() {
	try {
		const [ar, wr] = await Promise.all([
			fetch(`${API_BASE}/tts/dict/acronyms`).then(r => r.json()),
			fetch(`${API_BASE}/tts/dict/words`).then(r => r.json()),
		]);
		renderDictTable('acroBody', ar.entries, 'acronyms');
		renderDictTable('wordBody', wr.entries, 'words');
	} catch (e) { console.error('Dict load:', e); }
}

function renderDictTable(bodyId, entries, type) {
	const body = document.getElementById(bodyId);
	if (!entries || entries.length === 0) {
		body.innerHTML = '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;padding:16px;font-size:12px;">No entries yet</td></tr>';
		return;
	}
	body.innerHTML = entries.map((e, i) => `
    <tr>
      <td><input type="text" value="${escapeHtml(e.key)}" id="${type}_key_${i}" placeholder="e.g. vtv"></td>
      <td><input type="text" value="${escapeHtml(e.value)}" id="${type}_val_${i}" placeholder="pronunciation"></td>
      <td style="white-space:nowrap;">
        <button class="btn-dict-del" onclick="saveDictRow('${type}', ${i})" title="Save">&#10003;</button>
        <button class="btn-dict-del" onclick="deleteDictRow('${type}', '${escapeHtml(e.key)}')" title="Delete">&#10005;</button>
      </td>
    </tr>`).join('');
}

async function saveDictRow(type, idx) {
	const keyEl = document.getElementById(`${type}_key_${idx}`);
	const valEl = document.getElementById(`${type}_val_${idx}`);
	const key = keyEl.value.trim();
	const value = valEl.value.trim();
	if (!key || !value) { showToast('Both fields required'); return; }

	const endpoint = type === 'acronyms' ? '/tts/dict/acronyms' : '/tts/dict/words';
	try {
		const res = await fetch(`${API_BASE}${endpoint}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ key, value }),
		});
		if (!res.ok) throw new Error('Save failed');
		const data = await res.json();
		renderDictTable(type === 'acronyms' ? 'acroBody' : 'wordBody', data.entries, type);
		showToast('Saved');
	} catch (e) { showToast('Error: ' + e.message); }
}

async function deleteDictRow(type, key) {
	const endpoint = type === 'acronyms' ? '/tts/dict/acronyms' : '/tts/dict/words';
	try {
		const res = await fetch(`${API_BASE}${endpoint}?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
		if (!res.ok) throw new Error('Delete failed');
		const data = await res.json();
		renderDictTable(type === 'acronyms' ? 'acroBody' : 'wordBody', data.entries, type);
		showToast('Deleted');
	} catch (e) { showToast('Error: ' + e.message); }
}

function addDictRow(type) {
	const bodyId = type === 'acronyms' ? 'acroBody' : 'wordBody';
	const body = document.getElementById(bodyId);
	const idx = body.children.length;
	body.insertAdjacentHTML('beforeend', `
    <tr>
      <td><input type="text" value="" id="${type}_key_${idx}" placeholder="e.g. vtv"></td>
      <td><input type="text" value="" id="${type}_val_${idx}" placeholder="pronunciation"></td>
      <td style="white-space:nowrap;">
        <button class="btn-dict-del" onclick="saveDictRow('${type}', ${idx})" title="Save">&#10003;</button>
        <button class="btn-dict-del" onclick="this.closest('tr').remove()" title="Cancel">&#10005;</button>
      </td>
    </tr>`);
	document.getElementById(`${type}_key_${idx}`)?.focus();
}

/* Modal */
newVoiceBtn.addEventListener('click', () => {
	voiceLabModal.classList.remove('hidden');
	cloneVoiceName.value = ''; cloneVoiceGender.value = 'male'; cloneVoiceDesc.value = ''; cloneRefAudio.value = ''; cloneRefAudio.type = 'text'; cloneRefAudio.type = 'file'; cloneRefText.value = '';
});
cloneCancelBtn.addEventListener('click', () => voiceLabModal.classList.add('hidden'));
cloneSaveBtn.addEventListener('click', async () => {
	const rawName = cloneVoiceName.value.trim();
	const gender = cloneVoiceGender.value;
	const description = cloneVoiceDesc.value.trim() || 'No description';
	const audioFile = cloneRefAudio.files[0];
	const refText = cloneRefText.value.trim();
	if (!rawName || !audioFile || !refText) { alert('Fill all fields and select an audio file'); return; }
	cloneSaveBtn.disabled = true; cloneSaveBtn.textContent = 'Uploading...';
	try {
		const fd = new FormData();
		fd.append('voice_id', rawName);
		fd.append('gender', gender);
		fd.append('description', description);
		fd.append('ref_text', refText);
		fd.append('ref_audio', audioFile);
		const res = await fetch(`${API_BASE}/tts/clone`, { method: 'POST', body: fd });
		if (!res.ok) throw new Error('Clone failed');
		const data = await res.json();
		voiceLabModal.classList.add('hidden');
		await loadVoices();
		CURRENT_VOICE_ID = data.voice_id;
		for (const m of ['medium', 'high', 'low']) {
			if ((ALL_VOICES[m] || []).find(v => v.id === data.voice_id)) {
				CURRENT_VOICE_MODE = m; break;
			}
		}
		updateVoiceLabel();
		showToast('Voice "' + (data.raw_name || rawName) + '" cloned');
	} catch (e) { alert('Error: ' + e.message); }
	cloneSaveBtn.disabled = false; cloneSaveBtn.textContent = 'Save Voice';
});
voiceLabModal.addEventListener('click', e => { if (e.target === voiceLabModal) voiceLabModal.classList.add('hidden'); });

function showError(msg) { errorDisplay.textContent = msg; errorDisplay.classList.remove('hidden'); }
function hideError() { errorDisplay.classList.add('hidden'); }

/* Resources modal + Download */
let RESOURCE_POLL = null;
let DL_POLL = null;

function getResourceIcon(name, size) {
	if (name === 'f5' || name === 'f5_model')
		return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:${size}px;height:${size}px;"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
	if (name === 'piper')
		return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:${size}px;height:${size}px;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:${size}px;height:${size}px;"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
}

function getResourceEngineLabel(name) {
	if (name === 'piper') return 'CPU · 15 voices';
	if (name === 'f5') return 'GPU · ~1.4GB';
	if (name === 'f5_voices') return 'Reference audio';
	if (name === 'omnivoice') return 'GPU · ~2.3GB';
	return 'GPU';
}

// ─── Resource Tab: Download ───

async function loadDownloadTab() {
	const container = document.getElementById('resourceDownloadTab');
	container.innerHTML = '<div class="no-chunks" style="padding:20px;">Loading...</div>';
	try {
		const [cat, dl] = await Promise.all([
			fetch(`${API_BASE}/tts/resource_catalog`).then(r => r.json()),
			fetch(`${API_BASE}/tts/download_progress`).then(r => r.json()),
		]);
		renderDownloadTab(cat, dl);
	} catch (e) {
		container.innerHTML = '<div class="no-chunks" style="padding:20px;color:var(--error);">Failed to load catalog. Is the server running?</div>';
	}
}

function renderDownloadTab(catalog, dlState) {
	const container = document.getElementById('resourceDownloadTab');
	container.innerHTML = catalog.map(r => {
		const dl = dlState[r.id] || { status: 'none', progress: 0, current_file: '', error: '' };
		const downloading = dl.status === 'downloading';
		const done = r.downloaded;
		const error = dl.status === 'error';

		let btnHtml = '';
		if (downloading) {
			btnHtml = `<button class="resource-btn" disabled>Downloading…</button>`;
		} else if (done) {
			btnHtml = `<button class="resource-btn" disabled style="background:var(--success);border-color:var(--success);">&#10003; Downloaded</button>`;
		} else if (error) {
			btnHtml = `<button class="resource-btn" onclick="startDownload('${r.id}')" style="background:var(--error);border-color:var(--error);">Retry</button>`;
		} else {
			btnHtml = `<button class="resource-btn" onclick="startDownload('${r.id}')">Download (${r.total_size_mb}MB)</button>`;
		}

		let progressHtml = '';
		if (downloading) {
			progressHtml = `
        <div class="resource-progress-wrap">
          <div class="resource-progress-bg"><div class="resource-progress-fill" style="width:${dl.progress}%"></div></div>
          <div class="resource-progress-msg">${dl.current_file ? escapeHtml(dl.current_file.split('/').pop()) : 'Starting...'} — ${dl.progress}%</div>
        </div>`;
		} else if (error && dl.error) {
			progressHtml = `<div class="resource-progress-msg" style="color:var(--error);">${escapeHtml(dl.error)}</div>`;
		}

		const cardClass = done ? 'loaded' : downloading ? 'loading' : error ? 'error' : '';
		return `<div class="resource-card ${cardClass}">
      ${getResourceIcon(r.id, 22)}
      <div class="resource-info">
        <div class="resource-name">${escapeHtml(r.label)}</div>
        <div class="resource-engine">${getResourceEngineLabel(r.id)} · ${r.total_size_mb}MB · ${r.existing_files}/${r.total_files} files</div>
        ${progressHtml}
      </div>
      ${btnHtml}
    </div>`;
	}).join('') || '<div class="no-chunks">No resources available</div>';
}

// ─── Resource Tab: Load Models ───

async function loadModelsTab() {
	const container = document.getElementById('resourceModelsTab');
	container.innerHTML = '<div class="no-chunks" style="padding:20px;">Loading...</div>';
	try {
		const res = await fetch(`${API_BASE}/tts/model_status`);
		const data = await res.json();
		renderModelsTab(data);
	} catch (e) {
		container.innerHTML = '<div class="no-chunks" style="padding:20px;color:var(--error);">Failed to fetch model status.</div>';
	}
}

function renderModelsTab(ms) {
	const container = document.getElementById('resourceModelsTab');
	const engines = [
		{ key: 'f5', label: 'F5-TTS (Medium · GPU)', state: (ms && ms.f5) || {} },
		{ key: 'omnivoice', label: 'OmniVoice (High · GPU)', state: (ms && ms.omnivoice) || {} },
	];

	container.innerHTML = engines.map(e => {
		const s = e.state;
		const loaded = s.loaded;
		const loading = s.loading;
		const progress = s.progress || 0;
		const message = s.message || '';
		const error = s.error;
		const cardClass = loaded ? 'loaded' : loading ? 'loading' : error ? 'error' : '';
		const badgeClass = loaded ? 'loaded' : loading ? 'loading' : error ? 'unloaded' : 'unloaded';
		const badgeText = loaded ? 'Loaded ✓' : loading ? 'Loading...' : error ? 'Error' : 'Not Loaded';
		const btnDisabled = loaded || loading;
		const btnText = loaded ? 'Loaded' : loading ? 'Loading...' : 'Load Model';

		let progHtml = '';
		if (loading) {
			progHtml = `<div class="resource-progress-wrap"><div class="resource-progress-bg"><div class="resource-progress-fill" style="width:${progress}%"></div></div><div class="resource-progress-msg">${escapeHtml(message)}</div></div>`;
		} else if (error && message) {
			progHtml = `<div class="resource-progress-msg" style="color:var(--error);">${escapeHtml(message)}</div>`;
		}

		return `<div class="resource-card ${cardClass}">
      ${getResourceIcon(e.key === 'f5' ? 'f5' : 'omnivoice', 22)}
      <div class="resource-info">
        <div class="resource-name">${e.label}</div>
        <span class="resource-status-badge ${badgeClass}">${badgeText}</span>
        ${progHtml}
      </div>
      <button class="resource-btn" ${btnDisabled ? 'disabled' : ''} onclick="loadModel('${e.key}')">${btnText}</button>
    </div>`;
	}).join('');
}

// ─── Tab Switching ───

function switchResourceTab(tab) {
	document.querySelectorAll('#resourceModal .dict-tab').forEach(b => b.classList.toggle('active', b.dataset.rtab === tab));
	document.getElementById('resourceDownloadTab').classList.toggle('hidden', tab !== 'download');
	document.getElementById('resourceModelsTab').classList.toggle('hidden', tab !== 'models');
	if (tab === 'download') loadDownloadTab();
	else loadModelsTab();
}

// ─── Download Actions ───

async function startDownload(rid) {
	try {
		const res = await fetch(`${API_BASE}/tts/start_download`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ resource_id: rid }),
		});
		if (!res.ok) throw new Error('Start failed');
		startDownloadPoll();
	} catch (e) {
		showToast('Download: ' + e.message);
	}
}

function startDownloadPoll() {
	stopDownloadPoll();
	DL_POLL = setInterval(async () => {
		try {
			const [cat, dl] = await Promise.all([
				fetch(`${API_BASE}/tts/resource_catalog`).then(r => r.json()),
				fetch(`${API_BASE}/tts/download_progress`).then(r => r.json()),
			]);
			renderDownloadTab(cat, dl);
			const allDone = Object.values(dl).every(s => s.status !== 'downloading');
			if (allDone) {
				stopDownloadPoll();
				if (Object.values(dl).some(s => s.status === 'done')) {
					await loadVoices();
					showToast('Download complete!');
				}
			}
		} catch (e) { stopDownloadPoll(); }
	}, 1000);
}

function stopDownloadPoll() {
	if (DL_POLL) { clearInterval(DL_POLL); DL_POLL = null; }
}

// ─── Model Load ───

async function loadModel(model) {
	try {
		const res = await fetch(`${API_BASE}/tts/load_model`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model }),
		});
		if (!res.ok) throw new Error('Load failed');
		const data = await res.json();
		if (data.status === 'already_loaded') {
			loadModelsTab();
			return;
		}
		startModelPoll();
	} catch (e) {
		showToast('Error: ' + e.message);
		loadModelsTab();
	}
}

function startModelPoll() {
	stopModelPoll();
	RESOURCE_POLL = setInterval(async () => {
		try {
			const res = await fetch(`${API_BASE}/tts/model_status`);
			const data = await res.json();
			renderModelsTab(data);
			if (!data.f5.loading && !data.omnivoice.loading) {
				stopModelPoll();
				if (data.f5.loaded || data.omnivoice.loaded) {
					await loadVoices();
					showToast('Model loaded!');
				}
			}
		} catch (e) { stopModelPoll(); }
	}, 800);
}

function stopModelPoll() {
	if (RESOURCE_POLL) { clearInterval(RESOURCE_POLL); RESOURCE_POLL = null; }
}

// ─── Open / Close ───

async function openResourceModal() {
	stopDownloadPoll(); stopModelPoll();
	document.getElementById('resourceModal').classList.remove('hidden');
	// Activate download tab by default
	const active = document.querySelector('#resourceModal .dict-tab.active');
	switchResourceTab(active ? active.dataset.rtab : 'download');
}

document.getElementById('resourceBtn').addEventListener('click', openResourceModal);
document.getElementById('resourceCloseBtn').addEventListener('click', () => {
	stopDownloadPoll(); stopModelPoll();
	document.getElementById('resourceModal').classList.add('hidden');
});
document.getElementById('resourceModal').addEventListener('click', e => {
	if (e.target === e.currentTarget) {
		stopDownloadPoll(); stopModelPoll();
		document.getElementById('resourceModal').classList.add('hidden');
	}
});

// Help modal
// Theme toggle
const savedTheme = localStorage.getItem('capcap_theme') || '';
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('themeBtn').addEventListener('click', () => {
	const html = document.documentElement;
	const isDark = html.getAttribute('data-theme') === 'dark';
	if (isDark) { html.removeAttribute('data-theme'); localStorage.setItem('capcap_theme', ''); }
	else { html.setAttribute('data-theme', 'dark'); localStorage.setItem('capcap_theme', 'dark'); }
});

document.getElementById('helpBtn').addEventListener('click', () => {
	document.getElementById('helpModal').classList.remove('hidden');
});
document.getElementById('helpCloseBtn').addEventListener('click', () => {
	document.getElementById('helpModal').classList.add('hidden');
});
document.getElementById('helpModal').addEventListener('click', e => {
	if (e.target === e.currentTarget) document.getElementById('helpModal').classList.add('hidden');
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
	// Don't trigger shortcuts when typing in inputs
	if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

	if (e.code === 'Space') {
		e.preventDefault();
		if (audioPlayer.src) {
			audioPlayer.paused ? audioPlayer.play().catch(() => { }) : audioPlayer.pause();
		}
	} else if (e.key === 'r' || e.key === 'R') {
		// Retry first failed segment
		const failed = CHUNK_DATA.find(c => c.status === 'error');
		if (failed) retryChunk(failed.index);
	} else if (e.ctrlKey && e.key === 'Enter') {
		e.preventDefault();
		if (STATE === 'idle' || STATE === 'done' || STATE === 'error') {
			startGeneration();
		}
	}
});

updateCharCount(); updateSplitCheckbox(); updateModelConfig(); loadVoices();
fetch(`${API_BASE}/tts/pause_config`).then(r => r.json()).then(c => { PAUSE_CFG = c; updateCharCount(); }).catch(() => { });
