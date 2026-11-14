const $ = (id) => document.getElementById(id);
const store = {
    get: (k) => { try { return localStorage.getItem('zenflow-' + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem('zenflow-' + k, v); } catch { /* storage blocked */ } }
};
const RANGE = { focus: [5, 240, 5], breathe: [1, 15, 1] }; // [min, max, step] in minutes
const PATTERNS = {
    box: [['Inhale', 4], ['Hold', 4], ['Exhale', 4], ['Hold', 4]],
    relax: [['Inhale', 4], ['Hold', 7], ['Exhale', 8]],
    calm: [['Inhale', 5], ['Exhale', 5]]
};
const THEMES = { forest: 'Forest', ocean: 'Ocean', sunset: 'Sunset', lavender: 'Lavender' };
const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const fmtTime = (s) => `${s >= 3600 ? Math.floor(s / 3600) + ':' : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
const fmtMinutes = (m) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;

class ZenFlow {
    constructor() {
        const load = (k, d) => {
            const v = parseInt(store.get(k), 10);
            return v >= RANGE[k][0] && v <= RANGE[k][1] ? v : d;
        };
        this.cfg = { focus: load('focus', 25), breathe: load('breathe', 4) };
        this.pattern = PATTERNS[store.get('pattern')] ? store.get('pattern') : 'box';
        this.sound = store.get('sound') !== 'off';
        this.theme = THEMES[store.get('theme')] ? store.get('theme') : 'forest';
        this.mode = 'focus';
        this.saved = {}; // paused progress per mode, so switching modes never loses a session
        this.isRunning = false;
        this.timerId = null;
        this.raf = 0;
        this.endTime = null;
        this.phase = -1;
        this.audio = null;
        this.lock = null;
        this.totalTime = this.total('focus');
        this.timeLeft = this.totalTime;

        this.timeDisplay = $('time-display');
        this.display = document.querySelector('.timer-display');
        this.breatheText = $('breathe-text');
        this.breatheCount = $('breathe-count');
        this.circle = document.querySelector('.progress-ring__circle');
        this.btnStart = $('btn-start');
        this.btnReset = $('btn-reset');
        this.btnFocus = $('btn-focus');
        this.btnBreathe = $('btn-breathe');
        this.btnSound = $('btn-sound');
        this.btnTheme = $('btn-theme');
        this.timerContainer = document.querySelector('.timer-container');
        this.tasksContainer = document.querySelector('.tasks-container');
        this.durationDisplay = $('duration-display');
        this.durationLabel = $('duration-label');
        this.btnDecrease = $('btn-decrease');
        this.btnIncrease = $('btn-increase');
        this.taskInput = $('task-input');
        this.statusEl = $('status');
        this.sessionCount = $('session-count');
        this.patternSel = $('pattern');

        this.circumference = this.circle.r.baseVal.value * 2 * Math.PI;
        this.circle.style.strokeDasharray = `${this.circumference} ${this.circumference}`;
        this.frame = () => {
            if (!this.isRunning || this.mode !== 'breathe') { this.raf = 0; return; }
            this.renderBreath();
            this.raf = requestAnimationFrame(this.frame);
        };

        this.initListeners();
        this.updateUI();
        this.restore();
    }

    get cycle() { return PATTERNS[this.pattern]; }

    // Breathing sessions always end on a full breath, never mid-cycle.
    total(mode) {
        if (mode === 'focus') return this.cfg.focus * 60;
        const len = this.cycle.reduce((n, [, d]) => n + d, 0);
        return Math.max(1, Math.round((this.cfg.breathe * 60) / len)) * len;
    }

    get log() {
        const day = new Date().toDateString();
        try {
            const s = JSON.parse(store.get('log'));
            if (s && s.day === day) return s;
        } catch { /* fall through */ }
        return { day, n: 0, min: 0 };
    }

    initListeners() {
        this.btnStart.addEventListener('click', () => this.toggleTimer());
        this.btnReset.addEventListener('click', () => this.resetTimer());
        this.btnFocus.addEventListener('click', () => this.switchMode('focus'));
        this.btnBreathe.addEventListener('click', () => this.switchMode('breathe'));
        this.holdToRepeat(this.btnDecrease, -1);
        this.holdToRepeat(this.btnIncrease, 1);
        this.btnSound.addEventListener('click', () => {
            this.sound = !this.sound;
            store.set('sound', this.sound ? 'on' : 'off');
            this.unlockAudio();
            this.chime(this.mode); // preview
            this.updateUI();
        });
        this.applyTheme();
        this.btnTheme.addEventListener('click', () => {
            const keys = Object.keys(THEMES);
            this.theme = keys[(keys.indexOf(this.theme) + 1) % keys.length];
            store.set('theme', this.theme);
            this.applyTheme();
        });
        this.patternSel.value = this.pattern;
        this.patternSel.addEventListener('change', () => {
            this.pattern = this.patternSel.value;
            store.set('pattern', this.pattern);
            if (this.mode === 'breathe') this.totalTime = this.timeLeft = this.total('breathe');
            this.updateUI();
        });
        this.tasksContainer.addEventListener('click', (e) => { if (e.target !== this.taskInput) this.taskInput.focus(); });
        this.taskInput.addEventListener('focus', () => this.tasksContainer.classList.add('task-editing'));
        this.taskInput.addEventListener('blur', () => this.tasksContainer.classList.remove('task-editing'));
        this.taskInput.value = store.get('task') || '';
        const mark = () => this.tasksContainer.classList.toggle('has-task', !!this.taskInput.value.trim());
        mark();
        this.taskInput.addEventListener('input', () => { store.set('task', this.taskInput.value); mark(); });
        this.taskInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') this.taskInput.blur(); });
        document.addEventListener('visibilitychange', () => { if (this.isRunning) { this.tick(); this.holdAwake(); } });
        document.addEventListener('keydown', (e) => this.onKey(e));
    }

    applyTheme() {
        document.documentElement.dataset.theme = this.theme;
        this.txt(this.btnTheme, `Theme: ${THEMES[this.theme]}`);
    }

    holdToRepeat(btn, dir) { // click once, or hold to keep stepping
        let delay, rep;
        const stop = () => { clearTimeout(delay); clearInterval(rep); };
        btn.addEventListener('pointerdown', (e) => {
            if (e.button) return;
            stop();
            this.adjustTime(dir);
            delay = setTimeout(() => { rep = setInterval(() => (btn.disabled ? stop() : this.adjustTime(dir)), 80); }, 400);
            window.addEventListener('pointerup', stop, { once: true });
            window.addEventListener('pointercancel', stop, { once: true });
        });
        btn.addEventListener('pointerleave', stop);
        btn.addEventListener('click', (e) => { if (e.detail === 0) this.adjustTime(dir); }); // keyboard
    }

    onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return;
        if (e.target.closest('input, textarea, select, [contenteditable]')) return;
        const k = e.key.toLowerCase();
        if (k === ' ' && !e.target.closest('button')) { e.preventDefault(); this.toggleTimer(); }
        else if (k === 'r') this.resetTimer();
        else if (k === 'f') this.switchMode('focus');
        else if (k === 'b') this.switchMode('breathe');
    }

    switchMode(next) {
        if (this.mode === next) return;
        const prev = this.mode;
        const wasStarted = this.timeLeft < this.totalTime;
        this.pauseTimer();
        if (wasStarted) this.saved[prev] = this.timeLeft; else delete this.saved[prev];
        this.mode = next;
        this.totalTime = this.total(next);
        this.timeLeft = this.saved[next] ?? this.totalTime;
        this.say(wasStarted ? `${cap(prev)} paused. Your progress is saved.` : '');
        this.updateUI();
    }

    toggleTimer() {
        if (!this.isRunning) return this.startTimer();
        this.tick(); // may finish the session
        if (this.isRunning) this.pauseTimer();
    }

    startTimer() {
        if (this.timeLeft <= 0) this.timeLeft = this.totalTime;
        this.isRunning = true;
        this.phase = -1;
        this.endTime = Date.now() + this.timeLeft * 1000;
        this.timerId = setInterval(() => this.tick(), 250);
        this.tasksContainer.classList.add('active-task');
        store.set('run', JSON.stringify({ mode: this.mode, end: this.endTime }));
        this.holdAwake();
        this.unlockAudio();
        this.say('');
        this.updateUI();
        if (this.mode === 'breathe' && !this.raf) this.raf = requestAnimationFrame(this.frame);
    }

    pauseTimer() {
        if (this.isRunning) this.timeLeft = Math.max(0, Math.ceil((this.endTime - Date.now()) / 1000));
        this.isRunning = false;
        clearInterval(this.timerId);
        cancelAnimationFrame(this.raf);
        this.timerId = null;
        this.raf = 0;
        this.endTime = null;
        store.set('run', '');
        this.releaseAwake();
        this.tasksContainer.classList.remove('active-task');
        this.updateUI();
    }

    resetTimer() {
        this.pauseTimer();
        this.timeLeft = this.totalTime;
        delete this.saved[this.mode];
        this.say('');
        this.updateUI();
    }

    tick() {
        if (this.isRunning) this.timeLeft = Math.max(0, Math.ceil((this.endTime - Date.now()) / 1000));
        if (this.timeLeft <= 0) this.finish(); else this.updateUI();
    }

    finish() {
        const m = this.mode;
        const log = this.log;
        this.pauseTimer();
        this.timeLeft = this.totalTime; // ready for the next round
        delete this.saved[m];
        if (m === 'focus') {
            log.n++;
            log.min += this.cfg.focus;
            store.set('log', JSON.stringify(log));
        }
        this.say(m === 'focus'
            ? (log.n % 4 === 0 ? 'Four sessions done. Take a longer break.' : 'Focus complete. Try a short breathing break.')
            : 'Breathing complete. Feeling better?');
        this.updateUI();
        document.title = '✓ Done · ZenFlow';
        try { navigator.vibrate?.([200, 100, 200]); } catch { /* unsupported */ }
        this.chime(m);
    }

    adjustTime(dir) {
        if (this.timeLeft < this.totalTime) return; // locked once a session has started
        const [min, max, step] = RANGE[this.mode];
        this.cfg[this.mode] = Math.min(max, Math.max(min, this.cfg[this.mode] + dir * step));
        store.set(this.mode, this.cfg[this.mode]);
        this.totalTime = this.timeLeft = this.total(this.mode);
        this.updateUI();
    }

    say(msg) { this.statusEl.textContent = msg; }

    txt(el, value) {
        value = String(value);
        if (el.textContent !== value) el.textContent = value;
    }

    updateUI() {
        const m = this.mode;
        const started = this.timeLeft < this.totalTime;
        const clock = fmtTime(this.timeLeft);
        const log = this.log;
        this.txt(this.timeDisplay, clock);
        this.timeDisplay.classList.toggle('has-hours', this.totalTime >= 3600);
        document.title = started ? `${clock} · ZenFlow` : 'ZenFlow - Focus & Breathe';
        this.txt(this.btnStart, this.isRunning ? 'Pause' : started ? 'Resume' : 'Start');
        this.btnReset.disabled = !started;
        this.btnFocus.classList.toggle('active', m === 'focus');
        this.btnBreathe.classList.toggle('active', m === 'breathe');
        this.btnFocus.setAttribute('aria-pressed', m === 'focus');
        this.btnBreathe.setAttribute('aria-pressed', m === 'breathe');
        this.timerContainer.classList.toggle('breathe-mode', m === 'breathe');
        this.tasksContainer.classList.toggle('is-hidden', m === 'breathe');
        this.tasksContainer.toggleAttribute('inert', m === 'breathe');
        this.txt(this.durationDisplay, fmtMinutes(Math.round(this.totalTime / 60) || 1));
        this.txt(this.durationLabel, m);
        this.btnDecrease.disabled = started || this.cfg[m] <= RANGE[m][0];
        this.btnIncrease.disabled = started || this.cfg[m] >= RANGE[m][1];
        this.btnDecrease.setAttribute('aria-label', `Decrease ${m} time`);
        this.btnIncrease.setAttribute('aria-label', `Increase ${m} time`);
        this.txt(this.btnSound, `Sound: ${this.sound ? 'on' : 'off'}`);
        this.txt(this.sessionCount, `${log.n} · ${fmtMinutes(log.min)}`);
        this.patternSel.disabled = started;
        this.circle.style.strokeDashoffset = this.circumference * (1 - this.timeLeft / this.totalTime);

        if (m === 'breathe') {
            if (this.isRunning) this.renderBreath();
            else {
                this.txt(this.breatheText, started ? 'Paused' : 'Ready?');
                this.txt(this.breatheCount, '');
                if (!started) this.display.style.setProperty('--breath', 0);
            }
        }
    }

    // Phase and orb size derive from the clock, so text, countdown and orb always agree.
    renderBreath() {
        const cycle = this.cycle;
        const len = cycle.reduce((n, [, d]) => n + d, 0);
        const left = Math.max(0, (this.endTime - Date.now()) / 1000);
        let p = (this.totalTime - left) % len;
        let i = 0;
        while (i < cycle.length - 1 && p >= cycle[i][1]) p -= cycle[i++][1];
        const [name, dur] = cycle[i];
        const ease = 0.5 - Math.cos(Math.PI * (p / dur)) / 2;
        const level = name === 'Inhale' ? ease : name === 'Exhale' ? 1 - ease : cycle[i - 1][0] === 'Inhale' ? 1 : 0;
        this.display.style.setProperty('--breath', level.toFixed(3));
        this.txt(this.breatheText, name);
        this.txt(this.breatheCount, Math.max(1, Math.ceil(dur - p)));
        if (i !== this.phase) { this.phase = i; this.cue(name); }
    }

    async holdAwake() { // keep the screen on while a session runs
        try {
            if (!this.isRunning || document.hidden || this.lock || !navigator.wakeLock) return;
            this.lock = await navigator.wakeLock.request('screen');
            this.lock.addEventListener('release', () => { this.lock = null; });
        } catch { /* denied or unsupported */ }
    }

    releaseAwake() {
        try { this.lock?.release(); } catch { /* ignore */ }
        this.lock = null;
    }

    restore() { // a running session survives a page reload
        try {
            const r = JSON.parse(store.get('run'));
            store.set('run', '');
            if (!r || !RANGE[r.mode]) return;
            const left = Math.ceil((r.end - Date.now()) / 1000);
            if (left <= 0) { this.say('A session ended while you were away.'); return; }
            const total = this.total(r.mode);
            if (left > total) return;
            this.mode = r.mode;
            this.totalTime = total;
            this.timeLeft = left;
            this.startTimer();
        } catch { /* nothing to restore */ }
    }

    unlockAudio() { // must run inside a click so browsers allow sound
        try {
            this.audio = this.audio || new (window.AudioContext || window.webkitAudioContext)();
            if (this.audio.state === 'suspended') this.audio.resume();
        } catch { /* audio unsupported */ }
    }

    tone(freq, at, len, vol, type = 'sine') {
        const ctx = this.audio;
        const t = ctx.currentTime + 0.05 + at;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(vol, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + len + 0.05);
    }

    cue(name) { // soft pitch cue so breathing works with eyes closed
        if (!this.sound || !this.audio || name === 'Hold') return;
        try { this.tone(name === 'Inhale' ? 392 : 294, 0, 0.7, 0.05); } catch { /* ignore */ }
    }

    chime(mode) {
        if (!this.sound || !this.audio) return;
        try {
            if (this.audio.state === 'suspended') this.audio.resume();
            if (mode === 'focus') [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.18, 1.2, 0.16, 'triangle'));
            else [0, 2.8].forEach((at) => [[220, 0.2], [607, 0.06], [1188, 0.025]].forEach(([f, v]) => this.tone(f, at, 4, v)));
        } catch { /* ignore */ }
    }
}

document.addEventListener('DOMContentLoaded', () => new ZenFlow());
