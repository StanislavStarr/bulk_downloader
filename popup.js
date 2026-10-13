const $ = selector => document.querySelector(selector);
const el = {
  status: $('#status'), folder: $('#folder'), count: $('#count'), complete: $('#complete'),
  pending: $('#pending'), visible: $('#visible-count'), steps: $('#steps'),
  problems: $('#problems'), collect: $('#collect'), stopScan: $('#stop-scan'),
  clear: $('#clear'), startAll: $('#start-all'),
  pause: $('#pause'), stopDownloads: $('#stop-downloads'), schedulerReason: $('#scheduler-reason'), retry: $('#retry'), downloadStatus: $('#download-status'),
  activeName: $('#active-name'), activeDownloads: $('#active-downloads'), concurrency: $('#concurrency'),
  files: $('#files'), more: $('#more'), meta: $('#list-meta'),
  apiStatus: $('#api-status'), exportLog: $('#export-log'), clearLog: $('#clear-log'), logCount: $('#log-count'),
  filterAll: $('#filter-all'), filterErrors: $('#filter-errors'),
  pagePrev: $('#page-prev'), pageNext: $('#page-next'), pageLabel: $('#page-label'),
  hideChromeUi: $('#hide-chrome-ui'), eraseInterrupted: $('#erase-interrupted'),
  downloadFolder: $('#download-folder'), saveSettings: $('#save-settings'),
  chromeDownloadSettings: $('#chrome-download-settings'), uiMode: $('#ui-mode')
};
let currentTabId = null;
let currentScope = null;
let refreshing = false;
let actionInFlight = false;
let lastQueue = null;
let fileFilter = 'all';
let currentPage = 0;
let settingsLoaded = false;
const ERROR_STATES = new Set(['unconfirmed', 'failed', 'interrupted', 'canceled']);

