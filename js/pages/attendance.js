import { CONFIG } from '../config.js';
import { fetchJSON, writeJSON, ConflictError } from '../api.js';
import { renderHeader, renderNav, requireAuth, showToast, escapeHtml, formatDate, uid, todayISO } from '../app.js';

// 「試合」扱いの種別（旧データの '試合' も含めて互換維持）
const GAME_EVENT_TYPES = ['試合', '分区試合', 'P協試合'];
function isGameType(type) {
  return GAME_EVENT_TYPES.includes(type);
}

renderHeader();
renderNav('attendance');

let eventsState = { events: [] };
let eventsSha = null;
let attendanceState = { attendance: {} };
let attendanceSha = null;
let membersState = { members: [] };
let gamesState = { games: [] };
let gamesSha = null;

requireAuth(async () => {
  await Promise.all([loadEvents(), loadAttendance(), loadMembers(), loadGames()]);
  render();
  document.getElementById('add-event-btn').addEventListener('click', openAddEventDialog);
});

async function loadEvents() {
  const { data, sha } = await fetchJSON(CONFIG.DATA_PATHS.events);
  eventsState = data || { events: [] };
  eventsSha = sha;
}

async function loadAttendance() {
  const { data, sha } = await fetchJSON(CONFIG.DATA_PATHS.attendance);
  attendanceState = data || { attendance: {} };
  attendanceSha = sha;
}

async function loadMembers() {
  const { data } = await fetchJSON(CONFIG.DATA_PATHS.members);
  membersState = data || { members: [] };
}

async function loadGames() {
  const { data, sha } = await fetchJSON(CONFIG.DATA_PATHS.games);
  gamesState = data || { games: [] };
  gamesSha = sha;
}

function render() {
  const list = document.getElementById('events-list');
  const today = todayISO();
  const upcoming = eventsState.events
    .filter((e) => (e.date || '') >= today)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const past = eventsState.events
    .filter((e) => (e.date || '') < today)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 5);

  if (upcoming.length === 0 && past.length === 0) {
    list.innerHTML = '<div class="empty">まだ予定が登録されていません。<br>「＋ 予定追加」から登録してください。</div>';
    return;
  }

  let html = '';
  if (upcoming.length > 0) {
    html += '<h3 style="font-size:.9rem;color:var(--color-text-muted);margin:0 0 8px">これからの予定</h3>';
    html += upcoming.map((e) => renderEventCard(e, false)).join('');
  }
  if (past.length > 0) {
    html += '<h3 style="font-size:.9rem;color:var(--color-text-muted);margin:16px 0 8px">過去の予定</h3>';
    html += past.map((e) => renderEventCard(e, true)).join('');
  }
  list.innerHTML = html;

  list.querySelectorAll('[data-att]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { eventId, memberId, status } = btn.dataset;
      setAttendance(eventId, memberId, status);
    });
  });
  list.querySelectorAll('[data-edit-event]').forEach((btn) => {
    btn.addEventListener('click', () => openEditEventDialog(btn.dataset.editEvent));
  });
  list.querySelectorAll('[data-delete-event]').forEach((btn) => {
    btn.addEventListener('click', () => deleteEvent(btn.dataset.deleteEvent));
  });
}

