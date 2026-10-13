# Политика конфиденциальности / Privacy Policy

**Продукт:** Bulk Downloader for Ya Disk (независимое расширение; не связано с Яндексом).  
**Редакция:** 13 октября 2026 г.  
**Контакт:** stanislav.sinitsyn.work@gmail.com

## Какие данные обрабатываются

Расширение видит адрес открытой папки Яндекс Диска, имена файлов, их статусы и сведения о загрузках Chrome (ID, имя, размер, ошибки). Для получения временной ссылки через текущую авторизованную сессию расширение читает значения `sk` и `connection_id` из запросов веб-клиента на `disk.yandex.ru`.

## Для чего используются данные

Эти данные нужны исключительно для формирования очереди скачивания, получения временной ссылки на выбранный файл, запуска загрузки, отображения прогресса, обработки ошибок и создания локального журнала. Расширение не предоставляет аналитику рекламодателям и не использует данные для рекламы.

## Хранение и передача

Очередь, пользовательские настройки и журнал хранятся локально в `chrome.storage.local`. Значения авторизованной сессии сохраняются в `chrome.storage.session` и не экспортируются в CSV. Временные ссылки на файлы запрашиваются только у `disk.yandex.ru`, а содержимое файлов Chrome скачивает с доменов загрузки Яндекс Диска. Отдельного внешнего сервера разработчика или системы аналитики нет. Расширение не передаёт данные разработчику.

Содержимое файлов не считывается расширением для анализа и не сохраняется в его локальном хранилище. Chrome сохраняет скачанные файлы в выбранную пользователем папку.

## Управление и удаление

Пользователь может очистить очередь и журнал отдельно через интерфейс. Удаление расширения удаляет локальные данные расширения в профиле Chrome согласно правилам Chrome. Уже скачанные файлы и экспортированные CSV остаются у пользователя, пока он сам их не удалит.

Скрытие панели Chrome во время скачивания и очистка прерванных записей в истории скачиваний — управляемые пользователем настройки; история очищается только при отдельном включении опции.

## Изменения и контакт

Обновления этой политики публикуются вместе с новыми версиями расширения. Перед публикацией владелец должен указать контактный адрес и разместить политику на публичной странице по HTTPS.

---

## English summary

This independent extension downloads files from the user's own Yandex Disk account. It locally processes folder URLs, file names, download states, and temporary authenticated-session parameters (`sk`, `connection_id`) required for requests to Yandex Disk. Queue records, settings, and event logs remain in Chrome extension local storage; session values remain in session storage. No analytics, advertising, developer-operated backend, or transmission to the developer is used. Chrome downloads the requested files directly from Yandex services. Users can clear local queues and event logs separately. The extension is not affiliated with Yandex.

**Developer contact:** stanislav.sinitsyn.work@gmail.com
