/* PinFilmBoard — приложение */
(function () {
  'use strict';

  var CFG = window.__PFB_CONFIG;
  var M = window.__PFB_MOVIES;
  var GH = window.__PFB_API;
  var VIEW_KEY = 'pfb-view';
  var COLOR_KEY = 'pfb-color';
  var PALETTE = ['#4a9eff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39c5cf', '#db61a2', '#8b949e'];
  var DEFAULT_COLUMNS = [
    { name: 'Хочу посмотреть', color: '#4a9eff' },
    { name: 'Смотрю', color: '#d29922' },
    { name: 'Просмотрено', color: '#3fb950' }
  ];

  // ---------- хелперы ----------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // монохром: цвет колонки -> оттенок серого по яркости (колонки остаются различимыми)
  function hexToGray(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    var y = Math.round(0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255));
    y = Math.max(100, Math.min(200, y));
    var g = y.toString(16);
    if (g.length < 2) g = '0' + g;
    return '#' + g + g + g;
  }

  function monoColor(hex) {
    return state.color ? hex : hexToGray(hex);
  }

  function toast(msg, type, opts) {
    opts = opts || {};
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    if (opts.linkText) {
      var link = document.createElement('span');
      link.className = 'toast-link';
      link.textContent = opts.linkText;
      link.addEventListener('click', function () {
        if (opts.onLink) opts.onLink();
        el.remove();
      });
      el.appendChild(link);
    }
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, opts.timeout || 4500);
  }

  // confirmDialog(text, {yes, no, extra}) -> Promise<'yes'|'no'|'extra'|null>
  function confirmDialog(text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var modal = $('#confirm-modal');
      $('#confirm-text').textContent = text;
      var yes = $('#confirm-yes'), no = $('#confirm-no');
      yes.textContent = opts.yes || 'Да';
      no.textContent = opts.no || 'Отмена';
      var prevExtra = $('#confirm-extra');
      if (prevExtra) prevExtra.remove();
      if (opts.extra) {
        var extra = document.createElement('button');
        extra.id = 'confirm-extra';
        extra.className = 'ghost-btn';
        extra.textContent = opts.extra;
        extra.addEventListener('click', done('extra'));
        no.parentNode.insertBefore(extra, no);
      }
      function done(val) {
        return function () {
          cleanup();
          closeModal(modal);
          resolve(val);
        };
      }
      function cleanup() {
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
      }
      var onYes = done('yes'), onNo = done('no');
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      var onClosed = function (e) {
        var t = e.target;
        if (t.closest && t.closest('#confirm-yes, #confirm-no, #confirm-extra')) return;
        if (t.closest && t.closest('.modal-body')) return; // отмена — только клик по фону
        cleanup();
        resolve('no');
      };
      modal.addEventListener('click', onClosed, { once: true });
      openModal(modal);
    });
  }

  // ---------- состояние ----------

  var state = {
    data: window.__PFB_DATA || { version: 1, updatedAt: null, boards: [] },
    remoteSha: null,
    view: localStorage.getItem(VIEW_KEY) === 'kanban' ? 'kanban' : 'grid',
    color: false,
    board: 'all',
    q: '',
    tag: '',
    provider: '',
    sort: 'new',
    user: null,
    persisting: false,
    renderedIds: [],
    filmList: [],
    filmIdx: -1,
    resolveMeta: null,
    wikiMeta: null
  };

  var editorCtx = { tileId: null, boardId: null, columnId: null };
  var colCtx = { boardId: null, colId: null };
  var boardCtx = { boardId: null };
  var dnd = { tileId: null, colId: null, index: -1 };

  // ---------- доступ к данным ----------

  function boards() { return state.data.boards || []; }

  function findBoard(id) {
    for (var i = 0; i < boards().length; i++) if (boards()[i].id === id) return boards()[i];
    return null;
  }

  function columnOf(board, colId) {
    if (!board) return null;
    var cols = board.columns || [];
    for (var i = 0; i < cols.length; i++) if (cols[i].id === colId) return cols[i];
    return null;
  }

  function allTiles() {
    var out = [];
    boards().forEach(function (b) {
      (b.tiles || []).forEach(function (t) { out.push({ tile: t, board: b }); });
    });
    return out;
  }

  function findTile(id) {
    var res = null;
    boards().forEach(function (b) {
      (b.tiles || []).forEach(function (t) { if (t.id === id) res = { tile: t, board: b }; });
    });
    return res;
  }

  function canEdit() { return GH.canEdit() && !state.persisting; }

  function tilesOf(board, colId) {
    return (board.tiles || []).filter(function (t) { return t.columnId === colId; });
  }

  // ---------- фильтрация и сортировка ----------

  function filteredTiles() {
    var q = state.q.trim().toLowerCase();
    var list = allTiles().filter(function (e) {
      if (state.board !== 'all' && e.board.id !== state.board) return false;
      if (state.provider && e.tile.provider !== state.provider) return false;
      if (state.tag) {
        var tags = (e.tile.tags || []).map(function (s) { return String(s).toLowerCase(); });
        if (tags.indexOf(state.tag.toLowerCase()) < 0) return false;
      }
      if (q) {
        var hay = [e.tile.title, e.tile.description, e.tile.note, (e.tile.tags || []).join(' ')].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    list.sort(function (a, b) {
      if (state.sort === 'title') return String(a.tile.title || '').localeCompare(String(b.tile.title || ''), 'ru');
      if (state.sort === 'year') return (b.tile.year || 0) - (a.tile.year || 0);
      // addedAt бывают в разных форматах (ISO с сайта, RFC-даты из Pinterest) — сравниваем через Date.parse
      var ta = Date.parse(a.tile.addedAt) || 0;
      var tb = Date.parse(b.tile.addedAt) || 0;
      return state.sort === 'old' ? (ta - tb) : (tb - ta);
    });
    return list;
  }

  function hasActiveFilters() {
    return !!(state.board !== 'all' || state.q.trim() || state.tag || state.provider || state.sort !== 'new');
  }

  function resetFilters() {
    state.board = 'all';
    state.q = '';
    state.tag = '';
    state.provider = '';
    state.sort = 'new';
    $('#search').value = '';
    $('#search-clear').hidden = true;
    $('#f-tag').value = '';
    $('#f-provider').value = '';
    $('#f-sort').value = 'new';
    renderAll();
  }

  // ---------- persist ----------

  function persist(label) {
    if (!GH.canEdit()) {
      toast('Нет прав на редактирование — войдите как владелец', 'warn');
      return Promise.resolve(false);
    }
    if (state.persisting) {
      toast('Подождите — идёт сохранение предыдущего изменения', 'warn');
      return Promise.resolve(false);
    }
    state.persisting = true;
    state.data.updatedAt = new Date().toISOString();
    var expectedSha = state.remoteSha;
    return GH.save(state.data, expectedSha, label).then(function (res) {
      state.persisting = false;
      if (res && res.conflict) { handleConflict(res.conflict, label); return false; }
      if (res && res.dev) {
        toast('Сохранено локально (dev-режим)');
        return true;
      }
      if (res && res.noop) return true;
      state.remoteSha = res && res.sha ? res.sha : state.remoteSha;
      toast('Сохранено — коммит отправлен. GitHub Pages обновится через ~1 мин.');
      return true;
    }).catch(function (err) {
      state.persisting = false;
      toast(err.message || 'Ошибка сохранения', 'err');
      return false;
    });
  }

  function handleConflict(conflict, label) {
    confirmDialog(
      'Данные в репозитории изменились не из этого браузера. Что сделать с вашими локальными изменениями?',
      { yes: 'Перезаписать моими', extra: 'Загрузить удалённые', no: 'Отмена' }
    ).then(function (choice) {
      if (choice === 'yes') {
        state.persisting = true;
        GH.overwrite(state.data, conflict.sha, label).then(function (res) {
          state.persisting = false;
          state.remoteSha = res && res.sha ? res.sha : state.remoteSha;
          toast('Сохранено (перезаписано). Pages обновится через ~1 мин.');
        }).catch(function (err) {
          state.persisting = false;
          toast(err.message || 'Ошибка сохранения', 'err');
        });
      } else if (choice === 'extra') {
        if (conflict.data) {
          state.data = conflict.data;
          state.remoteSha = conflict.sha;
          toast('Загружена версия из репозитория (локальные изменения отброшены)', 'warn');
          renderAll();
        } else {
          toast('Не удалось разобрать удалённые данные', 'err');
        }
      }
    });
  }

  // ---------- рендер: шапка ----------

  function renderTabs() {
    var tabs = $('#tabs');
    var counts = { all: allTiles().length };
    boards().forEach(function (b) { counts[b.id] = (b.tiles || []).length; });
    var html = '';
    html += tabHTML('all', 'Все', counts.all);
    boards().forEach(function (b) {
      html += tabHTML(b.id, b.name, counts[b.id]);
    });
    if (GH.canEdit()) {
      html += '<button class="tab-add" id="tab-add" title="Новая доска">+ доска</button>';
    }
    tabs.innerHTML = html;
  }

  function tabHTML(id, name, count) {
    return '<button class="tab' + (state.board === id ? ' active' : '') + '" data-board="' + esc(id) + '">' +
      esc(name) + ' <span class="count">' + count + '</span></button>';
  }

  function buildFilterOptions() {
    var tags = {};
    var providers = {};
    allTiles().forEach(function (e) {
      providers[e.tile.provider] = true;
      (e.tile.tags || []).forEach(function (t) { if (t) tags[String(t)] = true; });
    });
    var provKeys = Object.keys(providers).sort();
    var tagKeys = Object.keys(tags).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
    fillSelect($('#f-provider'), provKeys.map(function (p) { return { v: p, label: M.providerLabel(p) }; }), state.provider);
    fillSelect($('#f-tag'), tagKeys.map(function (t) { return { v: t, label: t }; }), state.tag);
    state.provider = $('#f-provider').value || '';
    state.tag = $('#f-tag').value || '';
  }

  function fillSelect(sel, items, current) {
    var first = sel.options[0];
    var prev = current;
    sel.innerHTML = '';
    sel.appendChild(first);
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.v;
      o.textContent = it.label;
      if (it.v === prev) o.selected = true;
      sel.appendChild(o);
    });
    if (sel.selectedIndex <= 0 && prev) sel.value = '';
  }

  function renderStats() {
    var n = allTiles().length;
    var nb = boards().length;
    var s = n + ' ' + plural(n, 'фильм', 'фильма', 'фильмов') + ' · ' + nb + ' ' + plural(nb, 'доска', 'доски', 'досок');
    if (GH.isLocalDev()) s += ' · dev-режим (сохранение в локальный файл)';
    $('#meta-stats').textContent = s;
    $('#f-reset').hidden = !hasActiveFilters();
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // ---------- рендер: галерея ----------

  // masonry читается слева направо (как Pinterest): раскладываем по колонкам round-robin.
  // CSS columns здесь не годится — он наполняет колонку сверху вниз, и «новые» уезжали вбок/вниз.
  var COL_GAP = 14;

  function columnCount(width) {
    var min = width <= 560 ? 150 : 200;
    return Math.max(2, Math.floor((width + COL_GAP) / (min + COL_GAP)));
  }

  function renderGallery() {
    var list = filteredTiles();
    state.renderedIds = list.map(function (e) { return e.tile.id; });
    var grid = $('#gallery');
    var cols = columnCount(grid.clientWidth || window.innerWidth);
    var colHtml = [];
    for (var i = 0; i < cols; i++) colHtml.push('');
    list.forEach(function (e, i) {
      colHtml[i % cols] += cardHTML(e);
    });
    grid.innerHTML = colHtml.map(function (c) { return '<div class="m-col">' + c + '</div>'; }).join('');
    var empty = $('#empty');
    if (state.view === 'grid' && !list.length) {
      empty.hidden = false;
      $('#empty-text').textContent = allTiles().length
        ? 'По выбранным фильтрам ничего не найдено'
        : 'Здесь появятся фильмы, когда владелец добавит их';
      $('#empty-reset').hidden = !allTiles().length;
    } else {
      empty.hidden = true;
    }
  }

  function cardHTML(e) {
    var t = e.tile;
    var col = columnOf(e.board, t.columnId);
    var color = col ? monoColor(col.color) : null;
    var style = '';
    if (color) style += '--c:' + esc(color) + ';--c-bg:' + hexToRgba(color, 0.14) + ';';

    var posterHTML;
    if (t.poster) {
      posterHTML = '<div class="card-poster-wrap"><img class="card-poster" src="' + esc(t.poster) + '" alt="" loading="lazy" data-fb=""></div>';
    } else {
      posterHTML = '<div class="card-poster-wrap ph"><div class="ph-glyph">🎬</div></div>';
    }

    var chips = '<span class="chip chip-provider">' + esc(M.providerLabel(t.provider)) + '</span>';
    if (t.year) chips += '<span class="chip">' + esc(t.year) + '</span>';
    if (col) chips += '<span class="chip chip-column">' + esc(col.name) + '</span>';
    if (state.board === 'all') chips += '<span class="chip">' + esc(e.board.name) + '</span>';

    var tagHTML = '';
    (t.tags || []).slice(0, 3).forEach(function (tag) {
      tagHTML += '<span class="card-tag">' + esc(tag) + '</span>';
    });

    var actions = '';
    if (GH.canEdit()) {
      actions = '<span class="card-actions">' +
        '<button class="icon-btn" data-act="edit" data-id="' + esc(t.id) + '" title="Изменить">✎</button>' +
        '<button class="icon-btn danger" data-act="del" data-id="' + esc(t.id) + '" title="Удалить">✕</button>' +
        '</span>';
    }

    return '<article class="card" data-id="' + esc(t.id) + '" style="' + style + '">' +
      posterHTML +
      actions +
      '<div class="card-body">' +
      '<h3 class="card-title">' + esc(t.title || 'Без названия') + '</h3>' +
      (t.description ? '<p class="card-desc">' + esc(t.description) + '</p>' : '') +
      '<div class="card-chips">' + chips + '</div>' +
      (tagHTML ? '<div class="card-tags">' + tagHTML + '</div>' : '') +
      '</div></article>';
  }

  // обложки Wikimedia иногда отдают 404 на конкретный размер — попробуем исходный размер
  function onImgError(e) {
    var img = e.target;
    if (!img || !img.tagName || img.tagName.toLowerCase() !== 'img') return;
    var fb = (img.getAttribute('data-fb') || '').split('|').filter(Boolean);
    if (fb.length) {
      img.src = fb.shift();
      img.setAttribute('data-fb', fb.join('|'));
      return;
    }
    if (img.id === 'tile-preview-img') { img.hidden = true; return; }
    var wrap = img.parentNode;
    if (wrap && wrap.classList.contains('card-poster-wrap')) {
      wrap.classList.add('ph');
      img.remove();
      var g = document.createElement('div');
      g.className = 'ph-glyph';
      g.textContent = '🎬';
      wrap.insertBefore(g, wrap.firstChild);
      return;
    }
    if (img.id === 'film-poster') {
      // не затираем innerHTML — img нужен для следующих открытий
      var w = $('#film-poster-wrap');
      if (w) {
        w.classList.add('ph');
        img.hidden = true;
        img.removeAttribute('src');
        var g = document.createElement('div');
        g.className = 'ph-glyph';
        g.textContent = '🎬';
        w.appendChild(g);
      }
      return;
    }
    if (img.classList.contains('kb-card-poster')) {
      var ph = document.createElement('div');
      ph.className = 'kb-card-ph';
      ph.textContent = '🎬';
      img.parentNode.replaceChild(ph, img);
    }
  }

  // ---------- рендер: канбан ----------

  function renderKanban() {
    var kanban = $('#kanban');
    if (state.board === 'all') {
      if (boards().length) state.board = boards()[0].id;
      else { kanban.innerHTML = '<div class="empty"><div class="empty-mark">🎬</div><p>Нет ни одной доски</p></div>'; return; }
    }
    var b = findBoard(state.board);
    if (!b) { state.board = 'all'; renderKanban(); return; }

    var edit = GH.canEdit();
    var html = '<div class="kb-head">' +
      '<h2 class="kb-title">' + esc(b.name) + '</h2>' +
      '<span class="kb-sub">' + (b.tiles || []).length + ' ' + plural((b.tiles || []).length, 'фильм', 'фильма', 'фильмов') + ' · ' + (b.columns || []).length + ' колонок</span>' +
      '<span class="spacer"></span>' +
      (edit ? '<button class="icon-btn" id="kb-board-menu" title="Меню доски">⋮</button>' +
        '<button class="add-btn" id="kb-add-tile"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>Добавить фильм</button>' : '') +
      '</div>';

    html += '<div class="kb-cols">';
    (b.columns || []).forEach(function (c) {
      html += columnHTML(b, c, edit);
    });
    if (edit) html += '<button class="kb-add-col" id="kb-add-col">+ колонка</button>';
    html += '</div>';

    kanban.innerHTML = html;

    if (edit) {
      var addCol = $('#kb-add-col');
      if (addCol) addCol.addEventListener('click', function () { openColumnModal(null, b.id); });
      var addTile = $('#kb-add-tile');
      if (addTile) addTile.addEventListener('click', function () { openTileModal(null, { boardId: state.board }); });
    }
  }

  function columnHTML(b, c, edit) {
    var tiles = tilesOf(b, c.id);
    var cCol = monoColor(c.color);
    var style = '--c:' + esc(cCol) + ';--c-bg:' + hexToRgba(cCol, 0.14) + ';';
    var html = '<section class="kb-col" data-col="' + esc(c.id) + '" style="' + style + '">' +
      '<header class="kb-col-head">' +
      '<span class="kb-col-dot"></span>' +
      '<span class="kb-col-name">' + esc(c.name) + '</span>' +
      '<span class="kb-count">' + tiles.length + '</span>' +
      (edit ? '<button class="icon-btn kb-menu-btn" data-colmenu="' + esc(c.id) + '" title="Меню колонки">⋮</button>' : '') +
      '</header>' +
      '<div class="kb-cards">';
    tiles.forEach(function (t) {
      html += kbCardHTML(b, c, t, edit);
    });
    if (edit) html += '<button class="kb-add-card" data-addcard="' + esc(c.id) + '">+ фильм</button>';
    html += '</div></section>';
    return html;
  }

  function kbCardHTML(b, c, t, edit) {
    var posterHTML = t.poster
      ? '<img class="kb-card-poster" src="' + esc(t.poster) + '" alt="" loading="lazy" data-fb="">'
      : '<div class="kb-card-ph">🎬</div>';
    return '<article class="kb-card" data-id="' + esc(t.id) + '"' + (edit ? ' draggable="true"' : '') + '>' +
      posterHTML +
      '<div class="kb-card-body">' +
      '<h4 class="kb-card-title">' + esc(t.title || 'Без названия') + '</h4>' +
      '<div class="kb-card-meta">' +
      '<span>' + esc(M.providerLabel(t.provider)) + '</span>' +
      (t.year ? '<span>·</span><span>' + esc(t.year) + '</span>' : '') +
      '</div></div>' +
      (edit ? '<button class="icon-btn kb-card-menu" data-cardmenu="' + esc(t.id) + '" title="Меню карточки">⋮</button>' : '') +
      '</article>';
  }

  // kanban click delegation
  function onKanbanClick(e) {
    var card = e.target.closest('.kb-card');
    var cardMenuBtn = e.target.closest('[data-cardmenu]');
    var colMenuBtn = e.target.closest('[data-colmenu]');
    var addCardBtn = e.target.closest('[data-addcard]');

    if (addCardBtn) {
      var colId = addCardBtn.getAttribute('data-addcard');
      openTileModal(null, { boardId: state.board, columnId: colId });
      return;
    }
    if (colMenuBtn) {
      e.stopPropagation(); // не давать документному «клик мимо меню» закрыть его сразу
      var rect = colMenuBtn.getBoundingClientRect();
      showColumnMenu(colMenuBtn.getAttribute('data-colmenu'), rect.left, rect.bottom + 4);
      return;
    }
    if (cardMenuBtn) {
      e.stopPropagation();
      var r = cardMenuBtn.getBoundingClientRect();
      showCardMenu(cardMenuBtn.getAttribute('data-cardmenu'), r.left, r.bottom + 4);
      return;
    }
    if (card) {
      openFilm(card.getAttribute('data-id'));
    }
  }

  function showCardMenu(tileId, x, y) {
    var found = findTile(tileId);
    if (!found) return;
    var b = found.board;
    var items = [
      { label: 'Открыть', action: function () { openFilm(tileId); } },
      { label: 'Изменить', action: function () { openTileModal(tileId, null); } },
      '-'
    ];
    (b.columns || []).forEach(function (c) {
      if (c.id === found.tile.columnId) return;
      items.push({
        label: '→ ' + c.name,
        color: monoColor(c.color),
        action: function () { moveTile(tileId, c.id, tilesOf(b, c.id).length); }
      });
    });
    items.push('-', { label: 'Удалить', danger: true, action: function () { deleteTile(tileId); } });
    showMenu(items, x, y);
  }

  function deleteTile(tileId) {
    var found = findTile(tileId);
    if (!found) return;
    confirmDialog('Удалить фильм «' + (found.tile.title || 'без названия') + '»?')
      .then(function (choice) {
        if (choice !== 'yes') return;
        found.board.tiles = (found.board.tiles || []).filter(function (x) { return x.id !== tileId; });
        persist('доска «' + found.board.name + '»: удалено — ' + (found.tile.title || '')).then(function (ok) {
          if (ok) renderAll();
        });
      });
  }

  function showColumnMenu(colId, x, y) {
    var b = findBoard(state.board);
    var c = b ? columnOf(b, colId) : null;
    if (!b || !c) return;
    var items = [
      { label: 'Переименовать / цвет', action: function () { openColumnModal(colId); } },
      { label: 'Добавить фильм', action: function () { openTileModal(null, { boardId: b.id, columnId: colId }); } },
      '-',
      { label: 'Удалить колонку', danger: true, action: function () { deleteColumn(b.id, colId); } }
    ];
    showMenu(items, x, y);
  }

  function onBoardMenuClick(e) {
    var btn = e.target.closest('#kb-board-menu');
    if (!btn) return;
    e.stopPropagation();
    var rect = btn.getBoundingClientRect();
    var items = [
      { label: 'Переименовать доску', action: function () { openBoardModal(state.board); } },
      '-',
      { label: 'Удалить доску', danger: true, action: function () { deleteBoard(state.board); } }
    ];
    showMenu(items, rect.left, rect.bottom + 4);
  }

  function deleteColumn(boardId, colId) {
    var b = findBoard(boardId);
    var c = b ? columnOf(b, colId) : null;
    if (!b || !c) return;
    var n = tilesOf(b, colId).length;
    confirmDialog(
      n ? 'Удалить колонку «' + c.name + '»? Её ' + n + ' ' + plural(n, 'фильм', 'фильма', 'фильмов') +
        ' переместится в первую оставшуюся колонку.'
        : 'Удалить колонку «' + c.name + '»?'
    ).then(function (choice) {
      if (choice !== 'yes') return;
      var cols = b.columns || [];
      var rest = cols.filter(function (x) { return x.id !== colId; });
      var fallback = rest.length ? rest[0].id : null;
      if (fallback) {
        (b.tiles || []).forEach(function (t) { if (t.columnId === colId) t.columnId = fallback; });
      } else {
        b.tiles = (b.tiles || []).filter(function (t) { t.columnId !== colId; });
      }
      b.columns = rest;
      persist('доска «' + b.name + '»: удалена колонка «' + c.name + '»').then(function (ok) {
        if (ok) renderAll();
      });
    });
  }

  function deleteBoard(boardId) {
    var b = findBoard(boardId);
    if (!b) return;
    confirmDialog('Удалить доску «' + b.name + '» вместе с ' + (b.tiles || []).length + ' ' + plural((b.tiles || []).length, 'фильмом', 'фильмами', 'фильмами') + '?')
      .then(function (choice) {
        if (choice !== 'yes') return;
        state.data.boards = boards().filter(function (x) { return x.id !== boardId; });
        state.board = 'all';
        persist('удалена доска «' + b.name + '»').then(function (ok) {
          if (ok) renderAll();
        });
      });
  }

  // ---------- drag & drop ----------

  function onKanbanDragStart(e) {
    var card = e.target.closest ? e.target.closest('.kb-card') : null;
    if (!card || !GH.canEdit()) { e.preventDefault(); return; }
    dnd.tileId = card.getAttribute('data-id');
    dnd.colId = null;
    dnd.index = -1;
    card.classList.add('dragging');
    try {
      e.dataTransfer.setData('text/plain', dnd.tileId);
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) { /* ignore */ }
  }

  function onKanbanDragOver(e) {
    if (!dnd.tileId) return;
    var list = e.target.closest ? e.target.closest('.kb-cards') : null;
    if (!list) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    $all('.drop-indicator').forEach(function (n) { n.remove(); });

    var col = list.closest('.kb-col');
    var colId = col ? col.getAttribute('data-col') : null;

    var cards = $all('.kb-card', list).filter(function (c) { return !c.classList.contains('dragging'); });
    var index = cards.length;
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }

    var ind = document.createElement('div');
    ind.className = 'drop-indicator';
    if (index < cards.length) list.insertBefore(ind, cards[index]);
    else list.appendChild(ind);
    var addBtn = list.querySelector('.kb-add-card');
    if (addBtn && ind.previousElementSibling === addBtn) {
      list.insertBefore(ind, addBtn);
    }

    dnd.colId = colId;
    dnd.index = index;

    $all('.kb-col').forEach(function (c) {
      c.classList.toggle('drag-over', c === col);
    });
  }

  function onKanbanDrop(e) {
    if (!dnd.tileId || !dnd.colId || dnd.index < 0) { cleanupDnd(); return; }
    e.preventDefault();
    var tileId = dnd.tileId, colId = dnd.colId, index = dnd.index;
    cleanupDnd();
    moveTile(tileId, colId, index);
  }

  function cleanupDnd() {
    $all('.drop-indicator').forEach(function (n) { n.remove(); });
    $all('.kb-col.drag-over').forEach(function (n) { n.classList.remove('drag-over'); });
    $all('.kb-card.dragging').forEach(function (n) { n.classList.remove('dragging'); });
    dnd.tileId = null; dnd.colId = null; dnd.index = -1;
  }

  function moveTile(tileId, colId, index) {
    var found = findTile(tileId);
    if (!found) return;
    var b = found.board;
    var t = found.tile;
    if (t.columnId === colId) {
      var cur = tilesOf(b, colId).map(function (x) { return x.id; });
      if (cur[Math.min(index, cur.length - 1)] === tileId || cur.indexOf(tileId) === index) {
        renderKanban();
        return;
      }
    }
    var tiles = b.tiles || [];
    var i = tiles.indexOf(t);
    if (i >= 0) tiles.splice(i, 1);
    t.columnId = colId;
    var idx = 0, insertAt = tiles.length;
    for (var k = 0; k < tiles.length; k++) {
      if (tiles[k].columnId === colId) {
        if (idx === index) { insertAt = k; break; }
        idx++;
      }
    }
    tiles.splice(insertAt, 0, t);
    var col = columnOf(b, colId);
    var label = 'доска «' + b.name + '»: «' + (t.title || 'без названия') + '» → ' + (col ? col.name : colId);
    persist(label).then(function (ok) {
      if (ok) { renderKanban(); renderTabs(); renderStats(); buildFilterOptions(); }
      else renderKanban(); // откат отображения при ошибке сохранения
    });
  }

  // ---------- контекстное меню ----------

  var menuItems = null;

  function showMenu(items, x, y) {
    menuItems = items;
    var menu = $('#menu');
    var html = '';
    items.forEach(function (it, i) {
      if (it === '-') { html += '<div class="menu-sep"></div>'; return; }
      html += '<button class="menu-item' + (it.danger ? ' danger' : '') + '" data-idx="' + i + '">' +
        (it.color ? '<span class="menu-color" style="background:' + esc(it.color) + '"></span>' : '') +
        esc(it.label) + '</button>';
    });
    menu.innerHTML = html;
    menu.hidden = false;
    var r = menu.getBoundingClientRect();
    var maxX = window.innerWidth - r.width - 8;
    var maxY = window.innerHeight - r.height - 8;
    menu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
  }

  function closeMenu() {
    $('#menu').hidden = true;
    menuItems = null;
  }

  function onMenuClick(e) {
    var btn = e.target.closest('.menu-item');
    if (!btn) return;
    var idx = parseInt(btn.getAttribute('data-idx'), 10);
    var it = menuItems && menuItems[idx];
    closeMenu();
    if (it && it.action) it.action();
  }

  // ---------- модалки (базовые) ----------

  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (!$all('.modal').some(function (m) { return !m.hidden; })) {
      document.body.classList.remove('modal-open');
    }
    if (modal.id === 'film-modal') closeFilmData();
  }

  function closeAllModals() {
    $all('.modal').forEach(function (m) { m.hidden = true; });
    document.body.classList.remove('modal-open');
    closeFilmData();
  }

  // ---------- модалка фильма ----------

  function openFilm(tileId) {
    var list = state.renderedIds;
    if (!list.length) {
      var found = findTile(tileId);
      list = found ? [found.tile.id] : [];
    }
    var idx = list.indexOf(tileId);
    if (idx < 0) { list = [tileId]; idx = 0; }
    state.filmList = list;
    state.filmIdx = idx;
    renderFilm();
    openModal($('#film-modal'));
  }

  function renderFilm() {
    var entry = findTile(state.filmList[state.filmIdx]);
    if (!entry) { closeModal($('#film-modal')); return; }
    var t = entry.tile;
    var col = columnOf(entry.board, t.columnId);

    $('#film-title').textContent = t.title || 'Без названия';
    var badges = '<span class="chip chip-provider">' + esc(M.providerLabel(t.provider)) + '</span>';
    if (t.year) badges += '<span class="chip">' + esc(t.year) + '</span>';
    if (col) badges += '<span class="chip chip-column" style="--c:' + esc(monoColor(col.color)) + '">' + esc(col.name) + '</span>';
    badges += '<span class="chip">' + esc(entry.board.name) + '</span>';
    $('#film-badges').innerHTML = badges;

    var link = $('#film-src-link');
    link.href = t.url || '#';

    $('#film-name').textContent = t.title || 'Без названия';
    var yearEl = $('#film-year');
    if (t.year) { yearEl.hidden = false; yearEl.textContent = 'Год: ' + t.year; }
    else yearEl.hidden = true;
    $('#film-desc').textContent = t.description || 'Описание не заполнено.';

    var wrap = $('#film-poster-wrap');
    var img = $('#film-poster');
    wrap.classList.remove('ph');
    // старую заглушку убираем точечно — innerHTML бы уничтожил сам <img>,
    // и следующее открытие модалки падало (карточки переставали открываться)
    var oldGlyph = wrap.querySelector('.ph-glyph');
    if (oldGlyph) oldGlyph.remove();
    if (t.poster) {
      img.hidden = false;
      img.src = t.poster;
      img.setAttribute('data-fb', '');
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      wrap.classList.add('ph');
      var glyph = document.createElement('div');
      glyph.className = 'ph-glyph';
      glyph.textContent = '🎬';
      wrap.appendChild(glyph);
    }

    $('#film-prev').hidden = state.filmList.length < 2;
    $('#film-next').hidden = state.filmList.length < 2;
  }

  function filmNav(step) {
    var n = state.filmList.length;
    if (n < 2) return;
    state.filmIdx = (state.filmIdx + step + n) % n;
    renderFilm();
  }

  function closeFilmData() {
    var img = $('#film-poster');
    img.removeAttribute('src');
    state.filmList = [];
    state.filmIdx = -1;
  }

  // ---------- редактор фильма ----------

  function openTileModal(tileId, preset) {
    editorCtx = { tileId: tileId || null, boardId: null, columnId: null };
    state.resolveMeta = null;
    state.wikiMeta = null;

    var modal = $('#tile-modal');
    $('#tile-modal-title').textContent = tileId ? 'Изменить фильм' : 'Добавить фильм';
    $('#tile-delete').hidden = !tileId;
    $('#tile-save').disabled = false;

    var boardSel = $('#tile-board');
    boardSel.innerHTML = '';
    boards().forEach(function (b) {
      var o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.name;
      boardSel.appendChild(o);
    });
    if (!boards().length) {
      toast('Сначала создайте доску', 'warn');
      return;
    }

    if (tileId) {
      var found = findTile(tileId);
      if (!found) return;
      var t = found.tile;
      editorCtx.boardId = found.board.id;
      editorCtx.columnId = t.columnId;
      $('#tile-url').value = t.url || '';
      $('#tile-title').value = t.title || '';
      $('#tile-desc').value = t.description || '';
      $('#tile-tags').value = (t.tags || []).join(', ');
      $('#tile-note').value = t.note || '';
      boardSel.value = found.board.id;
      fillColumnSelect(found.board.id, t.columnId);
      showTilePreview(t.provider, t.poster);
      $('#tile-resolve-status').hidden = true;
    } else {
      var bId = (preset && preset.boardId) || (state.board !== 'all' ? state.board : boards()[0].id);
      if (!findBoard(bId)) bId = boards()[0].id;
      editorCtx.boardId = bId;
      editorCtx.columnId = (preset && preset.columnId) || (findBoard(bId).columns[0] ? findBoard(bId).columns[0].id : null);
      $('#tile-url').value = '';
      $('#tile-title').value = '';
      $('#tile-desc').value = '';
      $('#tile-tags').value = '';
      $('#tile-note').value = '';
      boardSel.value = bId;
      fillColumnSelect(bId, editorCtx.columnId);
      $('#tile-preview').hidden = true;
      $('#tile-resolve-status').hidden = true;
    }
    openModal(modal);
    setTimeout(function () { $('#tile-url').focus(); }, 50);
  }

  function fillColumnSelect(boardId, selected) {
    var b = findBoard(boardId);
    var sel = $('#tile-column');
    sel.innerHTML = '';
    var cols = b ? (b.columns || []) : [];
    cols.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === selected) o.selected = true;
      sel.appendChild(o);
    });
    if (!cols.length) {
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '— нет колонок —';
      sel.appendChild(o0);
    }
  }

  function showTilePreview(provider, poster) {
    var prev = $('#tile-preview');
    $('#tile-preview-provider').textContent = M.providerLabel(provider);
    var img = $('#tile-preview-img');
    if (poster) {
      img.src = poster;
      img.setAttribute('data-fb', '');
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
    prev.hidden = false;
  }

  function setStatus(cls, text) {
    var status = $('#tile-resolve-status');
    status.hidden = false;
    status.className = 'resolve-status' + (cls ? ' ' + cls : '');
    status.textContent = text;
  }

  // «Определить» по ссылке
  function onTileResolve() {
    var url = $('#tile-url').value.trim();
    var btn = $('#tile-resolve');
    if (!url) {
      setStatus('err', 'Вставьте ссылку на страницу фильма.');
      return;
    }
    var info = M.parse(url);
    if (!info) {
      setStatus('err', 'Не похоже на ссылку. Примеры: kinopoisk.ru/film/326/, imdb.com/title/tt0111161/, okko.tv/movie/…');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Определяю…';
    state.resolveMeta = null;
    M.resolve(url).then(function (meta) {
      btn.disabled = false;
      btn.textContent = 'Определить';
      state.resolveMeta = meta;
      showTilePreview(meta.provider, meta.poster);

      // авто-название: если поле пустое или было автозаполнено ранее
      var titleEl = $('#tile-title');
      if (meta.title && (!titleEl.value.trim() || titleEl.dataset.auto === '1')) {
        titleEl.value = meta.title;
        titleEl.dataset.auto = '1';
      }
      if (meta.description && !$('#tile-desc').value.trim()) {
        $('#tile-desc').value = meta.description;
      }
      if (meta.resolved) {
        setStatus('ok', 'Название и описание получены' + (meta.year ? ' (' + meta.year + ')' : '') + '. Можно сохранить.');
      } else if (meta.provider === 'kinopoisk') {
        setStatus('warn', 'Кинопоиск закрывает страницы от автоматического разбора. Введите название и нажмите «Википедия» — описание и обложку подтянем оттуда.');
      } else {
        setStatus('warn', 'Название получить не удалось — введите его и нажмите «Википедия».');
      }
    });
  }

  // «Википедия»: обогатить по введённому названию
  function onTileWiki() {
    var title = $('#tile-title').value.trim();
    var btn = $('#tile-wiki');
    if (!title) {
      setStatus('warn', 'Сначала введите название фильма.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Ищу…';
    M.enrichByTitle(title).then(function (meta) {
      btn.disabled = false;
      btn.textContent = 'Википедия';
      if (!meta) {
        setStatus('err', 'В Википедии ничего не нашлось — заполните описание вручную.');
        return;
      }
      state.wikiMeta = meta;
      if (!$('#tile-title').value.trim() || $('#tile-title').dataset.auto === '1') {
        $('#tile-title').value = meta.title || title;
        $('#tile-title').dataset.auto = '1';
      }
      if (meta.description && !$('#tile-desc').value.trim()) {
        $('#tile-desc').value = meta.description;
      }
      if (meta.poster) showTilePreview('wikipedia', meta.poster);
      setStatus('ok', 'Найдено в Википедии: «' + (meta.title || title) + '»' + (meta.year ? ', ' + meta.year : '') + '.');
    });
  }

  function onTileSave() {
    var url = $('#tile-url').value.trim();
    var title = $('#tile-title').value.trim();
    if (!title) { toast('Укажите название фильма', 'warn'); return; }
    var parsed = M.parse(url || 'https://ru.wikipedia.org/wiki/' + encodeURIComponent(title));
    if (!parsed) { toast('Ссылка не распознана', 'warn'); return; }
    var bId = $('#tile-board').value;
    var colId = $('#tile-column').value;
    var b = findBoard(bId);
    if (!b || !colId) { toast('Выберите доску и колонку', 'warn'); return; }

    var tags = $('#tile-tags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var meta = state.wikiMeta || state.resolveMeta || {};

    var t;
    if (editorCtx.tileId) {
      var found = findTile(editorCtx.tileId);
      if (!found) return;
      t = found.tile;
      if (found.board.id !== bId) {
        found.board.tiles = (found.board.tiles || []).filter(function (x) { return x.id !== t.id; });
        b.tiles = b.tiles || [];
        b.tiles.push(t);
      }
    } else {
      t = { id: uid('t'), addedAt: new Date().toISOString() };
      b.tiles = b.tiles || [];
      b.tiles.push(t);
    }

    t.columnId = colId;
    t.url = parsed.url;
    t.provider = parsed.provider;
    t.title = title;
    t.poster = (state.wikiMeta && state.wikiMeta.poster) || (state.resolveMeta && state.resolveMeta.poster) || t.poster || null;
    t.description = $('#tile-desc').value.trim() || (meta.description || '') || (t.description || '');
    if (meta.year && !t.year) t.year = meta.year;
    if (!t.year) {
      var y = M.yearFromText(t.description);
      if (y) t.year = y;
    }
    t.tags = tags;
    t.note = $('#tile-note').value.trim();

    var isNew = !editorCtx.tileId;
    var label = 'доска «' + b.name + '»: ' + (isNew ? '+1 фильм — ' : 'правка — ') + t.title;
    persist(label).then(function (ok) {
      if (ok) {
        closeModal($('#tile-modal'));
        renderAll();
        if (state.view === 'kanban') renderKanban();
      }
    });
  }

  // ---------- редактор колонки ----------

  function openColumnModal(colId, boardId) {
    colCtx = { boardId: boardId || (state.board !== 'all' ? state.board : boards()[0].id), colId: colId || null };
    var b = findBoard(colCtx.boardId);
    if (!b) return;
    var c = colId ? columnOf(b, colId) : null;
    $('#column-modal-title').textContent = c ? 'Колонка «' + c.name + '»' : 'Новая колонка';
    $('#column-name').value = c ? c.name : '';
    $('#column-delete').hidden = !c;
    var pal = $('#column-palette');
    pal.innerHTML = '';
    var active = c ? c.color : PALETTE[0];
    PALETTE.forEach(function (hex) {
      var btn = document.createElement('button');
      btn.className = 'palette-swatch' + (hex === active ? ' active' : '');
      btn.style.background = hex;
      btn.setAttribute('data-hex', hex);
      pal.appendChild(btn);
    });
    openModal($('#column-modal'));
    setTimeout(function () { $('#column-name').focus(); }, 50);
  }

  function onPaletteClick(e) {
    var sw = e.target.closest('.palette-swatch');
    if (!sw) return;
    $all('.palette-swatch').forEach(function (n) { n.classList.remove('active'); });
    sw.classList.add('active');
  }

  function onColumnSave() {
    var b = findBoard(colCtx.boardId);
    if (!b) return;
    var name = $('#column-name').value.trim();
    if (!name) { toast('Введите название колонки', 'warn'); return; }
    var sw = $('#column-palette .palette-swatch.active');
    var color = sw ? sw.getAttribute('data-hex') : PALETTE[0];
    if (colCtx.colId) {
      var c = columnOf(b, colCtx.colId);
      if (c) { c.name = name; c.color = color; }
      persist('доска «' + b.name + '»: колонка «' + name + '»').then(function (ok) {
        if (ok) { closeModal($('#column-modal')); renderAll(); }
      });
    } else {
      b.columns = b.columns || [];
      b.columns.push({ id: uid('c'), name: name, color: color });
      persist('доска «' + b.name + '»: + колонка «' + name + '»').then(function (ok) {
        if (ok) { closeModal($('#column-modal')); renderAll(); }
      });
    }
  }

  // ---------- модалка доски ----------

  function openBoardModal(boardId) {
    boardCtx = { boardId: boardId || null };
    var b = boardId ? findBoard(boardId) : null;
    $('#board-modal-title').textContent = b ? 'Доска «' + b.name + '»' : 'Новая доска';
    $('#board-name').value = b ? b.name : '';
    $('#board-delete').hidden = !b;
    $('#board-save').textContent = b ? 'Сохранить' : 'Создать';
    openModal($('#board-modal'));
    setTimeout(function () { $('#board-name').focus(); }, 50);
  }

  function onBoardSave() {
    var name = $('#board-name').value.trim();
    if (!name) { toast('Введите название доски', 'warn'); return; }
    if (boardCtx.boardId) {
      var b = findBoard(boardCtx.boardId);
      if (!b) return;
      b.name = name;
      persist('доска переименована в «' + name + '»').then(function (ok) {
        if (ok) { closeModal($('#board-modal')); renderAll(); }
      });
    } else {
      var nb = {
        id: uid('b'),
        name: name,
        createdAt: new Date().toISOString(),
        columns: DEFAULT_COLUMNS.map(function (c) { return { id: uid('c'), name: c.name, color: c.color }; }),
        tiles: []
      };
      state.data.boards = boards().concat([nb]);
      state.board = nb.id;
      persist('доска «' + name + '»: создана').then(function (ok) {
        if (ok) {
          closeModal($('#board-modal'));
          renderAll();
          toast('Доска «' + name + '» создана');
        }
      });
    }
  }

  // ---------- вход / сессия ----------

  function openLoginModal() {
    var authed = !!state.user;
    $('#login-form').hidden = authed;
    $('#login-session').hidden = !authed;
    if (authed) $('#login-user').textContent = state.user;
    $('#login-error').hidden = true;
    $('#login-token').value = '';
    openModal($('#login-modal'));
    if (!authed) setTimeout(function () { $('#login-token').focus(); }, 50);
  }

  function onLoginSubmit() {
    var token = $('#login-token').value.trim();
    var errBox = $('#login-error');
    var btn = $('#login-submit');
    errBox.hidden = true;
    if (!token) {
      errBox.textContent = 'Вставьте токен.';
      errBox.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Проверяю…';
    GH.loginWithToken(token).then(function (u) {
      btn.disabled = false;
      btn.textContent = 'Войти';
      state.user = u.login;
      updateAuthUi();
      toast('Вы вошли как ' + u.login);
      closeModal($('#login-modal'));
      return loadRemoteData().then(function () { renderAll(); });
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Войти';
      errBox.textContent = err.message || 'Не удалось проверить токен';
      errBox.hidden = false;
    });
  }

  function onLogout() {
    GH.logout();
    state.user = null;
    state.remoteSha = null;
    updateAuthUi();
    closeModal($('#login-modal'));
    toast('Вы вышли. Редактирование отключено.');
    renderAll();
  }

  function updateAuthUi() {
    var authed = !!state.user;
    var body = document.body;
    body.classList.toggle('authed', authed);
    var btn = $('#auth-btn');
    btn.classList.toggle('authed', authed);
    $('#auth-label').textContent = authed ? state.user : 'Войти';
    var edit = GH.canEdit();
    $('#add-btn').hidden = !edit;
  }

  function loadRemoteData() {
    if (!state.user) return Promise.resolve();
    return GH.loadRemote().then(function (res) {
      if (res && res.data) {
        state.data = res.data;
        state.remoteSha = res.sha;
        if (state.board !== 'all' && !findBoard(state.board)) state.board = 'all';
      } else if (res && res.data === null) {
        state.remoteSha = null;
        toast('В репозитории нет data/db.js — будет создан при первом сохранении', 'warn');
      }
    }).catch(function (err) {
      toast('Не удалось загрузить данные из репозитория: ' + err.message, 'err');
    });
  }

  // ---------- обновление данных (⟳) ----------

  function onRefresh() {
    if (state.user) {
      loadRemoteData().then(function () {
        renderAll();
        toast('Данные обновлены из репозитория');
      });
      return;
    }
    var old = document.getElementById('pfb-data-script');
    if (old) old.remove();
    var s = document.createElement('script');
    s.id = 'pfb-data-script';
    s.src = CFG.dataPath + '?t=' + Date.now();
    s.onload = function () {
      state.data = window.__PFB_DATA;
      if (state.board !== 'all' && !findBoard(state.board)) state.board = 'all';
      renderAll();
      toast('Данные обновлены');
    };
    s.onerror = function () { toast('Не удалось загрузить данные', 'err'); };
    document.head.appendChild(s);
  }

  // ---------- общий рендер ----------

  function renderAll() {
    if (state.view === 'kanban') {
      $('#gallery').hidden = true;
      $('#kanban').hidden = false;
      $('#view-grid').classList.remove('active');
      $('#view-kanban').classList.add('active');
    } else {
      $('#gallery').hidden = false;
      $('#kanban').hidden = true;
      $('#view-grid').classList.add('active');
      $('#view-kanban').classList.remove('active');
    }
    renderTabs();
    buildFilterOptions();
    renderStats();
    if (state.view === 'kanban') renderKanban();
    else renderGallery();
  }

  // ---------- события ----------

  function bindEvents() {
    // вкладки досок (+ кнопка новой доски)
    $('#tabs').addEventListener('click', function (e) {
      var add = e.target.closest('.tab-add');
      if (add) { openBoardModal(null); return; }
      var tab = e.target.closest('.tab');
      if (!tab) return;
      state.board = tab.getAttribute('data-board');
      renderAll();
    });

    // поиск
    $('#search').addEventListener('input', debounce(function () {
      state.q = $('#search').value;
      $('#search-clear').hidden = !$('#search').value;
      if (state.view === 'kanban') {
        renderGallery();
        state.renderedIds = filteredTiles().map(function (e) { return e.tile.id; });
      } else renderGallery();
      renderStats();
    }, 160));
    $('#search-clear').addEventListener('click', function () {
      $('#search').value = '';
      state.q = '';
      $('#search-clear').hidden = true;
      renderGallery();
      renderStats();
    });

    // фильтры
    $('#f-provider').addEventListener('change', function () {
      state.provider = $('#f-provider').value;
      renderAll();
    });
    $('#f-tag').addEventListener('change', function () {
      state.tag = $('#f-tag').value;
      renderAll();
    });
    $('#f-sort').addEventListener('change', function () {
      state.sort = $('#f-sort').value;
      renderAll();
    });
    $('#f-reset').addEventListener('click', resetFilters);
    $('#empty-reset').addEventListener('click', resetFilters);

    // вид
    $('#view-grid').addEventListener('click', function () { setView('grid'); });
    $('#view-kanban').addEventListener('click', function () { setView('kanban'); });

    // прочие кнопки шапки
    $('#refresh-btn').addEventListener('click', onRefresh);
    $('#color-toggle').addEventListener('click', function () {
      state.color = !state.color;
      try { localStorage.setItem(COLOR_KEY, state.color ? '1' : '0'); } catch (e) { /* ignore */ }
      applyColorMode();
      renderAll();
    });
    $('#add-btn').addEventListener('click', function () { openTileModal(null, null); });
    $('#auth-btn').addEventListener('click', openLoginModal);

    // галерея
    $('#gallery').addEventListener('click', onGalleryClick);
    $('#gallery').addEventListener('error', onImgError, true);

    // канбан
    var kanban = $('#kanban');
    kanban.addEventListener('click', function (e) {
      onKanbanClick(e);
      onBoardMenuClick(e);
      var actBtn = e.target.closest('[data-act]');
      if (actBtn) onCardAction(actBtn.getAttribute('data-act'), actBtn.getAttribute('data-id'));
    });
    kanban.addEventListener('dragstart', onKanbanDragStart);
    kanban.addEventListener('dragover', onKanbanDragOver);
    kanban.addEventListener('drop', onKanbanDrop);
    kanban.addEventListener('dragend', cleanupDnd);
    kanban.addEventListener('error', onImgError, true);

    // меню
    $('#menu').addEventListener('click', onMenuClick);
    document.addEventListener('click', function (e) {
      if (!$('#menu').hidden && !e.target.closest('#menu')) closeMenu();
    });

    // закрытие модалок по [data-close]
    document.addEventListener('click', function (e) {
      var closer = e.target.closest('[data-close]');
      if (closer) {
        var m = closer.closest('.modal');
        if (m) closeModal(m);
      }
    });

    // модалка фильма
    $('#film-close').addEventListener('click', function () { closeModal($('#film-modal')); });
    $('#film-prev').addEventListener('click', function () { filmNav(-1); });
    $('#film-next').addEventListener('click', function () { filmNav(1); });

    // редактор фильма
    $('#tile-resolve').addEventListener('click', onTileResolve);
    $('#tile-wiki').addEventListener('click', onTileWiki);
    $('#tile-save').addEventListener('click', onTileSave);
    $('#tile-delete').addEventListener('click', onTileDelete);
    $('#tile-board').addEventListener('change', function () {
      fillColumnSelect($('#tile-board').value, null);
    });
    $('#tile-url').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onTileResolve(); }
    });
    $('#tile-title').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onTileWiki(); }
    });

    // редактор колонки
    $('#column-palette').addEventListener('click', onPaletteClick);
    $('#column-save').addEventListener('click', onColumnSave);
    $('#column-delete').addEventListener('click', function () {
      deleteColumn(colCtx.boardId, colCtx.colId);
    });

    // доска
    $('#board-save').addEventListener('click', onBoardSave);
    $('#board-delete').addEventListener('click', function () {
      closeModal($('#board-modal'));
      deleteBoard(boardCtx.boardId);
    });

    // вход
    $('#login-submit').addEventListener('click', onLoginSubmit);
    $('#login-token').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onLoginSubmit(); }
    });
    $('#logout-btn').addEventListener('click', onLogout);

    // пересборка masonry при изменении ширины (кол-во колонок считается в JS)
    window.addEventListener('resize', debounce(function () {
      if (state.view === 'grid') renderGallery();
    }, 200));

    // клавиатура
    document.addEventListener('keydown', function (e) {
      var filmOpen = !$('#film-modal').hidden;
      if (e.key === 'Escape') {
        if (!$('#menu').hidden) { closeMenu(); return; }
        var open = $all('.modal').filter(function (m) { return !m.hidden; });
        if (open.length) { closeModal(open[open.length - 1]); return; }
      }
      if (e.key === '/' && !filmOpen) {
        var tag = (e.target.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
          e.preventDefault();
          $('#search').focus();
        }
        return;
      }
      if (filmOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        filmNav(e.key === 'ArrowLeft' ? -1 : 1);
      }
    });
  }

  function onGalleryClick(e) {
    var actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      onCardAction(actBtn.getAttribute('data-act'), actBtn.getAttribute('data-id'));
      return;
    }
    var card = e.target.closest('.card');
    if (card) openFilm(card.getAttribute('data-id'));
  }

  function onCardAction(act, tileId) {
    if (act === 'edit') openTileModal(tileId, null);
    else if (act === 'del') deleteTile(tileId);
  }

  function onTileDelete() {
    if (!editorCtx.tileId) return;
    var found = findTile(editorCtx.tileId);
    if (!found) return;
    confirmDialog('Удалить фильм «' + (found.tile.title || 'без названия') + '»?')
      .then(function (choice) {
        if (choice !== 'yes') return;
        found.board.tiles = (found.board.tiles || []).filter(function (x) { return x.id !== editorCtx.tileId; });
        persist('доска «' + found.board.name + '»: удалено — ' + (found.tile.title || '')).then(function (ok) {
          if (ok) {
            closeModal($('#tile-modal'));
            renderAll();
          }
        });
      });
  }

  function setView(v) {
    state.view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* ignore */ }
    renderAll();
  }

  function applyColorMode() {
    document.body.classList.toggle('color', state.color);
    $('#color-toggle').title = state.color ? 'Монохромный вид' : 'Показать цвет';
    $('#color-toggle').classList.toggle('active', state.color);
  }

  // ---------- запуск ----------

  function boot() {
    bindEvents();
    state.color = localStorage.getItem(COLOR_KEY) === '1';
    applyColorMode();
    updateAuthUi();
    renderAll();

    GH.restoreSession().then(function (u) {
      if (u) {
        state.user = u.login;
        updateAuthUi();
        loadRemoteData().then(renderAll);
      }
    });
  }

  boot();
})();