function showStatus(message, kind = '') {
  el.status.textContent = message;
  el.status.className = kind;
}
async function askBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Нет ответа расширения');
  return response;
}
async function askTab(message) {
  if (!currentTabId) throw new Error('Нет вкладки Яндекс Диска');
  try {
    const response = await chrome.tabs.sendMessage(currentTabId, message);
    if (!response?.ok) throw new Error(response?.error || 'Нет ответа страницы');
    return response;
  } catch (error) {
    if (String(error.message).includes('Receiving end does not exist')) {
      throw new Error('Обнови вкладку Яндекс Диска после Reload расширения');
    }
    throw error;
  }
}
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function runningOrBusy(data) {
  return data.controller?.status === 'running' || Boolean(data.jobs?.length) || Boolean(data.lateDownloads?.length) || actionInFlight;
}
function renderQueue(data) {
  lastQueue = data;
  const states = data.states || {};
  const problems = (states.failed || 0) + (states.interrupted || 0) + (states.unconfirmed || 0) + (states.canceled || 0);
  el.apiStatus.textContent = data.apiSessionReady ? 'API-сессия найдена · прямые ссылки доступны' : 'API-сессия не найдена · обнови вкладку Яндекс Диска';
  el.logCount.textContent = `Записей: ${data.logCount || 0}`;
  el.count.textContent = String(data.count);
  el.complete.textContent = String(states.complete || 0);
  el.pending.textContent = String(states.pending || 0);
  el.problems.textContent = String(problems);
  el.steps.textContent = String(data.scan.steps || 0);
  el.files.replaceChildren();
  currentPage = data.page ?? currentPage;
  el.files.start = currentPage * (data.pageSize || 50) + 1;
  const currentFiles = data.recordsPage || [];
  el.pageLabel.textContent = `Страница ${currentPage + 1} из ${data.totalPages || 1}`;
  el.pagePrev.disabled = currentPage <= 0;
  el.pageNext.disabled = currentPage >= (data.totalPages || 1) - 1;
  if (!settingsLoaded && data.settings) {
    el.hideChromeUi.checked = data.settings.hideChromeUi;
    el.eraseInterrupted.checked = data.settings.eraseInterrupted;
    el.downloadFolder.value = data.settings.downloadFolder;
    settingsLoaded = true;
  }
  el.uiMode.textContent = data.chromeUiHidden ? 'Панель Chrome скрыта до завершения загрузок' : 'Стандартная панель Chrome включена';
  for (const input of [el.hideChromeUi, el.eraseInterrupted, el.downloadFolder, el.saveSettings]) {
    input.disabled = runningOrBusy(data);
  }
  const canRetry = !runningOrBusy(data);
  for (const file of currentFiles) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const state = document.createElement('span');
    state.className = `file-state state-${file.status}`;
    state.textContent = file.status;
    li.append(name, state);
    if (file.error) {
      const detail = document.createElement('div');
      detail.className = 'file-error';
      detail.textContent = file.error;
      li.append(detail);
    }
    if (ERROR_STATES.has(file.status)) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'file-retry';
      retry.textContent = 'Вернуть в очередь';
      retry.disabled = !canRetry;
      retry.addEventListener('click', () => action(async () => {
        if (!confirm(`Проверь в Chrome, что «${file.name}» не скачался полностью. Повторить вручную?`)) return;
        await askBackground({ type: 'YDBD_REQUEUE_ONE', scope: currentScope, id: file.id });
        showStatus(`Возвращён в очередь: ${file.name}`, 'success');
      }));
      li.append(retry);
    }
    el.files.append(li);
  }
  el.filterAll.classList.toggle('active', fileFilter === 'all');
  el.filterErrors.classList.toggle('active', fileFilter === 'errors');
  el.meta.textContent = `Сканирование: ${data.scan.status || 'idle'} · ожидают: ${states.pending || 0} · проблемы: ${problems}`;
  if (data.scan.note) el.meta.textContent += ` · ${data.scan.note}`;
  const showing = data.totalFiltered ?? 0;
  el.more.hidden = false;
  const from = showing ? currentPage * (data.pageSize || 50) + 1 : 0;
  const to = from ? from + currentFiles.length - 1 : 0;
  el.more.textContent = `Показаны ${from}–${to} из ${showing}`;

  const controller = data.controller;
  const jobs = data.jobs || [];
  const running = controller?.status === 'running';
  el.concurrency.textContent = controller
    ? `${controller.effectiveConcurrent ?? 3} / ${controller.maxConcurrent ?? 3} слотов · активных: ${jobs.length + (data.scheduler?.lateActive || 0)}`
    : 'До 3 параллельных загрузок · интервал 3 сек.';
  el.schedulerReason.textContent = data.scheduler?.waitReason || '';
  el.activeName.textContent = jobs.length
    ? `В работе: ${jobs.length} файл(ов)` : '';
  el.downloadStatus.textContent = controller
    ? `${controller.status}${controller.note ? ': ' + controller.note : ''}`
    : 'Очередь ещё не запущена';
  el.activeDownloads.replaceChildren();
  for (const { job, progress } of data.progresses || []) {
    const row = document.createElement('li');
    row.className = 'active-download-row';
    const name = document.createElement('div');
    name.className = 'active-download-name';
    name.textContent = job.name;
    const detail = document.createElement('div');
    detail.className = 'active-download-detail';
    const percent = progress?.totalBytes > 0
      ? 100 * progress.bytes / progress.totalBytes : null;
    detail.textContent = `${job.phase} · ${percent == null ? 'ожидание / неизвестный размер' : `${percent.toFixed(1)}% · ${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`}`;
    row.append(name, detail);
    if (percent !== null) {
      const bar = document.createElement('progress');
      bar.max = 100;
      bar.value = percent;
      row.append(bar);
    }
    el.activeDownloads.append(row);
  }
  for (const download of data.lateDownloads || []) {
    const row = document.createElement('li');
    row.className = 'active-download-row';
    const name = document.createElement('div');
    name.className = 'active-download-name';
    name.textContent = `Поздняя загрузка: ${download.name}`;
    const detail = document.createElement('div');
    const percent = download.totalBytes > 0 ? 100 * download.bytes / download.totalBytes : null;
    detail.className = 'active-download-detail';
    detail.textContent = percent == null ? 'Загрузка в Chrome' : `${percent.toFixed(1)}% · ${formatBytes(download.bytes)} / ${formatBytes(download.totalBytes)}`;
    row.append(name, detail);
    if (percent != null) {
      const bar = document.createElement('progress');
      bar.max = 100;
      bar.value = percent;
      row.append(bar);
    }
    el.activeDownloads.append(row);
  }
  const busy = jobs.length > 0;
  el.startAll.disabled = actionInFlight || running || busy || data.busyElsewhere || !(states.pending > 0);
  el.pause.disabled = actionInFlight || !running;
  el.stopDownloads.disabled = actionInFlight || !controller ||
    (!['running', 'paused'].includes(controller.status) && !busy);
  el.retry.disabled = actionInFlight || running || busy || problems === 0;
  el.clear.disabled = actionInFlight || running || busy || data.count === 0;
  el.exportLog.disabled = !data.logCount;
  el.clearLog.disabled = actionInFlight || !data.logClearAllowed || !data.logCount;

}
async function refresh() {
  if (refreshing || actionInFlight) return;
  refreshing = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith('https://disk.yandex.ru/')) {
      currentTabId = null;
      currentScope = null;
      for (const key of ['collect', 'stopScan', 'clear', 'startAll', 'pause', 'stopDownloads', 'retry', 'clearLog', 'exportLog']) el[key].disabled = true;
      showStatus('Открой Яндекс Диск в текущей вкладке', 'error');
      return;
    }
    currentTabId = tab.id;
    currentScope = tab.url;
    el.folder.textContent = tab.url;

    const [local, queue, visible] = await Promise.all([
      askTab({ type: 'YDBD_COLLECTION_STATUS' }),
      askBackground({ type: 'YDBD_QUEUE_GET', scope: currentScope, tabId: currentTabId, page: currentPage, filter: fileFilter }),
      askTab({ type: 'YDBD_SCAN_CURRENT_PAGE' })
    ]);
    el.visible.textContent = String(visible.count);
    renderQueue(queue);
    if (local.running) showStatus(`Сбор: ${local.collected} файлов`, 'wait');
    else if (queue.controller?.status === 'running') showStatus('Загрузка выполняется', 'success');
    else if (queue.controller?.status === 'paused') showStatus('Загрузка на паузе', 'wait');
    else if (queue.controller?.status === 'stopped') showStatus('Загрузка остановлена', 'wait');
    else if (queue.controller?.status === 'finished' &&
      ((queue.states.failed || 0) + (queue.states.unconfirmed || 0) + (queue.states.interrupted || 0)) > 0) {
      showStatus('Очередь завершена с ошибками. Проверь вкладку «Только ошибки»', 'wait');
    }
    else if (queue.controller?.status === 'finished') showStatus('Очередь завершена', 'success');
    else if (queue.scan.status === 'finished') showStatus('Сканирование завершено', 'success');
    else if (queue.scan.status === 'partial') showStatus('Собрано частично', 'wait');
    else showStatus('Подключено', 'success');
    el.collect.disabled = local.running || queue.controller?.status === 'running' || Boolean(queue.jobs?.length);
    el.stopScan.disabled = !local.running;
    if (local.running) el.startAll.disabled = true;
  } catch (error) {
    showStatus(error.message || String(error), 'error');
    console.error('[YDBD popup]', error);
  } finally {
    refreshing = false;
  }
}
async function action(fn) {
  if (actionInFlight) return;
  actionInFlight = true;
  try { await fn(); }
  catch (error) { showStatus(error.message || String(error), 'error'); }
  finally { actionInFlight = false; await refresh(); }
}
el.filterAll.addEventListener('click', () => {
  fileFilter = 'all';
  currentPage = 0;
  void refresh();
});
el.filterErrors.addEventListener('click', () => {
  fileFilter = 'errors';
  currentPage = 0;
  void refresh();
});
el.pagePrev.addEventListener('click', () => {
  if (currentPage > 0) { currentPage--; void refresh(); }
});
el.pageNext.addEventListener('click', () => {
  if (lastQueue && currentPage + 1 < lastQueue.totalPages) { currentPage++; void refresh(); }
});
el.saveSettings.addEventListener('click', () => action(async () => {
  const settings = {
    hideChromeUi: el.hideChromeUi.checked,
    eraseInterrupted: el.eraseInterrupted.checked,
    downloadFolder: el.downloadFolder.value
  };
  const result = await askBackground({ type: 'YDBD_SETTINGS_SET', settings });
  el.downloadFolder.value = result.settings.downloadFolder;
  showStatus('Настройки сохранены', 'success');
}));
el.chromeDownloadSettings.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://settings/downloads' });
});
el.collect.addEventListener('click', () => action(async () => {
  await askTab({ type: 'YDBD_START_COLLECTION' });
  showStatus('Сбор запущен', 'wait');
}));
el.stopScan.addEventListener('click', () => action(() => askTab({ type: 'YDBD_STOP_COLLECTION' })));
el.startAll.addEventListener('click', () => action(async () => {
  if (!confirm('Скачать все файлы со статусом pending в этой папке?')) return;
  await askBackground({ type: 'YDBD_START_DOWNLOADS', scope: currentScope,
    tabId: currentTabId });
  showStatus('Массовая загрузка запущена', 'success');
}));
el.pause.addEventListener('click', () => action(async () => {
  await askBackground({ type: 'YDBD_PAUSE_DOWNLOADS', scope: currentScope });
  showStatus('Новые файлы не будут запускаться', 'wait');
}));
el.stopDownloads.addEventListener('click', () => action(async () => {
  if (!confirm('Остановить процесс и отменить ВСЕ активные загрузки этого расширения? Частично скачанные файлы Chrome может удалить. Файлы на Яндекс Диске не пострадают.')) return;
  const res = await askBackground({ type: 'YDBD_STOP_DOWNLOADS', scope: currentScope });
  showStatus(`Остановлено. Команд отмены: ${res.requestedCancels}. Pending сохранены.`, 'wait');
}));
el.retry.addEventListener('click', () => action(async () => {
  if (!confirm('Подтверди, что проблемные файлы не скачались. Повтор может создать дубликаты. Вернуть их в pending?')) return;
  const result = await askBackground({ type: 'YDBD_REQUEUE_PROBLEMS', scope: currentScope });
  showStatus(`Возвращено в очередь: ${result.count}`, 'success');
}));
el.clear.addEventListener('click', () => action(async () => {
  if (!confirm('Очистить реестр текущей папки? Файлы на диске и локальные загрузки не затрагиваются.')) return;
  await askBackground({ type: 'YDBD_QUEUE_CLEAR', scope: currentScope });
  showStatus('Очередь очищена', 'success');
}));
refresh();
setInterval(refresh, 1400);

el.clearLog.addEventListener('click', () => action(async () => {
  if (!confirm('Удалить локальный журнал текущей папки? Экспортированные CSV-файлы и очередь загрузок останутся без изменений.')) return;
  const result = await askBackground({ type: 'YDBD_LOG_CLEAR', scope: currentScope });
  showStatus(`Журнал очищен: ${result.count} записей`, 'success');
}));
el.exportLog.addEventListener('click', () => action(async () => {
  const { entries } = await askBackground({ type: 'YDBD_LOG_GET', scope: currentScope });
  const columns = ['time', 'name', 'event', 'status', 'error', 'errorType', 'downloadId', 'runId', 'attemptId', 'durationMs'];
  const csvCell = value => {
    const text = String(value ?? '');
    const safe = /^\s*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const csv = '\uFEFF' + [columns.join(','), ...entries.map(entry =>
    columns.map(key => csvCell(entry[key])).join(','))].join('\r\n');
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `yandex-disk-download-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  showStatus(`Экспортировано записей: ${entries.length}`, 'success');
}));
