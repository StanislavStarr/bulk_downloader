const QUEUE_PREFIX = 'ydbd:v2:queue:';
const ENGINE_KEY = 'ydbd:v3:engine';
const NEXT_ALARM = 'ydbd:v3:next';
const WATCHDOG_ALARM = 'ydbd:v3:watchdog';
const SESSION_PREFIX = 'ydbd:v6:session:';
const LOG_PREFIX = 'ydbd:v6:log:';
const SETTINGS_KEY = 'ydbd:v62:settings';
const UI_KEY = 'ydbd:v62:chrome-ui';
const DEFAULT_SETTINGS = Object.freeze({ hideChromeUi: true, eraseInterrupted: false, downloadFolder: '' });
const CONFIG = Object.freeze({
  maxConcurrent: 3,
  minConcurrent: 2,
  launchInterval: 1200,
  adaptive: true,
  recoverAfterSuccesses: 5,
  startTimeout: 25000,
  prepareTimeout: 27000,
  apiTimeout: 20000,
  lateWindow: 5 * 60000,
  unknownCooldown: 30000,
  networkCooldown: 10000,
  maxConsecutiveUiFailures: 0
});
const PROBLEM_STATES = new Set(['failed', 'interrupted', 'unconfirmed', 'canceled']);
let chain = Promise.resolve();
const logChains = new Map();
let driving = false;
let driveRequested = false;
let quickTimer = null;
const iso = () => new Date().toISOString();
const makeRunId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const lock = task => {
  const job = chain.catch(() => {}).then(task);
  chain = job.catch(() => {});
  return job;
};

function queueKey(scope) {
  if (typeof scope !== 'string' || !scope.startsWith('https://disk.yandex.ru/')) {
    throw new Error('Ожидалась ссылка на папку disk.yandex.ru');
  }
  return QUEUE_PREFIX + scope;
}
function blankQueue(scope) {
  return { schema: 2, scope, createdAt: iso(), updatedAt: iso(),
    scan: { status: 'idle', steps: 0, collected: 0, note: '' }, records: [] };
}
async function getQueue(scope) {
  const key = queueKey(scope);
  const value = (await chrome.storage.local.get(key))[key];
  return value?.schema === 2 ? value : blankQueue(scope);
}
async function saveQueue(queue) {
  queue.updatedAt = iso();
  await chrome.storage.local.set({ [queueKey(queue.scope)]: queue });
}
async function getSession(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const key = SESSION_PREFIX + tabId;
  return (await chrome.storage.session.get(key))[key] || null;
}
function withLogLock(scope, task) {
  const previous = logChains.get(scope) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tail = next.catch(() => {});
  logChains.set(scope, tail);
  void tail.finally(() => {
    if (logChains.get(scope) === tail) logChains.delete(scope);
  });
  return next;
}
async function logEvent(scope, name, event, status = '', error = '', downloadId = null, meta = {}) {
  return withLogLock(scope, async () => {
    const key = LOG_PREFIX + scope;
    const value = (await chrome.storage.local.get(key))[key] || [];
    value.push({ time: iso(), name: String(name || '').slice(0, 255),
      event, status, error: redactError(error), downloadId,
      runId: meta.runId || '', attemptId: meta.attemptId || '',
      durationMs: Number.isFinite(meta.durationMs) ? meta.durationMs : '',
      errorType: classifyError(error) });
    await chrome.storage.local.set({ [key]: value.slice(-2500) });
  });
}
async function clearLog(scope) {
  return withLogLock(scope, async () => {
    const key = LOG_PREFIX + scope;
    const value = (await chrome.storage.local.get(key))[key] || [];
    await chrome.storage.local.remove(key);
    return value.length;
  });
}
async function getSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}
function safeFolder(value) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (raw.length > 180 || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error('Укажи относительный путь внутри папки загрузок Chrome');
  }
  if (!raw) return '';
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part))) {
    throw new Error('Недопустимое имя подпапки');
  }
  return parts.join('/');
}
function outputFilename(name, folder) {
  return [safeFolder(folder), safeFilename(name)].filter(Boolean).join('/');
}
async function setSettings(settings) {
  const normalized = {
    hideChromeUi: settings.hideChromeUi === true,
    eraseInterrupted: settings.eraseInterrupted === true,
    downloadFolder: safeFolder(settings.downloadFolder)
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}
async function setChromeUiHidden(scope) {
  const previous = (await chrome.storage.local.get(UI_KEY))[UI_KEY];
  await chrome.downloads.setUiOptions({ enabled: false });
  await chrome.storage.local.set({ [UI_KEY]: { hidden: true, scope, hiddenAt: Date.now() } });
}
async function restoreChromeUi(force = false) {
  const state = (await chrome.storage.local.get(UI_KEY))[UI_KEY];
  if (!state?.hidden) return;
  if (!force) {
    const engine = await getEngine();
    if (engine.controller?.status === 'running' || engine.jobs.length ||
        Object.keys(engine.lateTracked).length) return;
    pruneLate(engine);
    if (engine.lateCandidates.length) return;
    const active = await chrome.downloads.search({ state: 'in_progress' });
    if (active.some(item => item.byExtensionId === chrome.runtime.id)) return;
  }
  try {
    await chrome.downloads.setUiOptions({ enabled: true });
    await chrome.storage.local.set({ [UI_KEY]: { hidden: false, scope: state.scope, restoredAt: Date.now() } });
  } catch (error) {
    console.warn('[YDBD] Не удалось восстановить панель Chrome', error);
  }
}
async function cleanupFailedHistory(scope, name, item, downloadId, state) {
  if (!['interrupted', 'canceled'].includes(state) || !Number.isInteger(Number(downloadId))) return;
  const settings = await getSettings();
  if (!settings.eraseInterrupted) return;
  let confirmed = item;
  if (!confirmed) [confirmed] = await chrome.downloads.search({ id: Number(downloadId) });
  if (confirmed?.byExtensionId !== chrome.runtime.id || confirmed.state !== 'interrupted') return;
  try {
    await chrome.downloads.erase({ id: Number(downloadId) });
    await logEvent(scope, name, 'chrome_history_erased', state, '', Number(downloadId));
  } catch (error) {
    await logEvent(scope, name, 'chrome_history_erase_failed', state, error.message, Number(downloadId));
  }
}
function safeFilename(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
      name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Недопустимое имя файла');
  }
  return name;
}

