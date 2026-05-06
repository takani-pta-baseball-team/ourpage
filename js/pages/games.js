import { CONFIG } from '../config.js';
import { fetchJSON, writeJSON, writeBinary, deleteFile, ConflictError } from '../api.js';
import { renderHeader, renderNav, requireAuth, showToast, escapeHtml, formatDate, uid, todayISO } from '../app.js';
import { processImage, blobToBase64 } from '../imageutil.js';

renderHeader();
renderNav('games');

let gamesState = { games: [] };
let gamesSha = null;
let membersState = { members: [] };

requireAuth(async () => {
  await Promise.all([loadGames(), loadMembers()]);
  render();
  document.getElementById('add-game-btn').addEventListener('click', openAddDialog);
});

async function loadGames() {
  const { data, sha } = await fetchJSON(CONFIG.DATA_PATHS.games);
  gamesState = data || { games: [] };
  gamesSha = sha;
}

async function loadMembers() {
  const { data } = await fetchJSON(CONFIG.DATA_PATHS.members);
  membersState = data || { members: [] };
}

function render() {
  const list = document.getElementById('games-list');
  const games = [...gamesState.games].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (games.length === 0) {
    list.innerHTML = '<div class="empty">まだ試合が登録されていません。<br>「＋ 新規登録」から登録してください。</div>';
    return;
  }
  list.innerHTML = games.map((g) => renderGameCard(g)).join('');
  list.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openEditDialog(btn.dataset.edit));
  });
  list.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteGame(btn.dataset.delete));
  });
  list.querySelectorAll('[data-photo]').forEach((el) => {
    el.addEventListener('click', () => {
      const gameId = el.dataset.gameId;
      const idx = Number(el.dataset.photoIndex);
      const game = gamesState.games.find((x) => x.id === gameId);
      if (game) openLightbox(game.photos || [], idx, game);
    });
  });
  list.querySelectorAll('[data-stats]').forEach((btn) => {
    btn.addEventListener('click', () => openStatsDialog(btn.dataset.stats));
  });
}

