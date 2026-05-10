export const CONFIG = {
  TEAM_NAME: '高井戸第二小学校PTA野球部',
  CONTACT_EMAIL: 'kazutake.asahi@gmail.com',

  GITHUB_OWNER: 'takani-pta-baseball-team',
  GITHUB_REPO: 'ourpage',
  BRANCH: 'main',

  ENCRYPTED_PAT_PATH: 'encrypted-pat.json',
  DATA_PATHS: {
    members: 'data/members.json',
    games: 'data/games.json',
    events: 'data/events.json',
    attendance: 'data/attendance.json',
  },

  POSITIONS: [
    '1 ピッチャー',
    '2 キャッチャー',
    '3 ファースト',
    '4 セカンド',
    '5 サード',
    '6 ショート',
    '7 レフト',
    '8 センター',
    '9 ライト',
    'DH（指名打者）',
    '控え',
  ],
  PITCHER_POSITION: '1 ピッチャー',
  ATTENDANCE_STATUSES: [
    { value: 'yes', label: '○', meaning: '出席' },
    { value: 'maybe', label: '△', meaning: '未定' },
    { value: 'no', label: '×', meaning: '欠席' },
  ],
};