function normalizeEngine(engine) {
  engine ||= {};
  if (!Array.isArray(engine.jobs)) engine.jobs = engine.active ? [engine.active] : [];
  delete engine.active;
  engine.lateCandidates ||= [];
  engine.lateTracked ||= {};
  engine.diagnostics ||= [];
  if (engine.controller) {
    const c = engine.controller;
    c.maxConcurrent = CONFIG.maxConcurrent;
    c.effectiveConcurrent = Number.isInteger(c.effectiveConcurrent)
      ? Math.min(CONFIG.maxConcurrent, Math.max(CONFIG.minConcurrent, c.effectiveConcurrent))
      : CONFIG.maxConcurrent;
    c.successStreak ||= 0;
    c.consecutiveUiFailures ||= 0;
    c.nextAllowedAt ||= 0;
  }
  return engine;
}
async function getEngine() {
  return normalizeEngine((await chrome.storage.local.get(ENGINE_KEY))[ENGINE_KEY]);
}
async function saveEngine(engine) {
  await chrome.storage.local.set({ [ENGINE_KEY]: normalizeEngine(engine) });
}
const findRecord = (queue, id) => queue.records.find(r => r.id === id);
const expectedName = name => String(name || '').normalize('NFC').toLocaleLowerCase();
function downloadBasename(item) {
  let name = String(item?.filename || '').split(/[\\/]/).pop();
  if (!name) {
    try {
      const url = new URL(item?.finalUrl || item?.url);
      name = url.searchParams.get('filename') || '';
    } catch (_) {}
  }
  try { name = decodeURIComponent(name); } catch (_) {}
  return expectedName(name);
}
function matchesRecord(item, record) {
  const name = downloadBasename(item);
  if (!name) return null;
  const expected = expectedName(record.name);
  return name === expected || name.replace(/ \(\d+\)(?=\.[^.]+$|$)/, '') === expected;
}
function isDiskDownload(item) {
  return [item?.url, item?.finalUrl, item?.referrer].filter(Boolean).some(value => {
    try {
      const raw = value.startsWith('blob:') ? value.slice(5) : value;
      const host = new URL(raw).hostname.toLowerCase();
      return ['disk.yandex.ru', 'disk.yandex.net'].some(domain =>
        host === domain || host.endsWith('.' + domain));
    } catch (_) { return false; }
  });
}
function domainOf(value) {
  try { return new URL(value.startsWith('blob:') ? value.slice(5) : value).hostname; }
  catch (_) { return '?'; }
}
function noteDiagnostic(engine, item, reason = 'Скачивание не сопоставлено с очередью') {
  const awaiting = engine.jobs.filter(j => j.phase === 'awaiting').map(j => j.name);
  engine.diagnostics.unshift({ time: iso(), host: domainOf(item.url || ''),
    referrer: domainOf(item.referrer || ''), id: item.id, reason, awaiting: awaiting.slice(0, 3),
    filename: downloadBasename(item) || '(имя ещё неизвестно)' });
  engine.diagnostics = engine.diagnostics.slice(0, 10);
}
function classifyError(error) {
  const message = String(error || '');
  if (!message) return '';
  if (/^API HTTP|прямой ссылк|API не ответил/i.test(message)) return 'api';
  if (/^SERVER_|^NETWORK_|^FILE_|CONTENT_LENGTH_MISMATCH/i.test(message)) return 'network';
  if (/downloadId|Chrome|загрузк/i.test(message)) return 'browser';
  return 'other';
}
function redactError(value) {
  return String(value || '').replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 350);
}
function setRecord(record, status, extra = {}) {
  if (!record) return;
  Object.assign(record, { status, updatedAt: iso() }, extra);
}
function isNetworkError(reason) {
  return /^(SERVER_|NETWORK_|FILE_NETWORK|FILE_TRANSIENT|CRASH|USER_SHUTDOWN|API HTTP (408|429|5\d\d))|CONTENT_LENGTH_MISMATCH|TIMED?_OUT/i.test(reason || '');
}
function updateAdaptive(controller, state, error) {
  if (!controller || !CONFIG.adaptive) return;
  if ((state === 'interrupted' || state === 'failed') && isNetworkError(error)) {
    controller.effectiveConcurrent = Math.max(CONFIG.minConcurrent, controller.effectiveConcurrent - 1);
    controller.successStreak = 0;
    controller.note = `Сетевая ошибка ${error}; параллелизм снижен до ${controller.effectiveConcurrent}`;
  } else if (state === 'complete') {
    controller.successStreak++;
    if (controller.successStreak >= CONFIG.recoverAfterSuccesses &&
        controller.effectiveConcurrent < CONFIG.maxConcurrent) {
      controller.effectiveConcurrent++;
      controller.successStreak = 0;
      controller.note = `Стабильные загрузки: параллелизм восстановлен до ${controller.effectiveConcurrent}`;
    }
  } else if (state !== 'complete') {
    controller.successStreak = 0;
  }
}
function pruneLate(engine) {
  engine.lateCandidates = engine.lateCandidates.filter(c => c.until > Date.now());
}
function isBusyForScope(engine, scope) {
  return engine.jobs.some(job => job.scope === scope) ||
    (engine.controller?.scope === scope && engine.controller.status === 'running');
}
function waitingForMenu(engine) {
  return engine.jobs.some(job => job.phase === 'preparing' || job.phase === 'awaiting');
}
function canReserve(engine) {
  const c = engine.controller;
  if (!c || c.status !== 'running') return false;
  if (waitingForMenu(engine)) return false;
  const lateInProgress = Object.keys(engine.lateTracked).length;
  if (engine.jobs.length + lateInProgress >= c.effectiveConcurrent) return false;
  return true;
}
async function finishJob(engine, job, state, error = '', item = null) {
  error = redactError(error);
  if (state === 'interrupted' && (job.cancelRequested || error === 'USER_CANCELED')) {
    state = 'canceled';
    error = 'Остановлено пользователем';
  }
  const queue = await getQueue(job.scope);
  const record = findRecord(queue, job.recordId);
  setRecord(record, state, {
    error: error || null, downloadId: job.downloadId ?? record?.downloadId ?? null,
    finishedAt: iso(), ...(item?.filename ? { localFilename: item.filename } : {})
  });
  engine.jobs = engine.jobs.filter(j => j.attemptId !== job.attemptId);
  if (state === 'unconfirmed' && job.downloadId == null && record) {
    engine.lateCandidates.push({ scope: job.scope, recordId: job.recordId, attemptId: job.attemptId,
      name: record.name, runId: job.runId, startedAt: job.startedAt,
      until: Date.now() + CONFIG.lateWindow });
    engine.lateCandidates = engine.lateCandidates.slice(-100);
  }
  const c = engine.controller;
  if (c?.scope === job.scope && c.status === 'running') {
    updateAdaptive(c, state, error);
    if (state === 'complete') {
      c.failureStreak = 0;
      c.note = `Скачан ${record?.name || job.name}`;
    } else if (state !== 'canceled') {
      c.failureStreak = (c.failureStreak || 0) + 1;
      const backoff = Math.min(5000, 1000 * 2 ** Math.min(3, c.failureStreak - 1));
      c.nextAllowedAt = Math.max(c.nextAllowedAt, Date.now() + backoff);
      c.note = `Пропущен ${record?.name || job.name}: ${error || state}; пауза ${backoff / 1000} сек., очередь продолжится`;
    }
  }
  await logEvent(job.scope, record?.name || job.name, 'finished', state, error, job.downloadId ?? null,
    { runId: job.runId, attemptId: job.attemptId, durationMs: Date.now() - job.startedAt });
  await cleanupFailedHistory(job.scope, record?.name || job.name, item, job.downloadId, state);
  await saveQueue(queue);
  await saveEngine(engine);
}
async function finishLate(engine, id, state, item) {
  const tracked = engine.lateTracked[id];
  if (!tracked) return;
  const queue = await getQueue(tracked.scope);
  const record = findRecord(queue, tracked.recordId);
  if (state === 'interrupted' && tracked.cancelRequested) state = 'canceled';
  if (record && (record.status === 'in_progress' || record.status === 'unconfirmed')) {
    setRecord(record, state, { downloadId: Number(id), finishedAt: iso(),
      error: state === 'canceled' ? 'Остановлено пользователем' :
        state === 'interrupted' ? item?.error || 'Ошибка Chrome' : null,
      ...(item?.filename ? { localFilename: item.filename } : {}) });
    await saveQueue(queue);
  }
  await logEvent(tracked.scope, record?.name || '', 'late_finished', state, item?.error || '', Number(id),
    { runId: tracked.runId, attemptId: tracked.attemptId });
  await cleanupFailedHistory(tracked.scope, record?.name || '', item, Number(id), state);
  delete engine.lateTracked[id];
  await saveEngine(engine);
}
async function reconcile() {
  const engine = await getEngine();
  pruneLate(engine);
  for (const id of Object.keys(engine.lateTracked)) {
    const [item] = await chrome.downloads.search({ id: Number(id) });
    if (!item) {
      await finishLate(engine, id, 'unconfirmed', null);
    } else if (item.state === 'complete' || item.state === 'interrupted') {
      await finishLate(engine, id, item.state, item);
    } else if (item?.state === 'in_progress' && engine.lateTracked[id]?.cancelRequested) {
      try { await chrome.downloads.cancel(Number(id)); } catch (_) {}
    }
  }
  if (engine.lateCandidates.length && Date.now() - (engine.lastLateScanAt || 0) >= 15000) {
    engine.lastLateScanAt = Date.now();
    const recent = await chrome.downloads.search({ limit: 200, orderBy: ['-startTime'] });
    for (const item of recent) {
      if (item.byExtensionId !== chrome.runtime.id) continue;
      if (engine.jobs.some(j => j.downloadId === item.id) || engine.lateTracked[item.id]) continue;
      const candidates = engine.lateCandidates.filter(candidate =>
        matchesRecord(item, candidate) === true &&
        (!item.startTime || Date.parse(item.startTime) >= candidate.startedAt - 3000));
      if (candidates.length !== 1) continue;
      await trackCreated(engine, item);
    }
  }
  for (const job of [...engine.jobs]) {
    if (job.downloadId != null) {
      const [item] = await chrome.downloads.search({ id: job.downloadId });
      if (item?.state === 'complete' || item?.state === 'interrupted') {
        await finishJob(engine, job, item.state,
          item.state === 'interrupted' ? item.error || 'Ошибка Chrome' : '', item);
      } else if (!item) {
        await finishJob(engine, job, 'unconfirmed', 'Загрузка исчезла из истории Chrome');
      } else if (job.cancelRequested && item.state === 'in_progress') {
        try { await chrome.downloads.cancel(job.downloadId); } catch (_) {}
      }
    } else if (job.phase === 'requesting_link' &&
      Date.now() - (job.phaseAt || job.startedAt) > CONFIG.prepareTimeout) {
      await finishJob(engine, job, 'failed', 'Превышен таймаут получения прямой ссылки');
    } else if (job.phase === 'starting_download' &&
      Date.now() - (job.phaseAt || job.startedAt) > CONFIG.startTimeout) {
      await finishJob(engine, job, 'unconfirmed', 'Нет подтверждения downloadId');
    }
  }
  await saveEngine(engine);
}
async function enableWatchdog() {
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
}
async function scheduleWake() {
  if (quickTimer) { clearTimeout(quickTimer); quickTimer = null; }
  const engine = await getEngine();
  const c = engine.controller;
  if (!c || c.status !== 'running') {
    await chrome.alarms.clear(NEXT_ALARM);
    await restoreChromeUi();
    return;
  }
  if (!canReserve(engine)) {
    await chrome.alarms.clear(NEXT_ALARM);

    return;
  }
  const queue = await getQueue(c.scope);
  if (!queue.records.some(r => r.status === 'pending') && engine.jobs.length > 0) {
    await chrome.alarms.clear(NEXT_ALARM);
    return;
  }
  const due = Math.max(Date.now(), c.nextAllowedAt || 0);
  await chrome.alarms.create(NEXT_ALARM, { when: due });
  quickTimer = setTimeout(() => { void drive().catch(console.error); }, Math.max(0, due - Date.now()));
}
function raceTimeout(promise, delay, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), delay);
    })
  ]).finally(() => clearTimeout(timer));
}