function renderCardScoreboard(g) {
  const opponent = escapeHtml(g.opponent || '相手');
  if (!g.innings || g.innings.length === 0) {
    return `
      <div class="score-line">
        <span>当チーム</span>
        <span class="score-num">${g.ourScore ?? 0}</span>
        <span class="vs">-</span>
        <span class="score-num">${g.theirScore ?? 0}</span>
        <span>${opponent}</span>
      </div>
    `;
  }
  const isHome = !!g.isHome;
  const topName = isHome ? opponent : '当ﾁｰﾑ';
  const bottomName = isHome ? '当ﾁｰﾑ' : opponent;
  const headerCells = g.innings.map((_, i) => `<th>${i + 1}</th>`).join('');
  const topCells = g.innings.map((inn) => `<td>${inn.top ?? 0}</td>`).join('');
  const bottomCells = g.innings.map((inn) => `<td>${inn.bottom ?? 0}</td>`).join('');
  const totTop = g.innings.reduce((s, i) => s + (i.top || 0), 0);
  const totBottom = g.innings.reduce((s, i) => s + (i.bottom || 0), 0);
  return `
    <div class="scoreboard-display">
      <table>
        <thead>
          <tr><th></th>${headerCells}<th>計</th></tr>
        </thead>
        <tbody>
          <tr class="${isHome ? '' : 'us-row'}">
            <td class="team-name">${topName}</td>${topCells}<td class="total">${totTop}</td>
          </tr>
          <tr class="${isHome ? 'us-row' : ''}">
            <td class="team-name">${bottomName}</td>${bottomCells}<td class="total">${totBottom}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// ========== 選手成績 ==========
const BATTING_FIELDS = [
  { key: 'singles', label: 'ヒット' },
  { key: 'doubles', label: '二塁打' },
  { key: 'triples', label: '三塁打' },
  { key: 'homeRuns', label: '本塁打' },
  { key: 'rbis', label: '打点' },
  { key: 'strikeouts', label: '三振' },
  { key: 'flyOuts', label: 'フライアウト' },
  { key: 'groundOuts', label: 'ゴロアウト' },
  { key: 'reachedOnError', label: 'エラー(出塁)' },
];

const PITCHING_COUNTER_FIELDS = [
  { key: 'strikeouts', label: '奪三振' },
  { key: 'walks', label: '四球' },
  { key: 'hitBatters', label: '死球' },
  { key: 'errors', label: 'エラー' },
  { key: 'hitsAllowed', label: '被安打' },
];

function emptyPlayerStats() {
  return {
    batting: Object.fromEntries(BATTING_FIELDS.map((f) => [f.key, 0])),
    pitching: {
      decision: null,
      ...Object.fromEntries(PITCHING_COUNTER_FIELDS.map((f) => [f.key, 0])),
    },
  };
}

function isStatsEmpty(s) {
  if (!s) return true;
  const b = s.batting || {};
  const p = s.pitching || {};
  const battingEmpty = BATTING_FIELDS.every((f) => !(b[f.key] > 0));
  const pitchingEmpty = !p.decision && PITCHING_COUNTER_FIELDS.every((f) => !(p[f.key] > 0));
  return battingEmpty && pitchingEmpty;
}

function summaryText(stats) {
  const b = stats.batting;
  const hits = (b.singles || 0) + (b.doubles || 0) + (b.triples || 0) + (b.homeRuns || 0);
  const pa = hits + (b.strikeouts || 0) + (b.flyOuts || 0) + (b.groundOuts || 0) + (b.reachedOnError || 0);
  const dec = stats.pitching.decision === 'win' ? '勝' : stats.pitching.decision === 'loss' ? '負' : '';
  if (pa === 0 && !dec && PITCHING_COUNTER_FIELDS.every((f) => !(stats.pitching[f.key] > 0))) {
    return '<span style="color:var(--color-text-muted)">未入力</span>';
  }
  const parts = [];
  if (pa > 0) parts.push(`${pa}打席 ${hits}安打`);
  if (b.rbis > 0) parts.push(`打点${b.rbis}`);
  if (dec) parts.push(`投手:${dec}`);
  return parts.join(' / ');
}

function renderStatRow(cat, field, value) {
  return `
    <div class="stat-row" data-cat="${cat}" data-key="${field.key}">
      <span class="stat-label">${field.label}</span>
      <div class="stat-controls">
        <button type="button" class="stat-btn" data-op="dec" aria-label="減らす">−</button>
        <span class="stat-value">${value || 0}</span>
        <button type="button" class="stat-btn stat-btn-plus" data-op="inc" aria-label="増やす">+</button>
      </div>
    </div>
  `;
}

function renderStatsMemberCard(member, stats) {
  return `
    <div class="stats-member-card" data-member-id="${member.id}">
      <button type="button" class="stats-member-header">
        <span class="stats-member-name">${member.number != null ? `<span class="num-badge">#${member.number}</span> ` : ''}${escapeHtml(member.name)}</span>
        <span class="stats-member-summary">${summaryText(stats)}</span>
        <span class="stats-member-toggle">▼</span>
      </button>
      <div class="stats-member-body">
        <div class="stats-section">
          <h5>打撃</h5>
          ${BATTING_FIELDS.map((f) => renderStatRow('batting', f, stats.batting[f.key])).join('')}
        </div>
        <div class="stats-section">
          <h5>投手</h5>
          <div class="stat-row" data-cat="pitching" data-key="decision">
            <span class="stat-label">勝/負</span>
            <div class="decision-buttons">
              <button type="button" class="dec-btn ${stats.pitching.decision === 'win' ? 'active-win' : ''}" data-dec="win">勝</button>
              <button type="button" class="dec-btn ${stats.pitching.decision === 'loss' ? 'active-loss' : ''}" data-dec="loss">負</button>
              <button type="button" class="dec-btn ${!stats.pitching.decision ? 'active-none' : ''}" data-dec="">-</button>
            </div>
          </div>
          ${PITCHING_COUNTER_FIELDS.map((f) => renderStatRow('pitching', f, stats.pitching[f.key])).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button type="button" class="btn btn-sm stats-clear-btn" style="flex:1">この選手をクリア</button>
        </div>
      </div>
    </div>
  `;
}

function openStatsDialog(gameId) {
  const game = gamesState.games.find((x) => x.id === gameId);
  if (!game) return;
  if (membersState.members.length === 0) {
    showToast('先にメンバーを登録してください', 'error');
    return;
  }

  const working = {};
  for (const m of membersState.members) {
    const existing = (game.playerStats && game.playerStats[m.id]) || null;
    working[m.id] = existing
      ? { batting: { ...emptyPlayerStats().batting, ...existing.batting }, pitching: { ...emptyPlayerStats().pitching, ...existing.pitching } }
      : emptyPlayerStats();
  }

  const sortedMembers = [...membersState.members].sort((a, b) => {
    const na = a.number ?? 999, nb = b.number ?? 999;
    if (na !== nb) return na - nb;
    return (a.name || '').localeCompare(b.name || '', 'ja');
  });

  const html = `
    <div class="modal-backdrop open" id="stats-modal">
      <div class="modal stats-modal">
        <h3 style="margin:0 0 4px">📊 選手成績</h3>
        <div class="card-meta" style="margin-bottom:12px">
          ${escapeHtml(formatDate(game.date))} vs ${escapeHtml(game.opponent || '')}
        </div>
        <p style="font-size:.8rem;color:var(--color-text-muted);margin:0 0 8px">
          選手をタップして展開 → +/- ボタンで入力 → 最後に「保存」
        </p>
        <div class="stats-list" id="stats-list">
          ${sortedMembers.map((m) => renderStatsMemberCard(m, working[m.id])).join('')}
        </div>
        <div class="modal-actions" style="margin-top:12px">
          <button type="button" class="btn" id="stats-cancel">キャンセル</button>
          <button type="button" class="btn btn-primary" id="stats-save">保存</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const modal = document.getElementById('stats-modal');
  const list = document.getElementById('stats-list');

  function updateSummary(memberId) {
    const card = list.querySelector(`.stats-member-card[data-member-id="${memberId}"]`);
    if (card) card.querySelector('.stats-member-summary').innerHTML = summaryText(working[memberId]);
  }

  // 展開トグル
  list.querySelectorAll('.stats-member-header').forEach((header) => {
    header.addEventListener('click', () => {
      header.closest('.stats-member-card').classList.toggle('expanded');
    });
  });

  // +/- ボタン
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.stat-btn');
    if (!btn) return;
    const row = btn.closest('.stat-row');
    const card = btn.closest('.stats-member-card');
    const memberId = card.dataset.memberId;
    const cat = row.dataset.cat;
    const key = row.dataset.key;
    const cur = working[memberId][cat][key] || 0;
    const next = btn.dataset.op === 'inc' ? cur + 1 : Math.max(0, cur - 1);
    working[memberId][cat][key] = next;
    row.querySelector('.stat-value').textContent = next;
    updateSummary(memberId);
  });

  // 勝/負ボタン
  list.querySelectorAll('.decision-buttons').forEach((group) => {
    group.querySelectorAll('.dec-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.stats-member-card');
        const memberId = card.dataset.memberId;
        const val = btn.dataset.dec || null;
        working[memberId].pitching.decision = val;
        group.querySelectorAll('.dec-btn').forEach((b) => {
          b.classList.remove('active-win', 'active-loss', 'active-none');
        });
        if (val === 'win') btn.classList.add('active-win');
        else if (val === 'loss') btn.classList.add('active-loss');
        else btn.classList.add('active-none');
        updateSummary(memberId);
      });
    });
  });

  // クリアボタン
  list.querySelectorAll('.stats-clear-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.stats-member-card');
      const memberId = card.dataset.memberId;
      if (!confirm('この選手の入力をすべてクリアしますか？')) return;
      working[memberId] = emptyPlayerStats();
      // 表示を更新
      card.querySelectorAll('.stat-row').forEach((row) => {
        const cat = row.dataset.cat, key = row.dataset.key;
        if (key === 'decision') {
          row.querySelectorAll('.dec-btn').forEach((b) => {
            b.classList.remove('active-win', 'active-loss', 'active-none');
            if (!b.dataset.dec) b.classList.add('active-none');
          });
        } else {
          row.querySelector('.stat-value').textContent = '0';
        }
      });
      updateSummary(memberId);
    });
  });

  document.getElementById('stats-cancel').addEventListener('click', () => modal.remove());

  document.getElementById('stats-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('stats-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    try {
      const playerStats = {};
      for (const memberId of Object.keys(working)) {
        if (!isStatsEmpty(working[memberId])) {
          playerStats[memberId] = working[memberId];
        }
      }
      const updatedGame = { ...game, playerStats };
      const next = {
        ...gamesState,
        games: gamesState.games.map((x) => (x.id === game.id ? updatedGame : x)),
      };
      gamesSha = await writeJSON(
        CONFIG.DATA_PATHS.games,
        next,
        gamesSha,
        `update player stats for game ${game.date} vs ${game.opponent}`
      );
      gamesState = next;
      modal.remove();
      render();
      showToast('選手成績を保存しました', 'success');
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
      if (err instanceof ConflictError) {
        showToast(err.message, 'error');
      } else {
        showToast('保存に失敗しました: ' + err.message, 'error');
      }
    }
  });
}