function renderEventCard(ev, isPast) {
  const att = attendanceState.attendance[ev.id] || {};
  // 出欠リストは名前順で表示
  const members = [...membersState.members].sort((a, b) => {
    return (a.name || '').localeCompare(b.name || '', 'ja');
  });

  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const m of members) {
    const s = att[m.id];
    if (s && counts[s] != null) counts[s]++;
  }

  const memberRows = members.length === 0
    ? '<div class="card-meta">まだメンバーが登録されていません</div>'
    : members.map((m) => {
        const cur = att[m.id] || '';
        return `
          <div class="attendance-grid" style="padding:6px 0;border-bottom:1px solid var(--color-border)">
            <span class="name">${m.number != null ? `<span style="color:var(--color-text-muted);font-size:.8rem">#${m.number}</span> ` : ''}${escapeHtml(m.name)}</span>
            <div class="attendance-buttons">
              ${CONFIG.ATTENDANCE_STATUSES.map((s) => `
                <button class="att-btn ${cur === s.value ? 'active-' + s.value : ''}"
                  data-att data-event-id="${ev.id}" data-member-id="${m.id}" data-status="${s.value}"
                  title="${s.meaning}" ${isPast ? 'disabled' : ''}>${s.label}</button>
              `).join('')}
            </div>
          </div>
        `;
      }).join('');

  return `
    <div class="card" ${isPast ? 'style="opacity:.7"' : ''}>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div>
          <div class="card-title">${escapeHtml(formatDate(ev.date))} ${ev.startTime ? `${escapeHtml(ev.startTime)}` : ''}${ev.endTime ? `〜${escapeHtml(ev.endTime)}` : ''}</div>
          <div class="card-meta">
            ${ev.type ? `<strong>${escapeHtml(ev.type)}</strong>` : ''}
            ${ev.location ? ` ・ 📍 ${escapeHtml(ev.location)}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn btn-sm" data-edit-event="${ev.id}">編集</button>
          <button class="btn btn-sm btn-danger" data-delete-event="${ev.id}">削除</button>
        </div>
      </div>
      ${ev.description ? `<p style="margin:8px 0;font-size:.9rem;white-space:pre-wrap">${escapeHtml(ev.description)}</p>` : ''}
      <div style="display:flex;gap:12px;margin:8px 0;font-size:.85rem">
        <span style="color:var(--color-success)">○ ${counts.yes}</span>
        <span style="color:var(--color-warning)">△ ${counts.maybe}</span>
        <span style="color:var(--color-danger)">× ${counts.no}</span>
      </div>
      <details>
        <summary style="cursor:pointer;font-size:.85rem;color:var(--color-text-muted);margin-bottom:8px">出欠を見る・登録する</summary>
        ${memberRows}
      </details>
    </div>
  `;
}

async function setAttendance(eventId, memberId, status) {
  const cur = (attendanceState.attendance[eventId] || {})[memberId];
  const next = JSON.parse(JSON.stringify(attendanceState));
  if (!next.attendance[eventId]) next.attendance[eventId] = {};
  if (cur === status) {
    delete next.attendance[eventId][memberId];
  } else {
    next.attendance[eventId][memberId] = status;
  }
  try {
    attendanceSha = await writeJSON(
      CONFIG.DATA_PATHS.attendance,
      next,
      attendanceSha,
      `update attendance ${eventId}`
    );
    attendanceState = next;
    render();
  } catch (err) {
    if (err instanceof ConflictError) {
      showToast(err.message, 'error');
      await loadAttendance();
      render();
    } else {
      showToast('保存に失敗しました: ' + err.message, 'error');
    }
  }
}

function openAddEventDialog() {
  openEventDialog({
    id: '',
    date: nextSundayISO(),
    startTime: '07:00',
    endTime: '09:00',
    type: '練習',
    location: '高井戸第二小学校 校庭',
    description: '',
  }, false);
}

// 今日が日曜なら今日、それ以外は次の日曜
function nextSundayISO() {
  const d = new Date();
  const dow = d.getDay(); // 0=Sun
  const daysUntil = dow === 0 ? 0 : 7 - dow;
  d.setDate(d.getDate() + daysUntil);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function openEditEventDialog(id) {
  const ev = eventsState.events.find((x) => x.id === id);
  if (!ev) return;
  openEventDialog({ ...ev }, true);
}

function openEventDialog(ev, isEdit) {
  const html = `
    <div class="modal-backdrop open" id="event-modal" role="dialog" aria-modal="true">
      <div class="modal">
        <h3>${isEdit ? '予定を編集' : '新しい予定を追加'}</h3>
        <form id="event-form">
          <div class="field">
            <label class="field-label">日付</label>
            <input class="field-input" type="date" name="date" value="${ev.date}" required />
          </div>
          <div class="field-row">
            <div class="field">
              <label class="field-label">開始時刻</label>
              <input class="field-input" type="time" name="startTime" value="${ev.startTime || ''}" />
            </div>
            <div class="field">
              <label class="field-label">終了時刻</label>
              <input class="field-input" type="time" name="endTime" value="${ev.endTime || ''}" />
            </div>
          </div>
          <div class="field">
            <label class="field-label">種別</label>
            <select class="field-select" name="type">
              <option value="練習" ${ev.type === '練習' ? 'selected' : ''}>練習</option>
              <option value="分区試合" ${ev.type === '分区試合' ? 'selected' : ''}>分区試合</option>
              <option value="P協試合" ${ev.type === 'P協試合' ? 'selected' : ''}>P協試合</option>
              <option value="懇親会" ${ev.type === '懇親会' ? 'selected' : ''}>懇親会</option>
              <option value="その他" ${ev.type === 'その他' ? 'selected' : ''}>その他</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label">場所</label>
            <input class="field-input" type="text" name="location" value="${escapeHtml(ev.location)}" />
          </div>
          <div class="field">
            <label class="field-label">メモ</label>
            <textarea class="field-textarea" name="description">${escapeHtml(ev.description)}</textarea>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" id="event-cancel">キャンセル</button>
            <button type="submit" class="btn btn-primary" id="event-submit">${isEdit ? '更新' : '追加'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const modal = document.getElementById('event-modal');
  const form = document.getElementById('event-form');
  const submitBtn = document.getElementById('event-submit');
  document.getElementById('event-cancel').addEventListener('click', () => modal.remove());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const newEv = {
      id: ev.id || uid('e'),
      date: fd.get('date').toString(),
      startTime: fd.get('startTime').toString(),
      endTime: fd.get('endTime').toString(),
      type: fd.get('type').toString(),
      location: fd.get('location').toString().trim(),
      description: fd.get('description').toString().trim(),
      gameId: ev.gameId || null,
    };
    submitBtn.disabled = true;
    submitBtn.textContent = '保存中...';
    try {
      // リンク済みの試合がある場合の同期処理
      if (newEv.gameId) {
        if (isGameType(newEv.type)) {
          // 既存の試合の date/location を予定と同期
          const existing = gamesState.games.find((g) => g.id === newEv.gameId);
          if (existing) {
            const updatedGame = {
              ...existing,
              date: newEv.date,
              location: existing.location || newEv.location,
              eventId: newEv.id,
            };
            const nextGames = {
              ...gamesState,
              games: gamesState.games.map((g) => (g.id === newEv.gameId ? updatedGame : g)),
            };
            gamesSha = await writeJSON(
              CONFIG.DATA_PATHS.games,
              nextGames,
              gamesSha,
              `sync game with event ${newEv.date}`
            );
            gamesState = nextGames;
          }
        } else {
          // 区分が「試合」以外に変わった: リンクは外す（試合自体は残す）
          newEv.gameId = null;
        }
      }
      // ※区分=試合の予定の場合、試合は自動作成しません。
      //   試合ページの「＋ 新規登録」 → 予定リストから選択して登録してください。

      const next = { ...eventsState };
      if (isEdit) {
        next.events = next.events.map((x) => (x.id === newEv.id ? newEv : x));
      } else {
        next.events = [...next.events, newEv];
      }
      eventsSha = await writeJSON(
        CONFIG.DATA_PATHS.events,
        next,
        eventsSha,
        isEdit ? `update event ${newEv.date}` : `add event ${newEv.date}`
      );
      eventsState = next;
      modal.remove();
      render();
      showToast('保存しました', 'success');
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? '更新' : '追加';
      if (err instanceof ConflictError) {
        showToast(err.message, 'error');
      } else {
        showToast('保存に失敗しました: ' + err.message, 'error');
      }
    }
  });
}

async function deleteEvent(id) {
  const ev = eventsState.events.find((x) => x.id === id);
  if (!ev) return;
  let alsoDeleteGame = false;
  const linkedGame = ev.gameId ? gamesState.games.find((g) => g.id === ev.gameId) : null;
  if (linkedGame) {
    if (!confirm(`${formatDate(ev.date)} の予定を削除しますか？\n（出欠データも一緒に削除されます）`)) return;
    alsoDeleteGame = confirm(
      `この予定にリンクしている試合 (vs ${linkedGame.opponent || '未定'}) も削除しますか？\n\n` +
      `[OK] = 試合データも削除（打席記録・写真などすべて削除）\n` +
      `[キャンセル] = 試合は残す（リンクだけ解除）`
    );
  } else {
    if (!confirm(`${formatDate(ev.date)} の予定を削除しますか？\n（出欠データも一緒に削除されます）`)) return;
  }

  try {
    // リンク中の試合の eventId をクリア（残す場合）または試合自体を削除（削除する場合）
    if (linkedGame) {
      if (alsoDeleteGame) {
        const nextGames = { ...gamesState, games: gamesState.games.filter((g) => g.id !== linkedGame.id) };
        gamesSha = await writeJSON(CONFIG.DATA_PATHS.games, nextGames, gamesSha, `delete game (event removed)`);
        gamesState = nextGames;
      } else {
        const updatedGame = { ...linkedGame, eventId: null };
        const nextGames = {
          ...gamesState,
          games: gamesState.games.map((g) => (g.id === linkedGame.id ? updatedGame : g)),
        };
        gamesSha = await writeJSON(CONFIG.DATA_PATHS.games, nextGames, gamesSha, `unlink game from event`);
        gamesState = nextGames;
      }
    }

    const nextEvents = { ...eventsState, events: eventsState.events.filter((x) => x.id !== id) };
    eventsSha = await writeJSON(CONFIG.DATA_PATHS.events, nextEvents, eventsSha, `delete event ${ev.date}`);
    eventsState = nextEvents;

    if (attendanceState.attendance[id]) {
      const nextAtt = JSON.parse(JSON.stringify(attendanceState));
      delete nextAtt.attendance[id];
      attendanceSha = await writeJSON(CONFIG.DATA_PATHS.attendance, nextAtt, attendanceSha, `delete attendance for ${ev.date}`);
      attendanceState = nextAtt;
    }
    render();
    showToast(alsoDeleteGame ? '予定と試合を削除しました' : '削除しました', 'success');
  } catch (err) {
    if (err instanceof ConflictError) {
      showToast(err.message, 'error');
    } else {
      showToast('削除に失敗しました: ' + err.message, 'error');
    }
  }
}