async function processReservedJob(job) {
  try {
    const tab = await raceTimeout(chrome.tabs.get(job.tabId), 5000, 'Нет ответа вкладки');
    if (tab.url !== job.scope) throw new Error('Папка во вкладке изменилась');
    const session = await getSession(job.tabId);
    if (!session) throw new Error('Нет активной сессии API');
    const result = await raceTimeout(chrome.tabs.sendMessage(job.tabId, {
      type: 'YDBD_GET_DIRECT_URL', name: job.name,
      scope: job.scope, session: { sk: session.sk, connection_id: session.connection_id }
    }), CONFIG.prepareTimeout, 'Таймаут запроса прямой ссылки');
    if (!result?.ok) throw new Error(result?.error || 'API не вернул ссылку');
    await logEvent(job.scope, job.name, 'api_url_received', 'preparing');
    const url = new URL(result.url);
    if (url.protocol !== 'https:' ||
        !/^([a-z0-9-]+\.)*downloader\.disk\.yandex\.(ru|net)$/i.test(url.hostname)) {
      throw new Error('Неверный домен прямой ссылки');
    }
    const shouldDownload = await lock(async () => {
      const engine = await getEngine();
      const current = engine.jobs.find(j => j.attemptId === job.attemptId);
      if (!current) return false;
      if (engine.controller?.status !== 'running' || current.cancelRequested) {
        const queue = await getQueue(job.scope);
        setRecord(findRecord(queue, job.recordId), 'pending', { error: null });
        engine.jobs = engine.jobs.filter(j => j.attemptId !== job.attemptId);
        await saveQueue(queue);
        await saveEngine(engine);
        return false;
      }
      current.phase = 'starting_download';
      current.phaseAt = Date.now();
      await saveEngine(engine);
      return true;
    });
    if (!shouldDownload) return;
    const engineAtStart = await getEngine();
    const folder = engineAtStart.controller?.scope === job.scope ?
      engineAtStart.controller.downloadFolder || '' : '';
    await logEvent(job.scope, job.name, 'chrome_download_invoked', 'preparing', '', null,
      { runId: job.runId, attemptId: job.attemptId });
    const initiation = Promise.resolve().then(() => chrome.downloads.download({
      url: url.href,
      filename: outputFilename(job.name, folder),
      saveAs: false,
      conflictAction: 'uniquify'
    }));
    const idPromise = initiation.then(async id => {
      if (!Number.isInteger(id)) throw new Error('Chrome не вернул downloadId');
      await lock(async () => {
        const engine = await getEngine();
        const current = engine.jobs.find(j => j.attemptId === job.attemptId);
        if (!current) {
          const candidate = engine.lateCandidates.find(c => c.attemptId === job.attemptId);
          if (candidate) {
            const [item] = await chrome.downloads.search({ id });
            if (item) await trackCreated(engine, item);
          } else if (engine.controller?.status === 'stopped') {
            try { await chrome.downloads.cancel(id); } catch (_) {}
          }
          return id;
        }
        if (current.downloadId != null && current.downloadId !== id) {
          noteDiagnostic(engine, { id }, 'Несовпадение downloadId для одного файла');
          await saveEngine(engine);
          return id;
        }
        current.downloadId = id;
        current.phase = 'in_progress';
        const queue = await getQueue(job.scope);
        setRecord(findRecord(queue, job.recordId), 'in_progress', {
          downloadId: id, error: null, startedDownloadAt: iso()
        });
        await saveQueue(queue);
        await saveEngine(engine);
        await logEvent(job.scope, job.name, 'download_started', 'in_progress', '', id,
          { runId: job.runId, attemptId: job.attemptId });
        if (current.cancelRequested || engine.controller?.status === 'stopped') {
          try { await chrome.downloads.cancel(id); } catch (_) {}
        }
      });
      await lock(reconcile);
      return id;
    });
    await raceTimeout(idPromise, CONFIG.startTimeout, 'Нет подтверждения downloadId');
  } catch (error) {
    await lock(async () => {
      const engine = await getEngine();
      const current = engine.jobs.find(j => j.attemptId === job.attemptId);
      if (current?.downloadId == null) {
        const reason = error?.message || String(error);
        const uncertain = current.phase === 'starting_download';
        await finishJob(engine, current, uncertain ? 'unconfirmed' : 'failed', reason);
      }
    });
  } finally {
    await scheduleWake();
    void drive().catch(error => console.error('[YDBD] process-reserved-job', error));
  }
}

