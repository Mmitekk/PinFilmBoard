# PinFilmBoard

Личная доска фильмов «посмотреть позже» на GitHub Pages: masonry-сетка постеров как в Pinterest,
канбан с цветными колонками и drag & drop, описания фильмов из Википедии. Стиль и механика —
сёстры [PinVideoBoard](https://github.com/Mmitekk/PinVideoBoard) и [PinRefBoard](https://github.com/Mmitekk/PinRefBoard).

Сайт полностью статический (ванильный JS, без сборки и зависимостей).

## Возможности

**Публичная часть (всем посетителям)**
- Masonry-сетка постеров: обложка, название, год, описание, источник, теги.
- Фильтры: вкладки досок, поиск (`/` — фокус), источник (Кинопоиск / IMDb / Okko / Википедия / другое), тег, сортировка (дата/название/год).
- Канбан-вид (переключатель «Сетка ⇄ Канбан») — колонки «Хочу посмотреть / Смотрю / Просмотрено» с цветами.
- Модалка фильма: обложка + название + год + описание + ссылка на источник; ←/→ по отфильтрованным, Esc.

**Редактирование (владелец, после входа)**
- Добавление фильма: вставьте ссылку (Кинопоиск, IMDb, Okko, Википедия) → «Определить».
- Не удалось определить — введите название и нажмите **«Википедия»**: описание, обложка и год подтянутся из Википедии.
- Канбан: перенос между колонками drag & drop; колонки/доски создаются, красятся, удаляются.

## Как работают источники

- **IMDb** — `tt…`-id ищется в Wikidata (свойство P345) → русское название/описание → статья ru.wikipedia → обложка.
- **Википедия** — прямо REST summary (название, описание, миниатюра).
- **Okko** — slug ссылки ищется в Википедии (ru, затем en → langlinks).
- **Кинопоиск** — страницы закрыты от автоматического разбора (302 на SSO), поэтому: пытаемся маппинг id через Wikidata (P1713, заполнен у части фильмов), иначе введите название → «Википедия».
- Поиск по названию — официальный API Википедии (CORS), спарсинга HTML нет.

## Публикация (GitHub Pages)

1. Запушьте ветку `main` на GitHub (remote: `https://github.com/Mmitekk/PinFilmBoard.git`).
2. Settings → Pages → Source: **Deploy from a branch**, Branch: `main` / `/ (root)` → Save.
3. Проверьте `js/config.js` (`owner`, `repo`).

## Вход владельца

1. [Создание fine-grained токена](https://github.com/settings/personal-access-tokens/new):
   **Only select repositories → PinFilmBoard**, **Permissions → Contents → Read and write**.
2. На сайте «Войти» → вставить токен. Токен живёт только в localStorage вашего браузера
   и отправляется только на `api.github.com`; в репозиторий он не попадает никогда.

## Локальная разработка (без токена)

```bash
node tools/dev-server.mjs
# → http://127.0.0.1:8941/  (dev-режим: сохранение в локальный data/db.js без коммитов)
```

## Импорт из Pinterest

```bash
node tools/import-pinterest.mjs --dry     # показать, что будет добавлено
node tools/import-pinterest.mjs --commit  # записать в data/db.js и закоммитить локально
```

По умолчанию — доска `mmitekk/фильмы-для-просмотра` → доска «Фильмы», первая колонка.
Для каждого пина: ссылка → резолвер (IMDb через Wikidata, Okko/Википедия через поиск);
если ссылка не распарсилась — фильм ищется в Википедии по названию пина (описание и обложка
оттуда, исходная ссылка пина сохраняется как источник). Обложка — картинка пина или миниатюра
Википедии. Дубли по URL и стабильным id не создаются.

## Структура

```
index.html            — страница (галерея, канбан, модалки)
css/style.css         — монохромная тема
js/config.js          — owner / repo / DEV_MODE
js/movies.js          — парсеры ссылок + резолверы (Wikidata SPARQL, Wikipedia REST)
js/api.js             — GitHub Contents API: вход, чтение, запись, sha-guard
js/app.js             — приложение: стейт, рендер, фильтры, DnD, модалки
data/db.js            — ДАННЫЕ (коммитятся сайтом)
tools/dev-server.mjs  — локальный сервер для разработки (порт 8941)
tools/test-movies.mjs — тесты парсера ссылок
tools/import-pinterest.mjs — импорт из Pinterest-доски
```

## Схема `data/db.js`

```js
window.__PFB_DATA = {
  version: 1,
  updatedAt: "ISO",
  boards: [{
    id: "b-…", name: "Фильмы", createdAt: "ISO",
    columns: [{ id: "c-…", name: "Хочу посмотреть", color: "#4a9eff" }],
    tiles: [{
      id: "t-…", columnId: "c-…",
      url: "https://…", provider: "kinopoisk|imdb|okko|wikipedia|other",
      title: "…", poster: "https://…", description: "…", year: 1994,
      tags: ["…"], note: "", addedAt: "ISO"
    }]
  }]
};
```
