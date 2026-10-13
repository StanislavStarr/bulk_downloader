(() => {
  if (window.__YDBD_CONTENT_READY__) return;
  window.__YDBD_CONTENT_READY__ = true;

  const FILE_SELECTOR = '.listing-item.listing-item_type_file';
  const NAME_SELECTOR = '.listing-item__title[aria-label]';
  const DELAY_MS = 420;
  const MAX_STEPS = 1200;
  const MAX_DURATION_MS = 5 * 60 * 1000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let task = null;

  function snapshotNames() {
    const nodes = [...document.querySelectorAll(FILE_SELECTOR)];
    const names = nodes.map(node =>
      node.querySelector(NAME_SELECTOR)?.getAttribute('aria-label')?.normalize('NFC') || ''
    );
    return { nodes, names: names.filter(Boolean), unnamed: names.filter(x => !x).length };
  }

  function scanCurrentPage() {
    const { nodes, names, unnamed } = snapshotNames();
    return {
      ok: true,
      scope: location.href,
      count: nodes.length,
      unnamedCount: unnamed,
      sample: names.slice(0, 15)
    };
  }

  function getScroller(firstNode) {
    let node = firstNode?.parentElement;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        node.clientHeight > 100 &&
        node.scrollHeight > node.clientHeight + 50
      ) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function setScrollTop(element, top) {
    if (element === document.scrollingElement) {
      window.scrollTo({ top, behavior: 'instant' });
    } else {
      element.scrollTop = top;
    }
    await sleep(DELAY_MS);
  }

  function collect(t) {
    const { names } = snapshotNames();
    for (const name of names) {
      if (t.seen.has(name)) continue;
      t.seen.add(name);
      t.pending.set(name, { name });
    }
  }

  async function flush(t) {
    if (t.sending || t.pending.size === 0) return;
    t.sending = true;
    const batch = [...t.pending.values()].slice(0, 150);
    for (const item of batch) t.pending.delete(item.name);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'YDBD_QUEUE_ADD', scope: t.scope, items: batch
      });
      if (!res?.ok) throw new Error(res?.error || 'Ошибка записи очереди');
      t.persisted += batch.length;
      t.note = '';
    } catch (error) {
      for (const item of batch) t.pending.set(item.name, item);
      t.note = `Ошибка сохранения: ${error.message}`;
      console.warn('[YD Downloader]', t.note);
    } finally {
      t.sending = false;
    }
  }

  async function notify(t, status) {
    try {
      await chrome.runtime.sendMessage({
        type: 'YDBD_SCAN_STATE', scope: t.scope,
        status, steps: t.steps, collected: t.seen.size, note: t.note
      });
    } catch (error) {
      console.warn('[YD Downloader] Нет связи с background:', error);
    }
  }

  async function run(t) {
    const started = Date.now();
    const first = document.querySelector(FILE_SELECTOR);
    const scroller = getScroller(first);
    const initialTop = scroller.scrollTop;
    let bottomStable = 0;
    let reason = '';
    let observer;
    let scheduled = false;

    try {
      observer = new MutationObserver(() => {
        if (!t.running || scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          if (t.running && location.href === t.scope) collect(t);
        }, 80);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      collect(t);
      await notify(t, 'running');

      for (let step = 0; step < MAX_STEPS; step++) {
        if (t.stop) { reason = 'Остановлено пользователем'; break; }
        if (location.href !== t.scope) { reason = 'Папка изменилась'; break; }
        if (Date.now() - started > MAX_DURATION_MS) {
          reason = 'Лимит 5 минут; можно запустить сбор повторно';
          break;
        }

        t.steps++;
        collect(t);
        await flush(t);
        if (step % 4 === 0) await notify(t, 'running');

        const before = scroller.scrollTop;
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const atBottom = before >= maxTop - 4;
        const countBefore = t.seen.size;

        if (atBottom) {
          await sleep(650);
        } else {
          const delta = Math.max(180, Math.floor(scroller.clientHeight * 0.65));
          await setScrollTop(scroller, Math.min(maxTop, before + delta));
        }

        collect(t);
        const finalMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const nowAtBottom = scroller.scrollTop >= finalMax - 4;
        if (nowAtBottom && countBefore === t.seen.size) bottomStable++;
        else bottomStable = 0;

        if (bottomStable >= 4) { reason = 'Достигнут конец списка'; break; }
        if (step === MAX_STEPS - 1) reason = 'Лимит шагов прокрутки';
      }
    } catch (error) {
      reason = `Ошибка сбора: ${error.message}`;
      console.error('[YD Downloader]', error);
    } finally {
      observer?.disconnect();
      t.running = false;
      if (location.href === t.scope && scroller.isConnected) {
        try { await setScrollTop(scroller, initialTop); } catch (_) {}
      }
      if (location.href === t.scope) collect(t);
      for (let i = 0; i < 5 && t.pending.size > 0; i++) {
        await flush(t);
        if (t.pending.size) await sleep(900);
      }
      t.note = [reason, t.pending.size ? `Не сохранено: ${t.pending.size}` : ''].filter(Boolean).join('; ');
      const incomplete = t.pending.size > 0 || /Лимит|Папка изменилась|Ошибка сбора/.test(reason);
      await notify(t, incomplete ? 'partial' : (t.stop ? 'stopped' : 'finished'));
    }
  }

  function diskPathFromScope(scope, name) {
    const url = new URL(scope);
    if (url.origin !== 'https://disk.yandex.ru') {
      throw new Error('Недопустимый домен');
    }
    const prefix = '/client/disk';
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) {
      throw new Error('Открой личную папку Яндекс Диска');
    }
    const segments = url.pathname.slice(prefix.length).split('/').filter(Boolean)
      .map(part => decodeURIComponent(part));
    if (typeof name !== 'string' || !name || /[/\\\0]/.test(name) ||
        name === '..' || name === '.') {
      throw new Error('Недопустимое имя файла');
    }
    if (segments.some(part => !part || part === '.' || part === '..' || part.includes('/'))) {
      throw new Error('Недопустимые компоненты пути');
    }
    return ['/disk', ...segments, name].join('/');
  }

  async function getDirectUrl(message) {
    if (location.href !== message.scope) {
      throw new Error('Открыта другая папка Яндекс Диска');
    }
    const { sk, connection_id: connectionId } = message.session || {};
    if (typeof sk !== 'string' || !sk || typeof connectionId !== 'string' || !connectionId) {
      throw new Error('Сессия API не обнаружена. Обнови вкладку Яндекс Диска');
    }
    const path = diskPathFromScope(message.scope, message.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/models-v2?m=mpfs/url', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({
          sk,
          connection_id: connectionId,
          apiMethod: 'mpfs/url',
          requestParams: { path }
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`API HTTP ${response.status}`);
      }
      const payload = await response.json();
      const raw = payload?.file;
      if (typeof raw !== 'string' || !raw) {
        throw new Error('В ответе API отсутствует ссылка file');
      }
      const url = new URL(raw.startsWith('//') ? 'https:' + raw : raw);
      if (url.protocol !== 'https:' ||
          !/^([a-z0-9-]+\.)*downloader\.disk\.yandex\.(ru|net)$/i.test(url.hostname)) {
        throw new Error('API вернул неожиданный домен скачивания');
      }
      return { ok: true, url: url.href };
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'API не ответил за 20 секунд' : error.message;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'YDBD_SCAN_CURRENT_PAGE') {
      sendResponse(scanCurrentPage());
    } else if (message?.type === 'YDBD_START_COLLECTION') {
      if (task?.running) {
        sendResponse({ ok: false, error: 'Сканирование уже выполняется' });
        return;
      }
      task = {
        scope: location.href,
        seen: new Set(), pending: new Map(), persisted: 0,
        steps: 0, stop: false, running: true, sending: false, note: ''
      };
      sendResponse({ ok: true, scope: task.scope });
      void run(task);
    } else if (message?.type === 'YDBD_STOP_COLLECTION') {
      if (task?.running) task.stop = true;
      sendResponse({ ok: true, stopping: Boolean(task?.running) });
    } else if (message.type === 'YDBD_GET_DIRECT_URL') {
      void getDirectUrl(message).then(sendResponse).catch(error => {
        sendResponse({ ok: false, error: error.message || 'Ошибка запроса API' });
      });
      return true;
    } else if (message?.type === 'YDBD_COLLECTION_STATUS') {
      sendResponse({
        ok: true, running: Boolean(task?.running),
        collected: task?.seen.size ?? 0,
        steps: task?.steps ?? 0,
        pendingStorage: task?.pending.size ?? 0
      });
    }
  });

  
})();