async function drive() {
  if (driving) { driveRequested = true; return; }
  driving = true;
  let reserved = null;
  try {
    await lock(async () => {
      await reconcile();
      const engine = await getEngine();
      const c = engine.controller;
      if (!c || c.status !== 'running') return;
      if (!canReserve(engine) || Date.now() < c.nextAllowedAt) return;
      const session = await getSession(c.tabId);
      if (!session) {
        c.status = 'paused';
        c.note = 'Сессия API не обнаружена. Обнови вкладку Яндекс Диска, затем запусти очередь снова';
        await saveEngine(engine);
        return;
      }
      const queue = await getQueue(c.scope);
      const record = queue.records.find(r => r.status === 'pending');
      if (!record) {
        if (engine.jobs.length === 0) {
          c.status = 'finished';
          const errors = queue.records.filter(r => PROBLEM_STATES.has(r.status)).length;
          c.note = errors ? `Готово. Проблемных файлов: ${errors}` : 'Все pending обработаны';
          await saveEngine(engine);
        }
        return;
      }
      const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      setRecord(record, 'preparing', { attempts: (record.attempts || 0) + 1, error: null });
      reserved = { scope: c.scope, recordId: record.id, name: record.name, runId: c.runId,
        tabId: c.tabId, attemptId, startedAt: Date.now(), phaseAt: Date.now(),
        phase: 'requesting_link', downloadId: null };
      engine.jobs.push(reserved);
      c.nextAllowedAt = Math.max(c.nextAllowedAt, Date.now() + CONFIG.launchInterval);
      await saveQueue(queue);
      await saveEngine(engine);
      await logEvent(reserved.scope, reserved.name, 'link_requested', 'preparing', '', null,
        { runId: reserved.runId, attemptId: reserved.attemptId });
    });
  } finally {
    driving = false;
    if (reserved) {
      void processReservedJob(reserved).catch(error =>
        console.error('[YDBD] download-job', error));
    }
    await scheduleWake();
    if (driveRequested) {
      driveRequested = false;
      setTimeout(() => { void drive().catch(console.error); }, 0);
    }
  }
}

