import { CONFIG } from '../config.js';
import { fetchJSON, writeJSON, writeBinary, deleteFile, ConflictError } from '../api.js';
import { renderHeader, renderNav, requireAuth, showToast, escapeHtml, formatDate, uid, todayISO } from '../app.js';
import { processImage, blobToBase64 } from '../imageutil.js';
import {
  RESULT_TYPES,
  isOut,
  resultLabel,
  resultShort,
  computeNextInning,
  outsInInning,
  runsInInning,
  deriveInningsFromPlays,
} from '../plays.js';

renderHeader();
renderNav('games');

let gamesState = { games: [] };
let gamesSha = null;
let membersState = { members: [] };
let eventsState = { events: [] };
let eventsSha = null;
let attendanceState = { attendance: {} };

requireAuth(async () => {
  await Promise.all([loadGames(), loadMembers(), loadEvents(), loadAttendance()]);
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

async function loadEvents() {
  const { data, sha } = await fetchJSON(CONFIG.DATA_PATHS.events);
  eventsState = data || { events: [] };
  eventsSha = sha;
}

async function loadAttendance() {
  const { data } = await fetchJSON(CONFIG.DATA_PATHS.attendance);
  attendanceState = data || { attendance: {} };
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
  list.querySelectorAll('[data-plays]').forEach((btn) => {
    btn.addEventListener('click', () => openPlaysDialog(btn.dataset.plays));
  });
}

function renderCardScoreboard(g) {
  const opponent = escapeHtml(g.opponent || '相手');
  // 打席記録があれば自動で集計したイニングを使う
  const derivedInnings = deriveInningsFromPlays(
    g.ourPlays,
    g.oppPlays,
    !!g.isHome,
    g.oursRunsAdj,
    g.oppsRunsAdj,
  );
  const innings = derivedInnings && derivedInnings.length > 0
    ? derivedInnings
    : g.innings;
  if (!innings || innings.length === 0) {
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
  const headerCells = innings.map((_, i) => `<th>${i + 1}</th>`).join('');
  const topCells = innings.map((inn) => `<td>${inn.top ?? 0}</td>`).join('');
  const bottomCells = innings.map((inn) => `<td>${inn.bottom ?? 0}</td>`).join('');
  const totTop = innings.reduce((s, i) => s + (i.top || 0), 0);
  const totBottom = innings.reduce((s, i) => s + (i.bottom || 0), 0);
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
      ${derivedInnings ? '<div style="font-size:.7rem;color:var(--color-text-muted);text-align:right;margin-top:2px">📝 打席記録から自動計算</div>' : ''}
    </div>
  `;
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
  const hasPlays = (g.ourPlays || []).length > 0 || (g.oppPlays || []).length > 0;
  const finalizedBadge = g.finalized
    ? '<span class="badge" style="background:var(--color-success);color:#fff;margin-left:4px">🏁 確定</span>'
    : (hasPlays ? '<span class="badge" style="background:#fff3cd;color:#5c4400;margin-left:4px">未確定</span>' : '');
  // リンクされた予定があれば、出席者数を表示
  let eventInfo = '';
  if (g.eventId) {
    const linkedEvent = eventsState.events.find((e) => e.id === g.eventId);
    if (linkedEvent) {
      const att = attendanceState.attendance[g.eventId] || {};
      const yesCount = Object.values(att).filter((s) => s === 'yes').length;
      eventInfo = `<div class="card-meta">📅 予定とリンク中（出席 ${yesCount}名）</div>`;
    }
  }
  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="card-meta">${escapeHtml(formatDate(g.date))} ${badge}${finalizedBadge}</div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" data-edit="${g.id}">編集</button>
          <button class="btn btn-sm btn-danger" data-delete="${g.id}">削除</button>
        </div>
      </div>
      ${renderCardScoreboard(g)}
      ${eventInfo}
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
      <button class="btn btn-block btn-sm" data-plays="${g.id}" style="margin-top:10px">
        📝 打席記録${(g.ourPlays || []).length > 0 ? ` (${(g.ourPlays || []).length}打席)` : ''}
      </button>
    </div>
  `;
}

// 「試合」扱いの種別（旧データの '試合' も含めて互換維持）
const GAME_EVENT_TYPES = ['試合', '分区試合', 'P協試合'];

function openAddDialog() {
  // 区分が「試合」で、まだ試合にリンクされていない予定があれば、まず予定選択ピッカーを開く
  const linkableEvents = eventsState.events
    .filter((e) => GAME_EVENT_TYPES.includes(e.type) && !e.gameId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (linkableEvents.length > 0) {
    openEventPicker(linkableEvents);
  } else {
    openBlankDialog();
  }
}

function openBlankDialog(prefill = {}) {
  openDialog({
    id: '',
    date: prefill.date || todayISO(),
    opponent: '',
    ourScore: 0,
    theirScore: 0,
    isHome: false,
    innings: [],
    location: prefill.location || '',
    mvpId: '',
    highlights: '',
    photos: [],
    eventId: prefill.eventId || null,
  }, false);
}

function openEventPicker(events) {
  const html = `
    <div class="modal-backdrop open" id="event-picker">
      <div class="modal" style="max-width:500px">
        <h3>📅 予定（試合）から登録</h3>
        <p style="font-size:.85rem;color:var(--color-text-muted);margin:0 0 12px">
          試合区分の予定が ${events.length} 件あります。試合スコアを登録する予定を選んでください。
        </p>
        <div style="max-height:50vh;overflow:auto;display:flex;flex-direction:column;gap:6px">
          ${events.map((e) => `
            <button type="button" class="btn" style="text-align:left;padding:10px 12px;height:auto;display:block" data-event="${e.id}">
              <div style="font-weight:600">${escapeHtml(formatDate(e.date))}${e.startTime ? ` ${escapeHtml(e.startTime)}` : ''}${e.endTime ? `〜${escapeHtml(e.endTime)}` : ''}</div>
              ${e.location ? `<div style="font-size:.8rem;color:var(--color-text-muted);margin-top:2px">📍 ${escapeHtml(e.location)}</div>` : ''}
              ${e.description ? `<div style="font-size:.8rem;color:var(--color-text-muted);margin-top:2px;white-space:pre-wrap">${escapeHtml(e.description)}</div>` : ''}
            </button>
          `).join('')}
        </div>
        <div class="modal-actions" style="margin-top:12px">
          <button type="button" class="btn" id="event-picker-blank">予定なしで作成</button>
          <button type="button" class="btn btn-primary" id="event-picker-cancel">キャンセル</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  const modal = document.getElementById('event-picker');
  modal.querySelectorAll('[data-event]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ev = events.find((e) => e.id === btn.dataset.event);
      modal.remove();
      openBlankDialog({
        date: ev.date,
        location: ev.location,
        eventId: ev.id,
      });
    });
  });
  document.getElementById('event-picker-blank').addEventListener('click', () => {
    modal.remove();
    openBlankDialog();
  });
  document.getElementById('event-picker-cancel').addEventListener('click', () => modal.remove());
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
  let finalized = !!g.finalized;

  // 先攻/後攻フラグは打席記録モーダルの[打順]タブで設定する

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

        ${isEdit ? `
          <div class="field" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--color-border)">
            <label class="field-label">試合終了 / スコア確定</label>
            <div id="finalize-bar"></div>
            <p style="font-size:.75rem;color:var(--color-text-muted);margin:6px 0 0">
              ※ ボタンをタップすると保存して画面を閉じます。<br>
              ※ 確定するとカードに「🏁 確定」バッジが付き、打席記録の編集ができなくなります（後から解除可能）。
            </p>
          </div>
        ` : ''}
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

  // 試合終了 / スコア確定トグル（編集時のみ）
  // ボタンタップで「確定状態を切替 → フォーム送信 → 自動保存 → モーダル閉じる」
  function renderFinalizeBar() {
    const bar = document.getElementById('finalize-bar');
    if (!bar) return;
    bar.innerHTML = finalized
      ? `<button type="button" class="btn btn-block" id="unfinalize-btn" style="background:#fffbe6;border-color:#f0d160;color:#5c4400;font-weight:600">
           ✓ スコア確定済み — タップで再編集（確定解除）
         </button>`
      : `<button type="button" class="btn btn-block btn-accent" id="finalize-btn" style="font-weight:700;font-size:1rem;padding:14px;color:#fff">
           🏁 試合終了 / スコア確定
         </button>`;
    if (finalized) {
      document.getElementById('unfinalize-btn').addEventListener('click', () => {
        if (!confirm('確定を解除して再編集モードに戻しますか？\n（保存して閉じます）')) return;
        finalized = false;
        form.requestSubmit();
      });
    } else {
      document.getElementById('finalize-btn').addEventListener('click', () => {
        if (!confirm('試合を終了してスコアを確定しますか？\n（保存して閉じます。後で解除も可能です）')) return;
        finalized = true;
        form.requestSubmit();
      });
    }
  }
  renderFinalizeBar();

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
    // スコアは打席記録から自動算出される。新規/編集で打席が無い間は g の値（0）を保持。
    const ourScore = g.ourScore || 0;
    const theirScore = g.theirScore || 0;
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
      // 既存のフィールド (oppPlays, ourPlays, ourLineup, isHome, innings,
      // playerStats など) を漏れなく保持するため、まず g を展開してからフォーム入力値で上書きする
      const newGame = {
        ...g,
        id: gameId,
        date: fd.get('date'),
        opponent: fd.get('opponent').toString().trim(),
        location: fd.get('location').toString().trim(),
        mvpId: fd.get('mvpId').toString() || null,
        highlights: fd.get('highlights').toString().trim(),
        photos: finalPhotos,
        finalized,
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

      // 新規作成かつ eventId が設定されている場合、予定の gameId を更新（双方向リンク）
      if (!isEdit && newGame.eventId) {
        const eventIdx = eventsState.events.findIndex((e) => e.id === newGame.eventId);
        if (eventIdx !== -1 && !eventsState.events[eventIdx].gameId) {
          const updatedEvent = { ...eventsState.events[eventIdx], gameId: newGame.id };
          const nextEvents = {
            ...eventsState,
            events: eventsState.events.map((e, i) => (i === eventIdx ? updatedEvent : e)),
          };
          try {
            eventsSha = await writeJSON(
              CONFIG.DATA_PATHS.events,
              nextEvents,
              eventsSha,
              `link event to game ${newGame.date} vs ${newGame.opponent}`
            );
            eventsState = nextEvents;
          } catch (linkErr) {
            console.warn('event link failed', linkErr);
            // 試合自体は保存済みなので致命ではない
          }
        }
      }

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

// ========== 打席記録モーダル (Phase 2: 打順 + 攻撃 + 守備 + 編集) ==========
function openPlaysDialog(gameId) {
  const game = gamesState.games.find((x) => x.id === gameId);
  if (!game) return;
  if (membersState.members.length === 0) {
    showToast('先にメンバーを登録してください', 'error');
    return;
  }

  // 既存データの正規化（古い文字列配列 → 新しいオブジェクト配列）
  const normalizeLineup = (raw) =>
    (raw || []).map((item) =>
      typeof item === 'string'
        ? { memberId: item, position: '' }
        : { memberId: item.memberId || '', position: item.position || '' }
    );

  let lineup = normalizeLineup(game.ourLineup);
  let plays = (game.ourPlays || []).map((p) => ({ ...p }));

  // 相手打順: ニックネーム配列。長さが打順サイズ。デフォルト9名。
  const DEFAULT_OPP_LINEUP_SIZE = 9;
  let oppBatters = Array.isArray(game.oppBatters) && game.oppBatters.length > 0
    ? [...game.oppBatters]
    : Array(DEFAULT_OPP_LINEUP_SIZE).fill('');

  // 既存oppPlaysに oppBatterIdx が無い場合は配列順から補完（旧データ互換）
  let oppPlays = (game.oppPlays || []).map((p, i) => {
    const next = { ...p };
    if (typeof next.oppBatterIdx !== 'number') {
      next.oppBatterIdx = i % oppBatters.length;
    }
    return next;
  });

  let isHome = !!game.isHome;
  let activeTab = lineup.length === 0 ? 'lineup' : 'offense';

  // 攻撃タブの状態
  let pendingResult = null;
  let pendingRBI = 0;
  let manualInning = null;
  let offenseEntryCollapsed = false;
  // 守備タブの状態
  let pendingDefResult = null;
  let pendingDefRBI = 0;
  let manualDefInning = null;
  let manualOppBatterIdx = null; // 相手打者の手動指定（前/次の打者ボタン）
  let defenseEntryCollapsed = false;
  const memberById = (id) => membersState.members.find((m) => m.id === id);

  // 次の相手打者idx（自動算出）
  function nextOppBatterIdx() {
    if (manualOppBatterIdx !== null) return manualOppBatterIdx;
    if (oppPlays.length === 0) return 0;
    const last = oppPlays[oppPlays.length - 1];
    return ((last.oppBatterIdx ?? -1) + 1) % oppBatters.length;
  }
  // 相手打者の表示文字列
  function oppBatterLabel(idx) {
    const num = idx + 1;
    const nick = (oppBatters[idx] || '').trim();
    return nick ? `${num}番 ${nick}` : `${num}番`;
  }

  // 投手ポジションの判定（旧データの '投手' も互換維持）
  const isPitcherPosition = (pos) => pos === CONFIG.PITCHER_POSITION || pos === '投手';

  // 「投手」ポジションの選手を守備投手として自動判定
  // 居なければ最終 oppPlay の投手にフォールバック
  function getDefensivePitcher() {
    const pitcherEntry = lineup.find((e) => isPitcherPosition(e.position));
    if (pitcherEntry) return pitcherEntry.memberId;
    if (oppPlays.length > 0) {
      const last = oppPlays[oppPlays.length - 1];
      if (last.pitcherId) return last.pitcherId;
    }
    return null;
  }

  // 投手交代: 新しい投手を立てる。打順内の選手なら入れ替え、外ならスタメンと入れ替え。
  function changePitcher(newMemberId) {
    const oldPitcherIdx = lineup.findIndex((e) => isPitcherPosition(e.position));
    if (!newMemberId) {
      if (oldPitcherIdx !== -1) lineup[oldPitcherIdx].position = '';
      return;
    }
    const newPlayerIdx = lineup.findIndex((e) => e.memberId === newMemberId);
    if (newPlayerIdx === -1) {
      // 打順未登録の選手 → 旧投手と入れ替え（ベンチの選手が登板）
      if (oldPitcherIdx !== -1) {
        lineup[oldPitcherIdx] = { memberId: newMemberId, position: CONFIG.PITCHER_POSITION };
      } else {
        lineup.push({ memberId: newMemberId, position: CONFIG.PITCHER_POSITION });
      }
    } else {
      // 打順内の選手 → ポジションを入れ替え（守備位置の変更）
      if (oldPitcherIdx !== -1 && oldPitcherIdx !== newPlayerIdx) {
        const newPlayerOldPos = lineup[newPlayerIdx].position;
        lineup[oldPitcherIdx].position = newPlayerOldPos || '';
        lineup[newPlayerIdx].position = CONFIG.PITCHER_POSITION;
      } else {
        lineup[newPlayerIdx].position = CONFIG.PITCHER_POSITION;
      }
    }
  }

  const readOnly = !!game.finalized;
  const html = `
    <div class="modal-backdrop open" id="plays-modal">
      <div class="modal plays-modal ${readOnly ? 'play-readonly' : ''}">
        <h3 style="margin:0 0 4px">📝 打席記録 ${readOnly ? '<span class="badge badge-win" style="margin-left:4px">🏁 確定済</span>' : ''}</h3>
        <div class="card-meta" style="margin-bottom:8px">
          ${escapeHtml(formatDate(game.date))} vs ${escapeHtml(game.opponent || '')}
        </div>
        ${readOnly ? `
          <div style="background:#fffbe6;border:1px solid #f0d160;color:#5c4400;padding:10px 12px;border-radius:6px;margin-bottom:8px;font-size:.85rem;line-height:1.5">
            🏁 このスコアは<strong>確定済み</strong>です。打席の編集はできません。<br>
            修正したい場合は「試合の編集」→ 一番下の「✓ スコア確定済み」ボタンで解除してください。
          </div>
        ` : ''}
        <div class="play-tabs">
          <button type="button" class="play-tab" data-tab="lineup">打順</button>
          <button type="button" class="play-tab" data-tab="offense">攻撃</button>
          <button type="button" class="play-tab" data-tab="defense">守備</button>
        </div>
        <div class="play-tab-content" id="tab-lineup"></div>
        <div class="play-tab-content" id="tab-offense"></div>
        <div class="play-tab-content" id="tab-defense"></div>
        <div class="modal-actions" style="margin-top:8px">
          <button type="button" class="btn btn-primary btn-block" id="plays-close">閉じる</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const modal = document.getElementById('plays-modal');

  function setTab(tab) {
    activeTab = tab;
    modal.querySelectorAll('.play-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('tab-lineup').style.display = tab === 'lineup' ? 'block' : 'none';
    document.getElementById('tab-offense').style.display = tab === 'offense' ? 'flex' : 'none';
    document.getElementById('tab-defense').style.display = tab === 'defense' ? 'flex' : 'none';
    // 切替先タブを最新状態で再描画（打順変更が他タブに即反映されるため）
    if (tab === 'lineup') renderLineupTab();
    else if (tab === 'offense') renderOffenseTab();
    else if (tab === 'defense') renderDefenseTab();
  }
  modal.querySelectorAll('.play-tab').forEach((t) => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  // ----- 打順タブ -----
  function renderLineupTab() {
    const positionOptions = (selected) =>
      ['', ...CONFIG.POSITIONS]
        .map((p) => `<option value="${escapeHtml(p)}" ${p === (selected || '') ? 'selected' : ''}>${p || '-- 未選択 --'}</option>`)
        .join('');

    const lineupHtml = lineup.length === 0
      ? '<div class="empty">打順未設定。下から選手を追加してください。</div>'
      : lineup.map((entry, i) => {
        const m = memberById(entry.memberId);
        return `
          <div class="lineup-row" data-pos="${i}">
            <div class="lineup-row-main">
              <span class="lineup-pos">${i + 1}</span>
              <span class="lineup-name">${m ? `${m.number != null ? `<span class="num-badge">#${m.number}</span> ` : ''}${escapeHtml(m.name)}` : '<span style="color:var(--color-danger)">削除済</span>'}</span>
              <div class="lineup-actions">
                <button type="button" class="lineup-icon-btn" data-sub-row title="交代">🔄</button>
                <button type="button" class="lineup-icon-btn" data-up ${i === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="lineup-icon-btn" data-down ${i === lineup.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" class="lineup-icon-btn" data-remove>×</button>
              </div>
            </div>
            <div class="lineup-row-position">
              <span class="lineup-pos-label">守備位置</span>
              <select class="lineup-pos-select" data-pos-select="${i}">
                ${positionOptions(entry.position)}
              </select>
            </div>
          </div>
        `;
      }).join('');

    const usedIds = new Set(lineup.map((e) => e.memberId));
    let available = membersState.members.filter((m) => !usedIds.has(m.id));
    // リンク予定がある場合は ○ (出席) のメンバーだけに絞る
    let availabilityFiltered = false;
    if (game.eventId) {
      const att = attendanceState.attendance[game.eventId] || {};
      const yesIds = new Set(Object.keys(att).filter((mid) => att[mid] === 'yes'));
      available = available.filter((m) => yesIds.has(m.id));
      availabilityFiltered = true;
    }
    const sortedAvail = [...available].sort((a, b) => {
      const na = a.number ?? 999, nb = b.number ?? 999;
      if (na !== nb) return na - nb;
      return (a.name || '').localeCompare(b.name || '', 'ja');
    });

    // 出席者ボタン用の情報（リンク予定があれば）
    let attendeeButtonHtml = '';
    if (game.eventId) {
      const att = attendanceState.attendance[game.eventId] || {};
      const yesIds = Object.keys(att).filter((mid) => att[mid] === 'yes');
      const maybeIds = Object.keys(att).filter((mid) => att[mid] === 'maybe');
      const yesNotInLineup = yesIds.filter((id) => !usedIds.has(id));
      const maybeNotInLineup = maybeIds.filter((id) => !usedIds.has(id));
      if (yesNotInLineup.length > 0 || maybeNotInLineup.length > 0) {
        attendeeButtonHtml = `
          <div style="background:#eef4fb;border-radius:6px;padding:10px;margin-bottom:10px">
            <div style="font-size:.85rem;font-weight:600;color:var(--color-primary);margin-bottom:6px">📅 リンク中の予定の出席者</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${yesNotInLineup.length > 0 ? `<button type="button" class="btn btn-sm btn-primary" id="add-yes-attendees" style="font-size:.8rem">○ 出席 ${yesNotInLineup.length}名を打順に追加</button>` : ''}
              ${maybeNotInLineup.length > 0 ? `<button type="button" class="btn btn-sm" id="add-maybe-attendees" style="font-size:.8rem">△ 未定 ${maybeNotInLineup.length}名も追加</button>` : ''}
            </div>
          </div>
        `;
      }
    }

    document.getElementById('tab-lineup').innerHTML = `
      <div class="home-toggle" style="margin-bottom:10px">
        <span style="font-size:.8rem;color:var(--color-text-muted);margin-right:6px">当チームは</span>
        <button type="button" class="ht-btn ${!isHome ? 'active' : ''}" data-home="false">先攻 (表)</button>
        <button type="button" class="ht-btn ${isHome ? 'active' : ''}" data-home="true">後攻 (裏)</button>
      </div>
      ${attendeeButtonHtml}
      <p style="font-size:.8rem;color:var(--color-text-muted);margin:0 0 8px">
        ↑↓で並び替え、×で削除。10人以上もOK。各打者にポジションを試合ごとに設定できます。
      </p>
      <div class="lineup-list">${lineupHtml}</div>
      ${sortedAvail.length > 0 ? `
        <div style="margin-top:12px">
          <h5 style="margin:0 0 6px;font-size:.85rem;color:var(--color-text-muted)">
            追加できるメンバー${availabilityFiltered ? '（○ 出席のみ）' : ''}
          </h5>
          <div class="member-pool">
            ${sortedAvail.map((m) => `
              <button type="button" class="member-pool-btn" data-add-member="${m.id}">
                ${m.number != null ? `<span class="num-badge">#${m.number}</span> ` : ''}${escapeHtml(m.name)}
              </button>
            `).join('')}
          </div>
        </div>
      ` : `<p style="font-size:.8rem;color:var(--color-text-muted);margin-top:8px">${availabilityFiltered ? '○ で出席登録されたメンバーは全員打順に入っています。<br>追加で誰かを入れたい場合は、出欠ページで該当メンバーを ○ に登録してください。' : '全員を打順に入れました。'}</p>`}
    `;

    const tabEl = document.getElementById('tab-lineup');
    tabEl.querySelectorAll('.ht-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        isHome = btn.dataset.home === 'true';
        renderLineupTab();
        await autoSave({ silent: true });
      });
    });
    tabEl.querySelectorAll('[data-up]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const i = Number(btn.closest('.lineup-row').dataset.pos);
        if (i > 0) {
          [lineup[i - 1], lineup[i]] = [lineup[i], lineup[i - 1]];
          renderLineupTab();
          await autoSave({ silent: true });
        }
      });
    });
    tabEl.querySelectorAll('[data-down]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const i = Number(btn.closest('.lineup-row').dataset.pos);
        if (i < lineup.length - 1) {
          [lineup[i], lineup[i + 1]] = [lineup[i + 1], lineup[i]];
          renderLineupTab();
          await autoSave({ silent: true });
        }
      });
    });
    tabEl.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const i = Number(btn.closest('.lineup-row').dataset.pos);
        const m = memberById(lineup[i].memberId);
        if (!confirm(`「${m ? m.name : '?'}」を打順から外しますか？\n（過去の打席記録は残ります）`)) return;
        lineup.splice(i, 1);
        renderLineupTab();
        await autoSave({ silent: true });
      });
    });
    tabEl.querySelectorAll('[data-pos-select]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const i = Number(sel.dataset.posSelect);
        const newPos = sel.value;
        // 「投手」を選んだ場合、ほかの投手は自動で外す（同時に2人投手は不可）
        if (isPitcherPosition(newPos)) {
          lineup.forEach((e, idx) => {
            if (idx !== i && isPitcherPosition(e.position)) e.position = '';
          });
        }
        lineup[i].position = newPos;
        renderLineupTab();
        await autoSave({ silent: true });
      });
    });
    tabEl.querySelectorAll('[data-add-member]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        lineup.push({ memberId: btn.dataset.addMember, position: '' });
        renderLineupTab();
        await autoSave({ silent: true });
      });
    });
    tabEl.querySelectorAll('[data-sub-row]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.closest('.lineup-row').dataset.pos);
        openSubstitutePicker(i);
      });
    });

    // 出席者を一括追加
    async function addAttendeesByStatus(targetStatus) {
      const att = attendanceState.attendance[game.eventId] || {};
      const ids = Object.keys(att).filter((mid) => att[mid] === targetStatus);
      const usedNow = new Set(lineup.map((e) => e.memberId));
      const toAdd = ids
        .filter((id) => !usedNow.has(id))
        .map((id) => memberById(id))
        .filter(Boolean)
        .sort((a, b) => {
          const na = a.number ?? 999, nb = b.number ?? 999;
          if (na !== nb) return na - nb;
          return (a.name || '').localeCompare(b.name || '', 'ja');
        });
      if (toAdd.length === 0) return;
      for (const m of toAdd) {
        lineup.push({ memberId: m.id, position: '' });
      }
      renderLineupTab();
      await autoSave({ message: `${toAdd.length}名を打順に追加しました` });
    }
    document.getElementById('add-yes-attendees')?.addEventListener('click', () => addAttendeesByStatus('yes'));
    document.getElementById('add-maybe-attendees')?.addEventListener('click', () => addAttendeesByStatus('maybe'));
  }

  // ----- 攻撃タブ -----
  function currentInning() {
    return manualInning != null ? manualInning : computeNextInning(plays);
  }
  function currentBatterIdx() {
    if (lineup.length === 0) return -1;
    return plays.length % lineup.length;
  }
  function renderOffenseTab() {
    const tabEl = document.getElementById('tab-offense');
    if (lineup.length === 0) {
      tabEl.innerHTML = '<div class="empty">先に「打順」タブで打順を設定してください。</div>';
      return;
    }
    const inning = currentInning();
    const outs = outsInInning(plays, inning);
    const inningRuns = runsInInning(plays, inning);
    const batterIdx = currentBatterIdx();
    const entry = lineup[batterIdx];
    const batterId = entry.memberId;
    const batter = memberById(batterId);

    const resultButtons = RESULT_TYPES.map((r) => `
      <button type="button" class="result-btn ${pendingResult === r.key ? 'active' : ''} ${isOut(r.key) ? 'is-out' : 'is-onbase'}" data-result="${r.key}">
        ${r.label}
      </button>
    `).join('');

    const recentPlays = [...plays].reverse().slice(0, 30);
    const playsList = plays.length === 0
      ? '<div class="card-meta" style="text-align:center;padding:12px">まだ打席が記録されていません</div>'
      : recentPlays.map((p, idxRev) => {
        const realIdx = plays.length - 1 - idxRev;
        const m = memberById(p.batterId);
        return `
          <div class="play-row">
            <span class="play-inning">${p.inning}回</span>
            <span class="play-batter">${m ? (m.number != null ? `#${m.number} ` : '') + m.name : '?'}</span>
            <span class="play-result">${resultLabel(p.result)}${p.rbi > 0 ? ` <strong>(${p.rbi}打点)</strong>` : ''}</span>
            <button type="button" class="play-edit-btn" data-play-edit="${realIdx}" aria-label="編集">編</button>
            <button type="button" class="play-del-btn" data-play-del="${realIdx}" aria-label="削除">×</button>
          </div>
        `;
      }).join('');

    tabEl.innerHTML = `
      <button type="button" class="entry-toggle" id="entry-toggle">
        ${offenseEntryCollapsed ? `▼ 入力エリアを開く（${inning}回・${batterIdx + 1}番 ${batter ? batter.name : '?'}）` : '▲ 入力エリアを閉じて履歴を広げる'}
      </button>
      <div class="play-entry ${offenseEntryCollapsed ? 'collapsed' : ''}">
        <div class="play-state">
          <div class="play-state-row">
            <span class="play-state-label">${inning}回</span>
            <span class="play-state-out">アウト ${outs}/3</span>
            <span class="play-state-runs">この回 ${inningRuns}点</span>
          </div>
          <div class="play-state-row" style="margin-top:6px">
            <button type="button" class="btn btn-sm" id="prev-inning">前の回</button>
            <button type="button" class="btn btn-sm" id="next-inning">次の回</button>
            ${manualInning != null ? '<span style="font-size:.7rem;color:var(--color-warning);margin-left:8px">手動指定中</span>' : ''}
          </div>
        </div>
        <div class="batter-info">
          <span style="font-size:.8rem;color:var(--color-text-muted)">打者</span>
          <strong>${batterIdx + 1}番: ${batter ? (batter.number != null ? `<span class="num-badge">#${batter.number}</span> ` : '') + escapeHtml(batter.name) : '?'}${entry.position ? ` <span style="font-size:.8rem;color:var(--color-text-muted);font-weight:normal">(${escapeHtml(entry.position)})</span>` : ''}</strong>
          <button type="button" class="btn btn-sm" id="sub-batter" style="margin-left:auto">🔄 交代</button>
        </div>
        <div class="result-grid">${resultButtons}</div>
        <div class="entry-bottom-bar">
          <div class="rbi-controls" style="flex:1;margin:0">
            <span class="stat-label">打点</span>
            <div class="stat-controls">
              <button type="button" class="stat-btn" id="rbi-dec">−</button>
              <span class="stat-value" id="rbi-display">${pendingRBI}</span>
              <button type="button" class="stat-btn stat-btn-plus" id="rbi-inc">+</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary" id="confirm-pa" ${!pendingResult ? 'disabled' : ''} style="flex:1">
            記録 ▶
          </button>
        </div>
      </div>
      <h5 class="plays-list-title">記録済みの打席 (${plays.length})</h5>
      <div class="plays-list-scroll">
        <div class="plays-list">${playsList}</div>
      </div>
    `;
    document.getElementById('entry-toggle').addEventListener('click', () => {
      offenseEntryCollapsed = !offenseEntryCollapsed;
      renderOffenseTab();
    });

    tabEl.querySelectorAll('.result-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.result;
        pendingResult = pendingResult === r ? null : r;
        renderOffenseTab();
      });
    });
    document.getElementById('rbi-dec').addEventListener('click', () => {
      pendingRBI = Math.max(0, pendingRBI - 1);
      document.getElementById('rbi-display').textContent = pendingRBI;
    });
    document.getElementById('rbi-inc').addEventListener('click', () => {
      pendingRBI = Math.min(4, pendingRBI + 1);
      document.getElementById('rbi-display').textContent = pendingRBI;
    });
    document.getElementById('confirm-pa').addEventListener('click', async () => {
      if (!pendingResult) return;
      const inningRecorded = currentInning();
      plays.push({
        inning: inningRecorded,
        batterId,
        result: pendingResult,
        rbi: pendingRBI,
      });
      pendingResult = null;
      pendingRBI = 0;
      manualInning = null;
      try {
        await savePlays({ silent: true });
      } catch { return; }
      // 3アウトで自動的に守備タブへ切替（最新イニングのみ）
      const outsAfterPA = outsInInning(plays, inningRecorded);
      const maxInning = plays.length > 0 ? Math.max(...plays.map((p) => p.inning)) : 1;
      if (outsAfterPA >= 3 && inningRecorded === maxInning) {
        defenseEntryCollapsed = false;
        setTab('defense');
        renderDefenseTab();
        showToast(`${inningRecorded}回 3アウト → 守備に切替`, 'success');
      } else {
        renderOffenseTab();
        showToast('記録しました', 'success');
      }
    });
    document.getElementById('prev-inning').addEventListener('click', () => {
      const cur = currentInning();
      if (cur > 1) manualInning = cur - 1;
      renderOffenseTab();
    });
    document.getElementById('next-inning').addEventListener('click', () => {
      manualInning = currentInning() + 1;
      renderOffenseTab();
    });
    tabEl.querySelectorAll('[data-play-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.playDel);
        const p = plays[idx];
        const m = memberById(p.batterId);
        if (!confirm(`${p.inning}回 ${m ? m.name : '?'} の打席を削除しますか？`)) return;
        plays.splice(idx, 1);
        renderOffenseTab();
        await autoSave({ message: '削除しました' });
      });
    });
    tabEl.querySelectorAll('[data-play-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.playEdit);
        openPlayEditPopup({
          play: plays[idx],
          isOffense: true,
          onSave: async (updated) => {
            plays[idx] = updated;
            renderOffenseTab();
            await autoSave({ message: '更新しました' });
          },
        });
      });
    });
    document.getElementById('sub-batter').addEventListener('click', () => {
      openSubstitutePicker(batterIdx);
    });
  }

  // ----- 打者交代ポップアップ -----
  function openSubstitutePicker(lineupPos) {
    const currentEntry = lineup[lineupPos];
    const currentMember = memberById(currentEntry.memberId);
    const usedIds = new Set(lineup.map((e) => e.memberId));
    // 同じ位置の現メンバーは選べる必要なし、ほかの位置にいる人も除外
    const available = membersState.members.filter((m) => !usedIds.has(m.id));
    const sortedAvail = [...available].sort((a, b) => {
      const na = a.number ?? 999, nb = b.number ?? 999;
      if (na !== nb) return na - nb;
      return (a.name || '').localeCompare(b.name || '', 'ja');
    });

    if (sortedAvail.length === 0) {
      showToast('打順に登録されていないメンバーがいません。新規メンバー登録か、打順タブで調整してください。', 'error');
      return;
    }

    const html = `
      <div class="play-edit-popup-backdrop" id="sub-picker">
        <div class="play-edit-popup">
          <h4>🔄 打者を交代</h4>
          <p style="font-size:.85rem;color:var(--color-text-muted);margin:0 0 8px">
            <strong>${lineupPos + 1}番:</strong> ${currentMember ? `${currentMember.number != null ? `#${currentMember.number} ` : ''}${escapeHtml(currentMember.name)}` : '?'}
            の交代相手を選びます。
          </p>
          <p style="font-size:.75rem;color:var(--color-text-muted);margin:0 0 10px">
            ※ 過去の打席記録は元の選手のままです。次の打席から新しい選手で記録されます。
          </p>
          <div class="member-pool" style="max-height:300px;overflow:auto;display:flex;flex-direction:column">
            ${sortedAvail.map((m) => `
              <button type="button" class="member-pool-btn" data-pick="${m.id}">
                ${m.number != null ? `<span class="num-badge">#${m.number}</span> ` : ''}${escapeHtml(m.name)}
              </button>
            `).join('')}
          </div>
          <div class="modal-actions" style="margin-top:12px">
            <button type="button" class="btn btn-block" id="sub-cancel">キャンセル</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('sub-picker');
    backdrop.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const newMemberId = btn.dataset.pick;
        const newMember = memberById(newMemberId);
        // ポジションは引き継ぐ
        lineup[lineupPos] = {
          memberId: newMemberId,
          position: currentEntry.position,
        };
        backdrop.remove();
        renderOffenseTab();
        renderLineupTab();
        await autoSave({ message: `${currentMember ? currentMember.name : '?'} → ${newMember ? newMember.name : '?'} に交代` });
      });
    });
    document.getElementById('sub-cancel').addEventListener('click', () => backdrop.remove());
  }

  // ----- 守備タブ -----
  function currentDefInning() {
    return manualDefInning != null ? manualDefInning : computeNextInning(oppPlays);
  }
  function renderDefenseTab() {
    const tabEl = document.getElementById('tab-defense');
    const inning = currentDefInning();
    const outs = outsInInning(oppPlays, inning);
    const inningRuns = runsInInning(oppPlays, inning);
    const currentPitcherId = getDefensivePitcher();
    const pitcher = currentPitcherId ? memberById(currentPitcherId) : null;

    const resultButtons = RESULT_TYPES.map((r) => `
      <button type="button" class="result-btn ${pendingDefResult === r.key ? 'active' : ''} ${isOut(r.key) ? 'is-out' : 'is-onbase'}" data-def-result="${r.key}">
        ${r.label}
      </button>
    `).join('');

    const curOppIdx = nextOppBatterIdx();
    const recentPlays = [...oppPlays].reverse().slice(0, 30);
    const playsList = oppPlays.length === 0
      ? '<div class="card-meta" style="text-align:center;padding:12px">まだ打席が記録されていません</div>'
      : recentPlays.map((p, idxRev) => {
        const realIdx = oppPlays.length - 1 - idxRev;
        const pm = p.pitcherId ? memberById(p.pitcherId) : null;
        const batterStr = typeof p.oppBatterIdx === 'number' ? oppBatterLabel(p.oppBatterIdx) : '打順?';
        return `
          <div class="play-row">
            <span class="play-inning">${p.inning}回</span>
            <span class="play-batter">${escapeHtml(batterStr)}<span style="font-size:.7rem;color:var(--color-text-muted);margin-left:6px">vs ${pm ? escapeHtml(pm.name) : '?'}</span></span>
            <span class="play-result">${resultLabel(p.result)}${p.rbi > 0 ? ` <strong>(${p.rbi}失点)</strong>` : ''}</span>
            <button type="button" class="play-edit-btn" data-defplay-edit="${realIdx}" aria-label="編集">編</button>
            <button type="button" class="play-del-btn" data-defplay-del="${realIdx}" aria-label="削除">×</button>
          </div>
        `;
      }).join('');

    tabEl.innerHTML = `
      <button type="button" class="entry-toggle" id="def-entry-toggle">
        ${defenseEntryCollapsed ? `▼ 入力エリアを開く（${inning}回・投手:${pitcher ? pitcher.name : '未設定'}）` : '▲ 入力エリアを閉じて履歴を広げる'}
      </button>
      <div class="play-entry ${defenseEntryCollapsed ? 'collapsed' : ''}">
        <div class="play-state">
          <div class="play-state-row">
            <span class="play-state-label">${inning}回</span>
            <span class="play-state-out">アウト ${outs}/3</span>
            <span class="play-state-runs" style="color:var(--color-danger)">失点 ${inningRuns}</span>
          </div>
          <div class="play-state-row" style="margin-top:6px">
            <button type="button" class="btn btn-sm" id="def-prev-inning">前の回</button>
            <button type="button" class="btn btn-sm" id="def-next-inning">次の回</button>
            ${manualDefInning != null ? '<span style="font-size:.7rem;color:var(--color-warning);margin-left:8px">手動指定中</span>' : ''}
          </div>
        </div>
        <div class="batter-info">
          <span style="font-size:.8rem;color:var(--color-text-muted)">投手</span>
          ${pitcher
            ? `<strong>${pitcher.number != null ? `<span class="num-badge">#${pitcher.number}</span> ` : ''}${escapeHtml(pitcher.name)}</strong>`
            : '<strong style="color:var(--color-warning)">未設定</strong>'}
          <button type="button" class="btn btn-sm" id="change-pitcher" style="margin-left:auto">変更</button>
        </div>
        <div class="batter-info" style="background:#fff8f0">
          <span style="font-size:.8rem;color:var(--color-text-muted)">相手打者</span>
          <strong>${escapeHtml(oppBatterLabel(curOppIdx))}</strong>
          ${manualOppBatterIdx !== null ? '<span style="font-size:.7rem;color:var(--color-warning);margin-left:4px">手動</span>' : ''}
          <button type="button" class="btn btn-sm" id="opp-prev-batter" style="margin-left:auto">◀</button>
          <button type="button" class="btn btn-sm" id="opp-next-batter">▶</button>
          <button type="button" class="btn btn-sm" id="opp-lineup-edit" title="打順・ニックネーム編集">✏️</button>
        </div>
        <div class="result-grid">${resultButtons}</div>
        <div class="entry-bottom-bar">
          <div class="rbi-controls" style="flex:1;margin:0">
            <span class="stat-label">失点</span>
            <div class="stat-controls">
              <button type="button" class="stat-btn" id="def-rbi-dec">−</button>
              <span class="stat-value" id="def-rbi-display">${pendingDefRBI}</span>
              <button type="button" class="stat-btn stat-btn-plus" id="def-rbi-inc">+</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary" id="confirm-def-pa" ${!pendingDefResult ? 'disabled' : ''} style="flex:1">
            記録 ▶
          </button>
        </div>
      </div>
      <h5 class="plays-list-title">記録済みの打席 (${oppPlays.length})</h5>
      <div class="plays-list-scroll">
        <div class="plays-list">${playsList}</div>
      </div>
    `;
    document.getElementById('def-entry-toggle').addEventListener('click', () => {
      defenseEntryCollapsed = !defenseEntryCollapsed;
      renderDefenseTab();
    });

    tabEl.querySelectorAll('.result-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.defResult;
        pendingDefResult = pendingDefResult === r ? null : r;
        renderDefenseTab();
      });
    });
    document.getElementById('def-rbi-dec').addEventListener('click', () => {
      pendingDefRBI = Math.max(0, pendingDefRBI - 1);
      document.getElementById('def-rbi-display').textContent = pendingDefRBI;
    });
    document.getElementById('def-rbi-inc').addEventListener('click', () => {
      pendingDefRBI = Math.min(4, pendingDefRBI + 1);
      document.getElementById('def-rbi-display').textContent = pendingDefRBI;
    });
    document.getElementById('confirm-def-pa').addEventListener('click', async () => {
      if (!pendingDefResult) return;
      const inningRecorded = currentDefInning();
      const oppBatterIdxRecorded = nextOppBatterIdx();
      oppPlays.push({
        inning: inningRecorded,
        result: pendingDefResult,
        rbi: pendingDefRBI,
        pitcherId: getDefensivePitcher() || null,
        oppBatterIdx: oppBatterIdxRecorded,
      });
      pendingDefResult = null;
      pendingDefRBI = 0;
      manualDefInning = null;
      manualOppBatterIdx = null;
      try {
        await savePlays({ silent: true });
      } catch { return; }
      // 3アウトで自動的に攻撃タブへ切替（最新イニングのみ）
      const outsAfterPA = outsInInning(oppPlays, inningRecorded);
      const maxInning = oppPlays.length > 0 ? Math.max(...oppPlays.map((p) => p.inning)) : 1;
      if (outsAfterPA >= 3 && inningRecorded === maxInning) {
        offenseEntryCollapsed = false;
        setTab('offense');
        renderOffenseTab();
        showToast(`${inningRecorded}回 3アウト → 攻撃に切替`, 'success');
      } else {
        renderDefenseTab();
        showToast('記録しました', 'success');
      }
    });
    document.getElementById('def-prev-inning').addEventListener('click', () => {
      const cur = currentDefInning();
      if (cur > 1) manualDefInning = cur - 1;
      renderDefenseTab();
    });
    document.getElementById('def-next-inning').addEventListener('click', () => {
      manualDefInning = currentDefInning() + 1;
      renderDefenseTab();
    });
    document.getElementById('change-pitcher').addEventListener('click', () => {
      openPitcherPicker(async (picked) => {
        changePitcher(picked);
        renderDefenseTab();
        renderLineupTab();
        const newPitcher = picked ? memberById(picked) : null;
        await autoSave({ message: newPitcher ? `投手を ${newPitcher.name} に変更` : '投手なしに変更' });
      });
    });
    document.getElementById('opp-prev-batter').addEventListener('click', () => {
      const cur = nextOppBatterIdx();
      manualOppBatterIdx = (cur - 1 + oppBatters.length) % oppBatters.length;
      renderDefenseTab();
    });
    document.getElementById('opp-next-batter').addEventListener('click', () => {
      const cur = nextOppBatterIdx();
      manualOppBatterIdx = (cur + 1) % oppBatters.length;
      renderDefenseTab();
    });
    document.getElementById('opp-lineup-edit').addEventListener('click', () => {
      openOppLineupEditor();
    });
    tabEl.querySelectorAll('[data-defplay-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.defplayDel);
        const p = oppPlays[idx];
        if (!confirm(`${p.inning}回 相手の打席（${resultLabel(p.result)}）を削除しますか？`)) return;
        oppPlays.splice(idx, 1);
        renderDefenseTab();
        await autoSave({ message: '削除しました' });
      });
    });
    tabEl.querySelectorAll('[data-defplay-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.defplayEdit);
        openPlayEditPopup({
          play: oppPlays[idx],
          isOffense: false,
          onSave: async (updated) => {
            oppPlays[idx] = updated;
            renderDefenseTab();
            await autoSave({ message: '更新しました' });
          },
        });
      });
    });
  }

  // ----- 投手選択ポップアップ -----
  function openPitcherPicker(onPick) {
    const sortedMembers = [...membersState.members].sort((a, b) => {
      const na = a.number ?? 999, nb = b.number ?? 999;
      if (na !== nb) return na - nb;
      return (a.name || '').localeCompare(b.name || '', 'ja');
    });
    const currentPitcherId = getDefensivePitcher();
    const html = `
      <div class="play-edit-popup-backdrop" id="pitcher-picker">
        <div class="play-edit-popup">
          <h4>投手を選択</h4>
          <p style="font-size:.75rem;color:var(--color-text-muted);margin:0 0 8px">
            選択した選手の守備位置が「投手」になります。打順内で別ポジションだった場合は元の投手とポジションが入れ替わります。
          </p>
          <div class="member-pool" style="max-height:300px;overflow:auto;display:flex;flex-direction:column">
            <button type="button" class="member-pool-btn ${!currentPitcherId ? 'active' : ''}" data-pick="">-- 投手なし --</button>
            ${sortedMembers.map((m) => `
              <button type="button" class="member-pool-btn ${m.id === currentPitcherId ? 'active' : ''}" data-pick="${m.id}">
                ${m.number != null ? `<span class="num-badge">#${m.number}</span> ` : ''}${escapeHtml(m.name)}
              </button>
            `).join('')}
          </div>
          <div class="modal-actions" style="margin-top:12px">
            <button type="button" class="btn btn-block" id="pitcher-picker-cancel">キャンセル</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('pitcher-picker');
    backdrop.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onPick(btn.dataset.pick || null);
        backdrop.remove();
      });
    });
    document.getElementById('pitcher-picker-cancel').addEventListener('click', () => backdrop.remove());
  }

  // ----- 相手打順 / ニックネーム編集ポップアップ -----
  function openOppLineupEditor() {
    let editing = [...oppBatters];
    function rowsHtml() {
      return editing.map((nick, i) => `
        <div class="field" style="display:flex;align-items:center;gap:8px;margin:4px 0">
          <span style="min-width:36px;font-weight:600">${i + 1}番</span>
          <input class="field-input" type="text" data-opp-nick="${i}" value="${escapeHtml(nick)}" placeholder="ニックネーム（任意）" style="flex:1">
          ${editing.length > 9 ? `<button type="button" class="btn btn-sm" data-opp-remove="${i}" title="この打順を削除">×</button>` : ''}
        </div>
      `).join('');
    }
    const html = `
      <div class="play-edit-popup-backdrop" id="opp-lineup-editor">
        <div class="play-edit-popup">
          <h4>相手打順 / ニックネーム編集</h4>
          <p style="font-size:.75rem;color:var(--color-text-muted);margin:0 0 8px">
            ニックネームは任意です。打順は10番目以降も追加できます。
          </p>
          <div id="opp-lineup-rows" style="max-height:50vh;overflow:auto">${rowsHtml()}</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button type="button" class="btn btn-sm" id="opp-add-row">＋ 打順を追加</button>
          </div>
          <div class="modal-actions" style="margin-top:12px">
            <button type="button" class="btn" id="opp-edit-cancel">キャンセル</button>
            <button type="button" class="btn btn-primary" id="opp-edit-save">保存</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('opp-lineup-editor');
    const rowsEl = document.getElementById('opp-lineup-rows');

    function syncFromInputs() {
      backdrop.querySelectorAll('[data-opp-nick]').forEach((el) => {
        const i = Number(el.dataset.oppNick);
        editing[i] = el.value;
      });
    }
    function rerender() {
      rowsEl.innerHTML = rowsHtml();
      bindRowHandlers();
    }
    function bindRowHandlers() {
      backdrop.querySelectorAll('[data-opp-remove]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncFromInputs();
          const i = Number(btn.dataset.oppRemove);
          // 既にこの打順idxを使っている記録があるなら削除不可
          const used = oppPlays.some((p) => p.oppBatterIdx === i);
          if (used) {
            showToast(`${i + 1}番は既に打席記録があるため削除できません`, 'error');
            return;
          }
          editing.splice(i, 1);
          // 削除位置以降のidxを使っている記録を1つ前に詰める（保存時に反映）
          rerender();
        });
      });
    }
    bindRowHandlers();

    document.getElementById('opp-add-row').addEventListener('click', () => {
      syncFromInputs();
      editing.push('');
      rerender();
    });
    document.getElementById('opp-edit-cancel').addEventListener('click', () => backdrop.remove());
    document.getElementById('opp-edit-save').addEventListener('click', async () => {
      syncFromInputs();
      // 削除によって長さが変わる場合: oppPlays の oppBatterIdx を再マップ
      if (editing.length < oppBatters.length) {
        // 既存の打席は削除しない仕様なので、長さが減ったら超過idxを末尾に丸める
        oppPlays = oppPlays.map((p) => {
          if (typeof p.oppBatterIdx === 'number' && p.oppBatterIdx >= editing.length) {
            return { ...p, oppBatterIdx: editing.length - 1 };
          }
          return p;
        });
      }
      oppBatters = editing;
      manualOppBatterIdx = null;
      backdrop.remove();
      renderDefenseTab();
      await autoSave({ message: '相手打順を保存しました' });
    });
  }

  // ----- 打席編集ポップアップ -----
  function openPlayEditPopup({ play, isOffense, onSave }) {
    let editResult = play.result;
    let editRBI = play.rbi || 0;
    let editInning = play.inning;
    let editBatterId = play.batterId;
    let editPitcherId = play.pitcherId || null;
    let editOppBatterIdx = typeof play.oppBatterIdx === 'number' ? play.oppBatterIdx : 0;

    const memberOptions = (selected) =>
      membersState.members.map((m) => `
        <option value="${m.id}" ${m.id === selected ? 'selected' : ''}>
          ${m.number != null ? `#${m.number} ` : ''}${escapeHtml(m.name)}
        </option>
      `).join('');

    const html = `
      <div class="play-edit-popup-backdrop" id="play-edit-backdrop">
        <div class="play-edit-popup">
          <h4>${isOffense ? '打席を編集' : '相手打席を編集'}</h4>
          <div class="field" style="display:flex;align-items:center;gap:8px">
            <label class="field-label" style="margin:0;min-width:60px">イニング</label>
            <input class="field-input" type="number" min="1" id="edit-inning" value="${editInning}" style="max-width:80px">
            <span style="font-size:.85rem;color:var(--color-text-muted)">回</span>
          </div>
          ${isOffense ? `
            <div class="field">
              <label class="field-label">打者</label>
              <select class="field-select" id="edit-batter">
                ${memberOptions(editBatterId)}
              </select>
            </div>
          ` : `
            <div class="field">
              <label class="field-label">投手</label>
              <select class="field-select" id="edit-pitcher">
                <option value="">-- なし --</option>
                ${memberOptions(editPitcherId)}
              </select>
            </div>
            <div class="field">
              <label class="field-label">相手打者</label>
              <select class="field-select" id="edit-opp-batter">
                ${oppBatters.map((_, i) => `
                  <option value="${i}" ${i === editOppBatterIdx ? 'selected' : ''}>${escapeHtml(oppBatterLabel(i))}</option>
                `).join('')}
              </select>
            </div>
          `}
          <div class="field">
            <label class="field-label">結果</label>
            <div class="result-grid">
              ${RESULT_TYPES.map((r) => `
                <button type="button" class="result-btn ${r.key === editResult ? 'active' : ''} ${isOut(r.key) ? 'is-out' : 'is-onbase'}" data-edit-result="${r.key}">
                  ${r.label}
                </button>
              `).join('')}
            </div>
          </div>
          <div class="rbi-controls">
            <span class="stat-label">${isOffense ? '打点' : '失点'}</span>
            <div class="stat-controls">
              <button type="button" class="stat-btn" id="edit-rbi-dec">−</button>
              <span class="stat-value" id="edit-rbi-display">${editRBI}</span>
              <button type="button" class="stat-btn stat-btn-plus" id="edit-rbi-inc">+</button>
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" id="edit-cancel">キャンセル</button>
            <button type="button" class="btn btn-primary" id="edit-save">更新</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('play-edit-backdrop');

    backdrop.querySelectorAll('[data-edit-result]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editResult = btn.dataset.editResult;
        backdrop.querySelectorAll('[data-edit-result]').forEach((b) => b.classList.toggle('active', b.dataset.editResult === editResult));
      });
    });
    document.getElementById('edit-rbi-dec').addEventListener('click', () => {
      editRBI = Math.max(0, editRBI - 1);
      document.getElementById('edit-rbi-display').textContent = editRBI;
    });
    document.getElementById('edit-rbi-inc').addEventListener('click', () => {
      editRBI = Math.min(4, editRBI + 1);
      document.getElementById('edit-rbi-display').textContent = editRBI;
    });
    document.getElementById('edit-cancel').addEventListener('click', () => backdrop.remove());
    document.getElementById('edit-save').addEventListener('click', () => {
      const inningRaw = Number(document.getElementById('edit-inning').value) || 1;
      editInning = Math.max(1, inningRaw);
      let updated;
      if (isOffense) {
        editBatterId = document.getElementById('edit-batter').value;
        updated = { ...play, inning: editInning, batterId: editBatterId, result: editResult, rbi: editRBI };
      } else {
        editPitcherId = document.getElementById('edit-pitcher').value || null;
        editOppBatterIdx = Number(document.getElementById('edit-opp-batter').value) || 0;
        updated = { ...play, inning: editInning, pitcherId: editPitcherId, oppBatterIdx: editOppBatterIdx, result: editResult, rbi: editRBI };
      }
      onSave(updated);
      backdrop.remove();
    });
  }

  setTab(activeTab);
  renderLineupTab();
  renderOffenseTab();
  renderDefenseTab();

  async function savePlays({ silent = false, message = '保存しました' } = {}) {
    if (readOnly) {
      showToast('確定済みのため編集できません', 'error');
      throw new Error('readonly');
    }
    try {
      let updatedGame = {
        ...game,
        ourLineup: lineup,
        ourPlays: plays,
        oppPlays: oppPlays,
        oppBatters: oppBatters,
        isHome,
      };
      if (plays.length > 0 || oppPlays.length > 0) {
        const ourTotal = plays.reduce((s, p) => s + (p.rbi || 0), 0);
        const theirTotal = oppPlays.reduce((s, p) => s + (p.rbi || 0), 0);
        if (plays.length > 0) updatedGame.ourScore = ourTotal;
        if (oppPlays.length > 0) updatedGame.theirScore = theirTotal;
        const our = updatedGame.ourScore || 0;
        const their = updatedGame.theirScore || 0;
        updatedGame.result = our > their ? 'win' : our < their ? 'lose' : 'draw';
      }
      const next = {
        ...gamesState,
        games: gamesState.games.map((x) => (x.id === game.id ? updatedGame : x)),
      };
      gamesSha = await writeJSON(
        CONFIG.DATA_PATHS.games,
        next,
        gamesSha,
        `update plays for game ${game.date} vs ${game.opponent}`,
      );
      gamesState = next;
      Object.assign(game, updatedGame);
      render();
      if (!silent) showToast(message, 'success');
    } catch (err) {
      if (err instanceof ConflictError) showToast(err.message, 'error');
      else showToast('保存に失敗しました: ' + err.message, 'error');
      throw err;
    }
  }

  // 自動保存ヘルパー: 失敗時は savePlays が toast を出す
  async function autoSave(opts = {}) {
    try { await savePlays(opts); } catch { /* already handled */ }
  }

  document.getElementById('plays-close').addEventListener('click', () => modal.remove());
}