function renderGameCard(g) {
  const result = g.result || (g.ourScore > g.theirScore ? 'win' : g.ourScore < g.theirScore ? 'lose' : 'draw');
  const badge =
    result === 'win'
      ? '<span class="badge badge-win">勝</span>'
      : result === 'lose'
      ? '<span class="badge badge-lose">負</span>'
      : '<span class="badge badge-draw">分</span>';
  const mvpName = g.mvpId
    ? membersState.members.find((m) => m.id === g.mvpId)?.name
    : null;
  const photos = g.photos || [];
  const statsCount = g.playerStats ? Object.keys(g.playerStats).length : 0;
  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="card-meta">${escapeHtml(formatDate(g.date))} ${badge}</div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" data-edit="${g.id}">編集</button>
          <button class="btn btn-sm btn-danger" data-delete="${g.id}">削除</button>
        </div>
      </div>
      ${renderCardScoreboard(g)}
      ${g.location ? `<div class="card-meta">📍 ${escapeHtml(g.location)}</div>` : ''}
      ${mvpName ? `<div class="card-meta">🏆 MVP: ${escapeHtml(mvpName)}</div>` : ''}
      ${g.highlights ? `<p style="margin:8px 0 0;font-size:.9rem;white-space:pre-wrap">${escapeHtml(g.highlights)}</p>` : ''}
      ${photos.length > 0 ? `
        <div class="photo-grid">
          ${photos.map((p, i) => `
            <div class="photo-thumb" data-photo data-game-id="${g.id}" data-photo-index="${i}">
              <img src="${escapeHtml(p)}" alt="" loading="lazy" />
            </div>
          `).join('')}
        </div>
      ` : ''}
      <button class="btn btn-block btn-sm" data-stats="${g.id}" style="margin-top:10px">
        📊 選手成績を入力${statsCount > 0 ? ` (${statsCount}名)` : ''}
      </button>
    </div>
  `;
}

function openAddDialog() {
  openDialog({
    id: '',
    date: todayISO(),
    opponent: '',
    ourScore: 0,
    theirScore: 0,
    isHome: false,
    innings: [],
    location: '',
    mvpId: '',
    highlights: '',
    photos: [],
  }, false);
}

function openEditDialog(id) {
  const g = gamesState.games.find((x) => x.id === id);
  if (!g) return;
  openDialog({ ...g, photos: [...(g.photos || [])], innings: [...(g.innings || [])] }, true);
}

function openDialog(g, isEdit) {
  const memberOptions = membersState.members
    .map((m) => `<option value="${m.id}" ${m.id === g.mvpId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`)
    .join('');

  const existingPhotos = [...(g.photos || [])];
  const removedPhotos = [];
  const newPhotos = [];

  // イニング別スコアの初期状態
  let innings;
  if (g.innings && g.innings.length > 0) {
    innings = g.innings.map((i) => ({ top: Number(i.top || 0), bottom: Number(i.bottom || 0) }));
  } else if ((g.ourScore || 0) > 0 || (g.theirScore || 0) > 0) {
    // 既存データの移行: 1回に総得点を入れる（その他は0）
    innings = Array.from({ length: 7 }, () => ({ top: 0, bottom: 0 }));
    if (!g.isHome) innings[0] = { top: g.ourScore || 0, bottom: g.theirScore || 0 };
    else innings[0] = { top: g.theirScore || 0, bottom: g.ourScore || 0 };
  } else {
    innings = Array.from({ length: 7 }, () => ({ top: 0, bottom: 0 }));
  }
  let isHome = !!g.isHome;

  const html = `
    <div class="modal-backdrop open" id="game-modal" role="dialog" aria-modal="true">
      <div class="modal">
        <h3>${isEdit ? '試合を編集' : '新しい試合を登録'}</h3>
        <form id="game-form">
          <div class="field">
            <label class="field-label">日付</label>
            <input class="field-input" type="date" name="date" value="${g.date}" required />
          </div>
          <div class="field">
            <label class="field-label">対戦相手</label>
            <input class="field-input" type="text" name="opponent" value="${escapeHtml(g.opponent)}" required />
          </div>
          <div class="field">
            <label class="field-label">スコア（イニング別）</label>
            <div class="home-toggle">
              <span style="font-size:.8rem;color:var(--color-text-muted);margin-right:8px">当チームは</span>
              <button type="button" class="ht-btn" data-home="false">先攻 (表)</button>
              <button type="button" class="ht-btn" data-home="true">後攻 (裏)</button>
            </div>
            <div class="scoreboard-wrapper">
              <div id="scoreboard"></div>
            </div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <button type="button" class="btn btn-sm" id="add-inning">＋ 回</button>
              <button type="button" class="btn btn-sm" id="rem-inning">− 回</button>
            </div>
          </div>
          <div class="field">
            <label class="field-label">場所</label>
            <input class="field-input" type="text" name="location" value="${escapeHtml(g.location)}" placeholder="例: 高井戸第二小学校 校庭" />
          </div>
          <div class="field">
            <label class="field-label">MVP</label>
            <select class="field-select" name="mvpId">
              <option value="">-- 選択しない --</option>
              ${memberOptions}
            </select>
          </div>
          <div class="field">
            <label class="field-label">ハイライト・コメント</label>
            <textarea class="field-textarea" name="highlights" placeholder="活躍した選手や試合のポイント">${escapeHtml(g.highlights)}</textarea>
          </div>

          <div class="field">
            <label class="field-label">写真</label>
            <div id="photo-area">
              <div id="existing-photos" class="photo-grid-edit"></div>
              <div id="new-photos" class="photo-grid-edit"></div>
            </div>
            <input type="file" id="photo-input" accept="image/*" multiple style="display:none" />
            <button type="button" class="btn btn-block btn-sm" id="photo-add-btn" style="margin-top:8px">📷 写真を追加</button>
            <p style="font-size:.75rem;color:var(--color-text-muted);margin:6px 0 0">
              ※ 自動で1280pxにリサイズされます。位置情報(GPS)も削除されます。
            </p>
          </div>

          <div id="upload-progress" style="display:none;margin:12px 0;font-size:.85rem;color:var(--color-text-muted);text-align:center"></div>

          <div class="modal-actions">
            <button type="button" class="btn" id="game-cancel">キャンセル</button>
            <button type="submit" class="btn btn-primary" id="game-submit">${isEdit ? '更新' : '登録'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const modal = document.getElementById('game-modal');
  const form = document.getElementById('game-form');
  const submitBtn = document.getElementById('game-submit');
  const photoInput = document.getElementById('photo-input');
  const photoAddBtn = document.getElementById('photo-add-btn');
  const existingEl = document.getElementById('existing-photos');
  const newEl = document.getElementById('new-photos');
  const progressEl = document.getElementById('upload-progress');

  function renderExisting() {
    existingEl.innerHTML = existingPhotos
      .filter((p) => !removedPhotos.includes(p))
      .map((p) => `
        <div class="photo-edit-thumb">
          <img src="${escapeHtml(p)}" alt="" loading="lazy" />
          <button type="button" class="photo-remove-btn" data-remove-existing="${escapeHtml(p)}" title="削除">×</button>
        </div>
      `).join('');
    existingEl.querySelectorAll('[data-remove-existing]').forEach((btn) => {
      btn.addEventListener('click', () => {
        removedPhotos.push(btn.dataset.removeExisting);
        renderExisting();
      });
    });
  }

  function renderNew() {
    newEl.innerHTML = newPhotos.map((entry, i) => `
      <div class="photo-edit-thumb">
        <img src="${entry.previewUrl}" alt="" />
        <button type="button" class="photo-remove-btn" data-remove-new="${i}" title="削除">×</button>
      </div>
    `).join('');
    newEl.querySelectorAll('[data-remove-new]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.removeNew);
        URL.revokeObjectURL(newPhotos[i].previewUrl);
        newPhotos.splice(i, 1);
        renderNew();
      });
    });
  }

  renderExisting();
  renderNew();

  // ----- イニング別スコア -----
  function renderScoreboard() {
    const sb = document.getElementById('scoreboard');
    const headerCells = innings.map((_, i) => `<th>${i + 1}</th>`).join('');
    const topName = isHome ? '相手' : '当ﾁｰﾑ';
    const bottomName = isHome ? '当ﾁｰﾑ' : '相手';
    const topCells = innings.map((inn, i) => `<td><input type="number" min="0" inputmode="numeric" class="inning-cell" data-pos="top" data-i="${i}" value="${inn.top}"></td>`).join('');
    const bottomCells = innings.map((inn, i) => `<td><input type="number" min="0" inputmode="numeric" class="inning-cell" data-pos="bottom" data-i="${i}" value="${inn.bottom}"></td>`).join('');
    const totTop = innings.reduce((s, i) => s + (i.top || 0), 0);
    const totBottom = innings.reduce((s, i) => s + (i.bottom || 0), 0);
    sb.innerHTML = `
      <table class="scoreboard">
        <thead>
          <tr><th></th>${headerCells}<th>計</th></tr>
        </thead>
        <tbody>
          <tr class="${isHome ? '' : 'us-row'}">
            <td>${topName}</td>${topCells}<td class="total" id="total-top">${totTop}</td>
          </tr>
          <tr class="${isHome ? 'us-row' : ''}">
            <td>${bottomName}</td>${bottomCells}<td class="total" id="total-bottom">${totBottom}</td>
          </tr>
        </tbody>
      </table>
    `;
    sb.querySelectorAll('.inning-cell').forEach((input) => {
      input.addEventListener('input', () => {
        const pos = input.dataset.pos;
        const i = Number(input.dataset.i);
        innings[i][pos] = Math.max(0, Number(input.value) || 0);
        document.getElementById('total-top').textContent = innings.reduce((s, x) => s + x.top, 0);
        document.getElementById('total-bottom').textContent = innings.reduce((s, x) => s + x.bottom, 0);
      });
      input.addEventListener('focus', () => input.select());
    });
  }
  renderScoreboard();

  modal.querySelectorAll('.ht-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.home === String(isHome));
    btn.addEventListener('click', () => {
      isHome = btn.dataset.home === 'true';
      modal.querySelectorAll('.ht-btn').forEach((b) => b.classList.toggle('active', b.dataset.home === String(isHome)));
      renderScoreboard();
    });
  });
  document.getElementById('add-inning').addEventListener('click', () => {
    if (innings.length >= 12) return;
    innings.push({ top: 0, bottom: 0 });
    renderScoreboard();
  });
  document.getElementById('rem-inning').addEventListener('click', () => {
    if (innings.length <= 1) return;
    innings.pop();
    renderScoreboard();
  });

  photoAddBtn.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', () => {
    for (const file of photoInput.files) {
      newPhotos.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    photoInput.value = '';
    renderNew();
  });

  document.getElementById('game-cancel').addEventListener('click', () => {
    newPhotos.forEach((n) => URL.revokeObjectURL(n.previewUrl));
    modal.remove();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const totTop = innings.reduce((s, i) => s + (i.top || 0), 0);
    const totBottom = innings.reduce((s, i) => s + (i.bottom || 0), 0);
    const ourScore = isHome ? totBottom : totTop;
    const theirScore = isHome ? totTop : totBottom;
    const gameId = g.id || uid('g');

    submitBtn.disabled = true;
    photoAddBtn.disabled = true;

    const uploadedPaths = [];
    try {
      // 1. アップロード新規写真
      for (let i = 0; i < newPhotos.length; i++) {
        progressEl.style.display = 'block';
        progressEl.textContent = `写真をアップロード中... ${i + 1}/${newPhotos.length}`;
        const blob = await processImage(newPhotos[i].file);
        const base64 = await blobToBase64(blob);
        const ts = Date.now() + i;
        const path = `images/games/${gameId}/${ts}.jpg`;
        await writeBinary(path, base64, `add photo for game ${gameId}`);
        uploadedPaths.push(path);
      }

      // 2. 削除する既存写真をAPIで削除
      for (let i = 0; i < removedPhotos.length; i++) {
        progressEl.style.display = 'block';
        progressEl.textContent = `写真を削除中... ${i + 1}/${removedPhotos.length}`;
        try {
          await deleteFile(removedPhotos[i], null, `remove photo from game ${gameId}`);
        } catch (err) {
          console.warn('photo delete failed', err);
        }
      }

      // 3. games.json 更新
      progressEl.textContent = '保存中...';
      submitBtn.textContent = '保存中...';
      const finalPhotos = [
        ...existingPhotos.filter((p) => !removedPhotos.includes(p)),
        ...uploadedPaths,
      ];
      const newGame = {
        id: gameId,
        date: fd.get('date'),
        opponent: fd.get('opponent').toString().trim(),
        ourScore,
        theirScore,
        result: ourScore > theirScore ? 'win' : ourScore < theirScore ? 'lose' : 'draw',
        isHome,
        innings: innings.map((i) => ({ top: i.top || 0, bottom: i.bottom || 0 })),
        location: fd.get('location').toString().trim(),
        mvpId: fd.get('mvpId').toString() || null,
        highlights: fd.get('highlights').toString().trim(),
        photos: finalPhotos,
        playerStats: g.playerStats || {},
      };

      const next = { ...gamesState };
      if (isEdit) {
        next.games = next.games.map((x) => (x.id === newGame.id ? newGame : x));
      } else {
        next.games = [...next.games, newGame];
      }
      gamesSha = await writeJSON(
        CONFIG.DATA_PATHS.games,
        next,
        gamesSha,
        isEdit ? `update game ${newGame.date} vs ${newGame.opponent}` : `add game ${newGame.date} vs ${newGame.opponent}`
      );
      gamesState = next;
      newPhotos.forEach((n) => URL.revokeObjectURL(n.previewUrl));
      modal.remove();
      render();
      showToast('保存しました', 'success');
    } catch (err) {
      submitBtn.disabled = false;
      photoAddBtn.disabled = false;
      submitBtn.textContent = isEdit ? '更新' : '登録';
      progressEl.style.display = 'none';
      if (err instanceof ConflictError) {
        showToast(err.message, 'error');
      } else {
        showToast('保存に失敗しました: ' + err.message, 'error');
      }
    }
  });
}