async function trackCreated(engine, item) {
  if (!engine.jobs.some(j => j.phase === 'awaiting' || j.phase === 'starting_download') &&
      !engine.lateCandidates.length && item.byExtensionId !== chrome.runtime.id) return;
  if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) return;
  if (!isDiskDownload(item)) {
    if (engine.jobs.some(j => j.phase === 'awaiting' || j.phase === 'starting_download')) {
      noteDiagnostic(engine, item, 'Загрузка не относится к ожидаемым доменам Яндекс Диска');
      await saveEngine(engine);
    }
    return;
  }
  pruneLate(engine);
  const late = engine.lateCandidates.filter(c => matchesRecord(item, c) === true &&
    (!item.startTime || !c.startedAt || Date.parse(item.startTime) >= c.startedAt - 3000));
  if (late.length === 1) {
    const candidate = late[0];
    const queue = await getQueue(candidate.scope);
    const record = findRecord(queue, candidate.recordId);
    engine.lateCandidates = engine.lateCandidates.filter(c => c !== candidate);
    if (record?.status === 'unconfirmed') {
      const stopped = engine.controller?.scope === candidate.scope &&
        engine.controller.status === 'stopped';
      engine.lateTracked[item.id] = { scope: candidate.scope, recordId: candidate.recordId,
        runId: candidate.runId, attemptId: candidate.attemptId,
        cancelRequested: stopped };
      setRecord(record, 'in_progress', { downloadId: item.id, error: null, startedDownloadAt: iso() });
      await logEvent(candidate.scope, candidate.name, 'late_download_created', 'in_progress', '', item.id,
        { runId: candidate.runId, attemptId: candidate.attemptId });
      await saveQueue(queue);
      if (stopped && item.state === 'in_progress') {
        try { await chrome.downloads.cancel(item.id); } catch (_) {}
      }
      if (item.state === 'complete' || item.state === 'interrupted') {
        await finishLate(engine, item.id, item.state, item);
        return;
      }
    }
    await saveEngine(engine);
    return;
  }
  if (item.byExtensionId === chrome.runtime.id && engine.controller?.scope) {
    const scope = engine.controller.scope;
    const queue = await getQueue(scope);
    const older = queue.records.filter(r => r.status === 'unconfirmed' &&
      matchesRecord(item, r) === true && (!item.startTime || !r.updatedAt ||
      Date.parse(item.startTime) >= Date.parse(r.updatedAt) - CONFIG.startTimeout - 4000));
    if (older.length === 1) {
      const record = older[0];
      engine.lateTracked[item.id] = { scope, recordId: record.id,
        attemptId: '', runId: engine.controller.runId, cancelRequested: engine.controller.status === 'stopped' };
      setRecord(record, 'in_progress', { downloadId: item.id, error: null, startedDownloadAt: iso() });
      await saveQueue(queue);
      await logEvent(scope, record.name, 'late_download_created', 'in_progress', '', item.id);
      await saveEngine(engine);
      if (engine.controller.status === 'stopped' && item.state === 'in_progress') {
        try { await chrome.downloads.cancel(item.id); } catch (_) {}
      }
      if (item.state === 'complete' || item.state === 'interrupted') {
        await finishLate(engine, item.id, item.state, item);
      }
      return;
    }
  }
  const matches = engine.jobs.filter(j => (j.phase === 'awaiting' || j.phase === 'starting_download') && j.downloadId == null &&
    Date.now() - (j.phaseAt || j.awaitingAt || j.startedAt || 0) <= CONFIG.startTimeout && matchesRecord(item, j) === true);
  if (matches.length !== 1) {
    noteDiagnostic(engine, item, 'Имя Chrome не совпало с ожидаемым файлом');
    await saveEngine(engine);
    return;
  }
  const job = matches[0];
  job.phase = 'in_progress';
  job.downloadId = item.id;
  if (engine.controller?.scope === job.scope) {
    engine.controller.consecutiveUiFailures = 0;
  }
  const queue = await getQueue(job.scope);
  setRecord(findRecord(queue, job.recordId), 'in_progress', {
    downloadId: item.id, startedDownloadAt: iso(), error: null
  });
  await saveQueue(queue);
  await saveEngine(engine);
  await logEvent(job.scope, job.name, 'chrome_download_created', 'in_progress', '', item.id,
    { runId: job.runId, attemptId: job.attemptId });
  if (job.cancelRequested && item.state === 'in_progress') {
    try { await chrome.downloads.cancel(item.id); } catch (_) {}
  }
  if (item.state === 'complete' || item.state === 'interrupted') {
    await finishJob(engine, job, item.state, item.error || '', item);
  }
}
chrome.downloads.onCreated.addListener(item => {
  void lock(async () => trackCreated(await getEngine(), item))
    .then(scheduleWake).catch(error => console.error('[YDBD] onCreated', error));
});
chrome.downloads.onChanged.addListener(delta => {
  const terminal = delta.state?.current;
  if (!['complete', 'interrupted'].includes(terminal) && !delta.filename) return;
  void lock(async () => {
    const engine = await getEngine();
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (!item) return;
    if (engine.lateTracked[delta.id] && (terminal === 'complete' || terminal === 'interrupted')) {
      await finishLate(engine, delta.id, terminal, item);
      return;
    }
    let job = engine.jobs.find(j => j.downloadId === delta.id);
    if (!job && item && isDiskDownload(item)) {
      await trackCreated(engine, item);
      job = engine.jobs.find(j => j.downloadId === delta.id);
    }
    if (job && (terminal === 'complete' || terminal === 'interrupted')) {
      await finishJob(engine, job, terminal,
        terminal === 'interrupted' ? item.error || delta.error?.current || 'Ошибка Chrome' : '', item);
    }
  }).then(scheduleWake).catch(error => console.error('[YDBD] onChanged', error));
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === NEXT_ALARM) void drive().catch(console.error);
  if (alarm.name === WATCHDOG_ALARM) {
    void lock(reconcile).then(drive).then(scheduleWake).catch(console.error);
  }
});
chrome.runtime.onStartup.addListener(() => {
  void enableWatchdog().then(() => lock(reconcile)).then(drive).then(scheduleWake).catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => {
  
  void enableWatchdog().then(() => lock(reconcile)).then(drive).then(scheduleWake).catch(console.error);
});

function stats(queue) {
  const states = {};
  for (const record of queue.records) states[record.status] = (states[record.status] || 0) + 1;
  return states;
}
async function present(scope, tabId, page = 0, filter = 'all') {
  await reconcile();
  const queue = await getQueue(scope);
  const engine = await getEngine();
  const session = await getSession(tabId);
  const logKey = LOG_PREFIX + scope;
  const logCount = ((await chrome.storage.local.get(logKey))[logKey] || []).length;
  const settings = await getSettings();
  const uiState = (await chrome.storage.local.get(UI_KEY))[UI_KEY];
  const pageSize = 50;
  const filtered = filter === 'errors' ? queue.records.filter(r => PROBLEM_STATES.has(r.status)) : queue.records;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(totalPages - 1, Math.max(0, Number.isInteger(page) ? page : 0));
  const jobs = engine.jobs.filter(j => j.scope === scope);
  const progresses = [];
  for (const job of jobs) {
    let progress = null;
    if (job.downloadId != null) {
      const [item] = await chrome.downloads.search({ id: job.downloadId });
      if (item) progress = { id: item.id, state: item.state,
        bytes: item.bytesReceived, totalBytes: item.totalBytes,
        paused: item.paused, filename: item.filename };
    }
    progresses.push({ job, progress });
  }
  const lateDownloads = [];
  for (const [id, entry] of Object.entries(engine.lateTracked)) {
    if (entry.scope !== scope) continue;
    const [item] = await chrome.downloads.search({ id: Number(id) });
    if (item?.state !== 'in_progress') continue;
    const record = findRecord(queue, entry.recordId);
    lateDownloads.push({ id: item.id, name: record?.name || '', bytes: item.bytesReceived,
      totalBytes: item.totalBytes, state: item.state });
  }
  return {
    scope: queue.scope, count: queue.records.length,
    states: stats(queue), scan: queue.scan,
    page: safePage, pageSize, totalPages, totalFiltered: filtered.length,
    recordsPage: filtered.slice(safePage * pageSize, (safePage + 1) * pageSize).map(r => ({
      id: r.id, name: r.name, status: r.status, attempts: r.attempts || 0,
      error: r.error || null, downloadId: r.downloadId ?? null
    })),
    settings, chromeUiHidden: Boolean(uiState?.hidden),
    controller: engine.controller?.scope === scope ? engine.controller : null,
    busyElsewhere: Boolean(engine.jobs.some(j => j.scope !== scope) ||
      (engine.controller?.scope !== scope && engine.controller?.status === 'running')),
    active: jobs[0] || null,
    jobs, progresses, lateDownloads, progress: progresses[0]?.progress || null,
    config: CONFIG, diagnostics: engine.diagnostics,
    apiSessionReady: Boolean(session), logCount,
    logClearAllowed: !isBusyForScope(engine, scope) &&
      !Object.values(engine.lateTracked).some(item => item.scope === scope) &&
      !engine.lateCandidates.some(item => item.scope === scope),
    scheduler: engine.controller?.scope === scope ? {
      effectiveLimit: engine.controller.effectiveConcurrent,
      lateActive: Object.values(engine.lateTracked).filter(x => x.scope === scope).length,
      pending: queue.records.filter(r => r.status === 'pending').length,
      uiBusy: false,
      nextAllowedAt: engine.controller.nextAllowedAt || 0,
      waitReason: engine.controller.status !== 'running' ? engine.controller.status :
        waitingForMenu(engine) ? 'Подготовка загрузки' :
        engine.jobs.length + Object.keys(engine.lateTracked).length >= engine.controller.effectiveConcurrent ? 'Все доступные слоты заняты, включая поздние загрузки' :
        Date.now() < (engine.controller.nextAllowedAt || 0) ? 'Интервал между запусками' :
        queue.records.some(r => r.status === 'pending') ? 'Запуск следующего файла' : 'Нет файлов pending'
    } : null
  };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith('YDBD_')) return;
  const fromDisk = sender.tab?.url?.startsWith('https://disk.yandex.ru/') === true;
  const fromPopup = sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) === true;
  (async () => {
    if (message.type === 'YDBD_PING_BACKGROUND') {
      return { ok: true, version: chrome.runtime.getManifest().version };
    }
    if (message.type === 'YDBD_QUEUE_ADD') {
      if (!fromDisk || message.scope !== sender.tab.url) throw new Error('Папка изменена');
      if (!Array.isArray(message.items) || message.items.length > 200) throw new Error('Некорректная партия');
      return lock(async () => {
        const queue = await getQueue(message.scope);
        const existing = new Set(queue.records.map(r => r.name));
        let added = 0;
        for (const item of message.items) {
          const name = item?.name;
          if (typeof name !== 'string' || !name || name.length > 1024 || existing.has(name)) continue;
          existing.add(name);
          queue.records.push({ id: `${message.scope}::${name}`, name,
            status: 'pending', discoveredAt: iso(), attempts: 0 });
          added++;
        }
        await saveQueue(queue);
        return { ok: true, added, count: queue.records.length };
      });
    }
    if (message.type === 'YDBD_SCAN_STATE') {
      if (!fromDisk || message.scope !== sender.tab.url) throw new Error('Папка изменена');
      return lock(async () => {
        const queue = await getQueue(message.scope);
        queue.scan = { status: String(message.status || 'idle'),
          steps: Number(message.steps) || 0, collected: Number(message.collected) || 0,
          note: String(message.note || '').slice(0, 250), at: iso() };
        await saveQueue(queue);
        return { ok: true, count: queue.records.length };
      });
    }
    if (!fromPopup) throw new Error('Управлять загрузками может только интерфейс расширения');
    if (message.type === 'YDBD_QUEUE_GET') {
      return { ok: true, ...(await lock(() => present(message.scope, message.tabId, message.page, message.filter))) };
    }
    if (message.type === 'YDBD_SETTINGS_GET') return { ok: true, settings: await getSettings() };
    if (message.type === 'YDBD_SETTINGS_SET') {
      return lock(async () => {
        const engine = await getEngine();
        if (engine.controller?.status === 'running' || engine.jobs.length ||
            Object.keys(engine.lateTracked).length) {
          throw new Error('Изменение настроек доступно после завершения всех загрузок');
        }
        return { ok: true, settings: await setSettings(message.settings || {}) };
      });
    }
    if (message.type === 'YDBD_LOG_GET') {
      const key = LOG_PREFIX + message.scope;
      const entries = await withLogLock(message.scope, async () =>
        (await chrome.storage.local.get(key))[key] || []);
      return { ok: true, entries };
    }
    if (message.type === 'YDBD_LOG_CLEAR') {
      return lock(async () => {
        const engine = await getEngine();
        if (isBusyForScope(engine, message.scope) ||
            Object.values(engine.lateTracked).some(item => item.scope === message.scope) ||
            engine.lateCandidates.some(item => item.scope === message.scope)) {
          throw new Error('Очистка журнала доступна после завершения загрузок');
        }
        return { ok: true, count: await clearLog(message.scope) };
      });
    }
    if (message.type === 'YDBD_QUEUE_CLEAR') {
      return lock(async () => {
        const engine = await getEngine();
        if (isBusyForScope(engine, message.scope)) throw new Error('Дождись завершения активных файлов');
        const queue = await getQueue(message.scope);
        queue.records = [];
        queue.scan = { status: 'idle', steps: 0, collected: 0, note: '' };
        await saveQueue(queue);
        return { ok: true };
      });
    }
    if (message.type === 'YDBD_START_DOWNLOADS') {
      const { scope, tabId } = message;
      if (!Number.isInteger(tabId)) throw new Error('Некорректный идентификатор вкладки');
      const tab = await chrome.tabs.get(tabId);
      if (tab.url !== scope) throw new Error('Вкладка должна показывать нужную папку');
      if (!(await getSession(tabId))) throw new Error('Сессия API не обнаружена: обнови вкладку Яндекс Диска');
      const result = await lock(async () => {
        const engine = await getEngine();
        if (engine.jobs.length) throw new Error('Дождись завершения активных загрузок');
        if (engine.controller?.status === 'running') throw new Error('Очередь уже работает');
        const queue = await getQueue(scope);
        if (!queue.records.some(r => r.status === 'pending')) throw new Error('В очереди нет файлов pending');
        const settings = await getSettings();
        engine.controller = { scope, tabId, status: 'running', note: '', runId: makeRunId(),
          downloadFolder: settings.downloadFolder,
          nextAllowedAt: 0, startedAt: iso(),
          maxConcurrent: CONFIG.maxConcurrent,
          effectiveConcurrent: CONFIG.maxConcurrent, successStreak: 0, consecutiveUiFailures: 0 };
        await saveEngine(engine);
        return { ok: true, maxConcurrent: CONFIG.maxConcurrent };
      });
      const preferences = await getSettings();
      if (preferences.hideChromeUi) {
        try { await setChromeUiHidden(scope); }
        catch (error) { console.warn('[YDBD] UI hide failed:', error); }
      }
      void drive().catch(console.error);
      return result;
    }
    if (message.type === 'YDBD_PAUSE_DOWNLOADS') {
      return lock(async () => {
        const engine = await getEngine();
        if (engine.controller?.scope !== message.scope || engine.controller.status !== 'running') {
          throw new Error('Не найдена запущенная очередь');
        }
        engine.controller.status = 'paused';
        engine.controller.note = engine.jobs.length ?
          'Новые файлы не запускаются; текущие загрузки продолжаются' : 'Остановлено пользователем';
        await saveEngine(engine);
        return { ok: true };
      });
    }
    if (message.type === 'YDBD_STOP_DOWNLOADS') {
      const { scope } = message;
      const targets = await lock(async () => {
        const engine = await getEngine();
        const c = engine.controller;
        if (c?.scope !== scope) throw new Error('Нет очереди для этой папки');
        if (!['running', 'paused', 'stopped'].includes(c.status) &&
            !engine.jobs.some(j => j.scope === scope)) {
          throw new Error('Нет активного процесса для остановки');
        }
        c.status = 'stopped';
        c.note = 'Остановлено: активные загрузки отменяются, pending сохранены';
        const cancellations = [];
        const aborts = [];
        const queue = await getQueue(scope);
        for (const job of [...engine.jobs]) {
          if (job.scope !== scope) continue;
          if (job.downloadId != null) {
            job.cancelRequested = true;
            cancellations.push(job.downloadId);
          } else if (job.phase === 'awaiting' || job.phase === 'starting_download') {
            aborts.push({ tabId: job.tabId, attemptId: job.attemptId });
            const record = findRecord(queue, job.recordId);
            setRecord(record, 'unconfirmed', {
              error: 'Остановлено до подтверждения Chrome; проверь историю загрузок',
              finishedAt: iso()
            });
            engine.jobs = engine.jobs.filter(j => j.attemptId !== job.attemptId);
            if (record) engine.lateCandidates.push({
              scope: job.scope, recordId: job.recordId, name: record.name,
              until: Date.now() + CONFIG.lateWindow
            });
          } else {
            aborts.push({ tabId: job.tabId, attemptId: job.attemptId });
            setRecord(findRecord(queue, job.recordId), 'pending', { error: null });
            engine.jobs = engine.jobs.filter(j => j.attemptId !== job.attemptId);
          }
        }
        await saveQueue(queue);
        await saveEngine(engine);
        return { cancellations, aborts };
      });
      await Promise.allSettled(targets.aborts.map(x => chrome.tabs.sendMessage(x.tabId, {
        type: 'YDBD_ABORT_DOWNLOAD', attemptId: x.attemptId
      })));
      const results = await Promise.allSettled(targets.cancellations.map(
        id => chrome.downloads.cancel(id)
      ));
      await lock(reconcile);
      await restoreChromeUi(true);
      await scheduleWake();
      return { ok: true, requestedCancels: targets.cancellations.length,
        cancellationErrors: results.filter(x => x.status === 'rejected').length };
    }
    if (message.type === 'YDBD_REQUEUE_ONE') {
      return lock(async () => {
        const engine = await getEngine();
        if (isBusyForScope(engine, message.scope)) throw new Error('Дождись завершения активных загрузок');
        const queue = await getQueue(message.scope);
        const record = findRecord(queue, message.id);
        if (!record || !PROBLEM_STATES.has(record.status)) throw new Error('Файл не найден среди ошибок');
        if (Object.values(engine.lateTracked).some(x => x.recordId === record.id)) {
          throw new Error('Файл сейчас скачивается в Chrome');
        }
        setRecord(record, 'pending', { error: null, downloadId: null });
        engine.lateCandidates = engine.lateCandidates.filter(x => x.recordId !== record.id);
        await saveQueue(queue);
        await saveEngine(engine);
        return { ok: true, count: 1 };
      });
    }
    if (message.type === 'YDBD_REQUEUE_PROBLEMS') {
      return lock(async () => {
        const engine = await getEngine();
        if (isBusyForScope(engine, message.scope)) throw new Error('Нельзя сбрасывать активную очередь');
        const queue = await getQueue(message.scope);
        let count = 0;
        for (const record of queue.records) {
          if (!PROBLEM_STATES.has(record.status)) continue;
          if (Object.values(engine.lateTracked).some(x => x.recordId === record.id)) continue;
          setRecord(record, 'pending', { error: null, downloadId: null });
          engine.lateCandidates = engine.lateCandidates.filter(x => x.recordId !== record.id);
          count++;
        }
        await saveQueue(queue);
        await saveEngine(engine);
        return { ok: true, count };
      });
    }
    return { ok: false, error: 'Unknown command' };
  })().then(respond).catch(error => {
    console.error('[YDBD]', error);
    respond({ ok: false, error: error.message || String(error) });
  });
  return true;
});

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.method !== 'POST' || details.tabId < 0) return;
  try {
    const raw = details.requestBody?.raw;
    if (!Array.isArray(raw) || !raw.length) return;
    const decoder = new TextDecoder();
    const body = JSON.parse(raw.map(entry => decoder.decode(entry.bytes)).join(''));
    if (typeof body.sk !== 'string' || !body.sk ||
        typeof body.connection_id !== 'string' || !body.connection_id) return;
    const key = SESSION_PREFIX + details.tabId;
    void chrome.storage.session.set({ [key]: {
      sk: body.sk, connection_id: body.connection_id, capturedAt: Date.now()
    } }).catch(error => console.warn('[YDBD] Session capture failed:', error.message));
  } catch (_) {
  }
}, { urls: ['https://disk.yandex.ru/models-v2*'], types: ['xmlhttprequest'] }, ['requestBody']);