async function deleteGame(id) {
  const g = gamesState.games.find((x) => x.id === id);
  if (!g) return;
  const photoCount = (g.photos || []).length;
  const confirmMsg = photoCount > 0
    ? `${formatDate(g.date)} ${g.opponent} 戦を削除しますか？\n（写真 ${photoCount} 枚も一緒に削除されます）`
    : `${formatDate(g.date)} ${g.opponent} 戦を削除しますか？`;
  if (!confirm(confirmMsg)) return;
  try {
    // 写真を削除
    for (const path of g.photos || []) {
      try {
        await deleteFile(path, null, `delete photo (game removed)`);
      } catch (err) {
        console.warn('photo delete failed', err);
      }
    }
    const next = { ...gamesState, games: gamesState.games.filter((x) => x.id !== id) };
    gamesSha = await writeJSON(
      CONFIG.DATA_PATHS.games,
      next,
      gamesSha,
      `delete game ${g.date} vs ${g.opponent}`
    );
    gamesState = next;
    render();
    showToast('削除しました', 'success');
  } catch (err) {
    if (err instanceof ConflictError) {
      showToast(err.message, 'error');
    } else {
      showToast('削除に失敗しました: ' + err.message, 'error');
    }
  }
}

// ========== Lightbox ==========
function openLightbox(photos, startIdx, game) {
  if (!photos || photos.length === 0) return;
  let idx = startIdx;
  const html = `
    <div class="lightbox open" id="lightbox" role="dialog" aria-modal="true">
      <button class="lightbox-close" id="lb-close" aria-label="閉じる">×</button>
      <button class="lightbox-prev" id="lb-prev" aria-label="前へ">‹</button>
      <button class="lightbox-next" id="lb-next" aria-label="次へ">›</button>
      <img class="lightbox-img" id="lb-img" src="${escapeHtml(photos[idx])}" alt="" />
      <div class="lightbox-caption" id="lb-caption"></div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  const cap = document.getElementById('lb-caption');
  const update = () => {
    img.src = photos[idx];
    cap.textContent = `${formatDate(game.date)} vs ${game.opponent} (${idx + 1}/${photos.length})`;
  };
  update();
  document.getElementById('lb-close').addEventListener('click', close);
  document.getElementById('lb-prev').addEventListener('click', () => {
    idx = (idx - 1 + photos.length) % photos.length;
    update();
  });
  document.getElementById('lb-next').addEventListener('click', () => {
    idx = (idx + 1) % photos.length;
    update();
  });
  lb.addEventListener('click', (e) => {
    if (e.target === lb) close();
  });
  function close() { lb.remove(); }
}
