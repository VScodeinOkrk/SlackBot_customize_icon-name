const { App } = require('@slack/bolt');
const fs = require('node:fs/promises');
const path = require('node:path');

// Credentials are read only by Node at runtime; this program never logs them.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const socketMode = Boolean(process.env.SLACK_APP_TOKEN);
const required = ['SLACK_BOT_TOKEN', ...(socketMode ? ['SLACK_APP_TOKEN'] : ['SLACK_SIGNING_SECRET'])];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

const dataDirectory = path.join(__dirname, '.bot-data');
const settingsPath = path.join(dataDirectory, 'channel-settings.json');
const statePath = path.join(dataDirectory, 'bot-state.json');
const developersPath = path.join(dataDirectory, 'developers.json');
const cooldownMs = 30_000;
const topicIdeas = [
  '最近、時間を忘れて夢中になったことは？', '今月中に挑戦してみたいことは？',
  'おすすめしたい本・映画・ゲームは？', '子どもの頃に好きだったものは？',
  'もし一日だけ自由に使えるなら何をする？', '最近知って「なるほど」と思ったことは？',
  'みんなに聞いてみたい小さな疑問は？',
];
const defaultOutputTemplates = {
  reaction: '📊 {user} さんのスタンプ集計{note}\n{items}',
  reminder: '⏰ {schedule}リマインダーを設定しました：{text}',
  topic: '💬 *今日のトークテーマ*\n{topic}',
  roll: '🎲 {user} の {dice}: *{values} = {total}*',
  roulette: '🎉 *結果: {winner}*',
};
const app = new App({ token: process.env.SLACK_BOT_TOKEN, ...(socketMode ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN } : { signingSecret: process.env.SLACK_SIGNING_SECRET }) });
let settingsByChannel = {};
let state = { reactions: {}, reminders: [], outputTemplates: { ...defaultOutputTemplates } };
let developers = new Set();
let botUserId;
const lastGeneralUse = new Map();

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function writeJson(file, value) { await fs.mkdir(dataDirectory, { recursive: true }); const temporary = `${file}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await fs.rename(temporary, file); }
async function loadData() { settingsByChannel = await readJson(settingsPath, {}); const saved = await readJson(statePath, {}); state = { ...state, ...saved, outputTemplates: { ...defaultOutputTemplates, ...(saved.outputTemplates || {}) } }; const access = await readJson(developersPath, { userIds: [] }); developers = new Set(Array.isArray(access.userIds) ? access.userIds.map((id) => String(id).trim()).filter(Boolean) : []); }
const saveSettings = () => writeJson(settingsPath, settingsByChannel);
const saveState = () => writeJson(statePath, state);
const isDeveloper = (userId) => developers.has(userId);
function input(view, id) { return view.state.values[id][`${id}_input`].value.trim(); }
function output(name, values) { return state.outputTemplates[name].replace(/\{([a-z]+)\}/g, (_, key) => values[key] ?? ''); }
function cooldown(userId) { const now = Date.now(); const last = lastGeneralUse.get(userId) || 0; if (now - last < cooldownMs) return Math.ceil((cooldownMs - now + last) / 1000); lastGeneralUse.set(userId, now); return 0; }
async function allow(command, respond) { const seconds = cooldown(command.user_id); if (!seconds) return true; await respond({ response_type: 'ephemeral', text: `連続実行を防ぐため、あと ${seconds} 秒お待ちください。` }); return false; }
function reminderSchedule(value) {
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, '秒': 1_000, '分': 60_000, '時間': 3_600_000, '日': 86_400_000, '週': 604_800_000, '週間': 604_800_000 };
  const repeating = /^(\d+)\s*(s|m|h|d|秒|分|時間|日|週|週間)\s*に\s*(\d+)\s*回$/i.exec(value);
  if (repeating) {
    const span = Number(repeating[1]) * units[repeating[2].toLowerCase()];
    const times = Number(repeating[3]);
    const interval = span / times;
    if (!Number.isInteger(interval) || interval < 10_000 || interval > 52 * 604_800_000) return null;
    return { ms: interval, repeatMs: interval, label: `${repeating[1]}${repeating[2]}に${times}回` };
  }
  const once = /^(\d+)\s*(s|m|h|d|秒|分|時間|日|週|週間)$/i.exec(value);
  if (!once) return null;
  const ms = Number(once[1]) * units[once[2].toLowerCase()];
  if (ms < 10_000 || ms > 52 * 604_800_000) return null;
  return { ms, label: `${once[1]}${once[2]}` };
}
function nextWeeklyAt(weekday, time) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => Number(parts.find((item) => item.type === type).value);
  const year = part('year'); const month = part('month'); const day = part('day');
  const [hour, minute] = time.split(':').map(Number);
  const todayJst = Date.UTC(year, month - 1, day);
  const daysAhead = (weekday - new Date(todayJst).getUTCDay() + 7) % 7;
  let target = Date.UTC(year, month - 1, day + daysAhead, hour, minute) - 9 * 3_600_000;
  if (target <= Date.now()) target += 7 * 86_400_000;
  return target;
}
function schedule(reminder, client) {
  const delay = reminder.at - Date.now();
  if (delay <= 0) return;
  setTimeout(async () => {
    const current = state.reminders.find((item) => item.id === reminder.id);
    if (!current) return;
    // Long waits exceed JavaScript's timer maximum; reschedule until the due time.
    if (current.at > Date.now()) return schedule(current, client);
    try { await client.chat.postMessage({ channel: current.channel, text: `⏰ <@${current.user}> さん、リマインダーです：${current.text}` }); } catch (error) { console.error('Reminder delivery failed', error); }
    if (current.repeatMs) {
      current.at = Date.now() + current.repeatMs;
    } else {
      state.reminders = state.reminders.filter((item) => item.id !== current.id);
    }
    await saveState();
    if (current.repeatMs) schedule(current, client);
  }, Math.min(delay, 2_147_000_000));
}
async function fetchChannelReactions(client, channel) {
  const reactions = [];
  const names = new Set();
  let cursor;
  let pages = 0;
  do {
    const result = await client.conversations.history({ channel, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const message of result.messages || []) {
      for (const reaction of message.reactions || []) { reactions.push(reaction); names.add(reaction.name); }
    }
    cursor = result.response_metadata?.next_cursor;
    pages += 1;
  } while (cursor && pages < 10);
  return { reactions, names: [...names].sort(), limited: Boolean(cursor) };
}

function settingsModal(channelId, current = {}) { const fields = [['join_message', '入室メッセージ', current.joinMessage || '👋 {user} さんが入室しました'], ['leave_message', '退室メッセージ', current.leaveMessage || '👋 {user} さんが退室しました'], ['bot_name', 'Botの表示名（空欄なら標準名）', current.username || ''], ['icon', 'Botアイコン（:emoji: または公開画像URL）', current.iconEmoji || current.iconUrl || '']]; return { type: 'modal', callback_id: 'save_channel_settings', private_metadata: channelId, title: { type: 'plain_text', text: '入退室メッセージ設定' }, submit: { type: 'plain_text', text: '保存' }, close: { type: 'plain_text', text: 'キャンセル' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '`{user}` は対象ユーザーへのメンションに置換されます。アイコンには `:robot_face:` か、誰でも直接取得できる公開HTTPS画像URLを指定してください。' } }, ...fields.map(([id, label, initial_value]) => ({ type: 'input', block_id: id, label: { type: 'plain_text', text: label }, element: { type: 'plain_text_input', action_id: `${id}_input`, initial_value } }))] }; }
app.command('/entry-settings', async ({ ack, command, client, respond }) => { await ack(); if (!isDeveloper(command.user_id)) return respond({ response_type: 'ephemeral', text: 'このコマンドは開発者のみ利用できます。' }); await client.views.open({ trigger_id: command.trigger_id, view: settingsModal(command.channel_id, settingsByChannel[command.channel_id]) }); });
app.view('save_channel_settings', async ({ ack, body, view, client }) => { if (!isDeveloper(body.user.id)) return ack({ response_action: 'errors', errors: { join_message: '開発者のみ保存できます。' } }); const joinMessage = input(view, 'join_message'); const leaveMessage = input(view, 'leave_message'); const username = input(view, 'bot_name'); const icon = input(view, 'icon'); const emoji = /^:[a-z0-9_+\-]+:$/i.test(icon); const url = /^https:\/\/[^\s]+$/i.test(icon); const errors = {}; if (!joinMessage) errors.join_message = '入室メッセージを入力してください。'; if (!leaveMessage) errors.leave_message = '退室メッセージを入力してください。'; if (icon && !emoji && !url) errors.icon = '`:+1:` 形式の絵文字、または公開HTTPS画像URLを入力してください。'; if (Object.keys(errors).length) return ack({ response_action: 'errors', errors }); settingsByChannel[view.private_metadata] = { joinMessage, leaveMessage, username: username || undefined, iconEmoji: emoji ? icon : undefined, iconUrl: url ? icon : undefined }; await saveSettings(); await ack(); await client.chat.postEphemeral({ channel: view.private_metadata, user: body.user.id, text: 'このチャンネルの設定を保存しました。' }); });
function outputSettingsModal() { const fields = [['reaction', 'スタンプ集計', '使える値: {user} {note} {items}'], ['reminder', 'リマインダー設定確認', '使える値: {schedule} {text}'], ['topic', 'トークテーマ', '使える値: {topic}'], ['roll', 'ダイス結果', '使える値: {user} {dice} {values} {total}'], ['roulette', 'ルーレット結果', '使える値: {winner} {choices}']]; return { type: 'modal', callback_id: 'save_output_settings', title: { type: 'plain_text', text: '表示文の設定' }, submit: { type: 'plain_text', text: '保存' }, close: { type: 'plain_text', text: 'キャンセル' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Slash Commandの結果文を編集できます。`{...}` は実行時の内容に置換されます。' } }, ...fields.map(([id, label, hint]) => ({ type: 'input', block_id: id, label: { type: 'plain_text', text: label }, hint: { type: 'plain_text', text: hint }, element: { type: 'plain_text_input', action_id: `${id}_input`, multiline: true, initial_value: state.outputTemplates[id] } }))] }; }
app.command('/output-settings', async ({ ack, command, client, respond }) => { await ack(); if (!isDeveloper(command.user_id)) return respond({ response_type: 'ephemeral', text: 'このコマンドは開発者のみ利用できます。' }); await client.views.open({ trigger_id: command.trigger_id, view: outputSettingsModal() }); });
app.view('save_output_settings', async ({ ack, body, view }) => { if (!isDeveloper(body.user.id)) return ack({ response_action: 'errors', errors: { reaction: '開発者のみ保存できます。' } }); const templates = Object.fromEntries(['reaction', 'reminder', 'topic', 'roll', 'roulette'].map((id) => [id, input(view, id)])); const empty = Object.entries(templates).find(([, value]) => !value); if (empty) return ack({ response_action: 'errors', errors: { [empty[0]]: '空欄にはできません。' } }); state.outputTemplates = templates; await saveState(); await ack(); });

// General-user features. Each successful use is limited to once per user per 30 seconds.
app.command('/reaction-count', async ({ ack, command, client, respond }) => {
  await ack();
  if (!await allow(command, respond)) return;
  try {
    const { names } = await fetchChannelReactions(client, command.channel_id);
    await client.views.open({ trigger_id: command.trigger_id, view: { type: 'modal', callback_id: 'count_reactions', private_metadata: JSON.stringify({ channel: command.channel_id, user: command.user_id }), title: { type: 'plain_text', text: 'スタンプ集計' }, submit: { type: 'plain_text', text: '集計する' }, close: { type: 'plain_text', text: 'キャンセル' }, blocks: [
      { type: 'input', optional: true, block_id: 'reaction_types', label: { type: 'plain_text', text: '集計するスタンプ種類（未選択ならすべて）' }, element: { type: 'multi_static_select', action_id: 'reaction_types_select', placeholder: { type: 'plain_text', text: 'すべてのスタンプ' }, options: names.slice(0, 100).map((name) => ({ text: { type: 'plain_text', text: `:${name}:` }, value: name })) } },
      { type: 'input', optional: true, block_id: 'reaction_user', label: { type: 'plain_text', text: 'スタンプを付けたユーザー' }, element: { type: 'users_select', action_id: 'reaction_user_select', initial_user: command.user_id, placeholder: { type: 'plain_text', text: '自分' } } },
    ] } });
  } catch (error) {
    console.error('Reaction count failed', error);
    await respond({ response_type: 'ephemeral', text: 'スタンプを取得できませんでした。Botがこのチャンネルに参加しているか、必要な閲覧権限があるか確認してください。' });
  }
});
app.view('count_reactions', async ({ ack, view, client }) => {
  const metadata = JSON.parse(view.private_metadata);
  const selectedTypes = (view.state.values.reaction_types?.reaction_types_select?.selected_options || []).map((option) => option.value);
  const selectedUser = view.state.values.reaction_user?.reaction_user_select?.selected_user || metadata.user;
  try {
    const { reactions, limited } = await fetchChannelReactions(client, metadata.channel);
    const counts = new Map();
    for (const reaction of reactions) {
      if (selectedTypes.length && !selectedTypes.includes(reaction.name)) continue;
      if (!(reaction.users || []).includes(selectedUser)) continue;
      counts.set(reaction.name, (counts.get(reaction.name) || 0) + 1);
    }
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    await ack();
    await client.chat.postMessage({ channel: metadata.channel, text: entries.length ? output('reaction', { user: `<@${selectedUser}>`, note: limited ? '（直近1,000件のメッセージ）' : '', items: entries.map(([name, count]) => `:${name}: *${count}*`).join('\n') }) : `📊 <@${selectedUser}> さんの該当スタンプは、現在見つかりませんでした。` });
  } catch (error) {
    console.error('Reaction count failed', error);
    await ack();
    await client.chat.postEphemeral({ channel: metadata.channel, user: metadata.user, text: 'スタンプを取得できませんでした。Botがこのチャンネルに参加しているか、必要な閲覧権限があるか確認してください。' });
  }
});
app.command('/bot-remind', async ({ ack, command, client, respond }) => {
  await ack();
  if (!await allow(command, respond)) return;
  const intervals = ['30秒', '1分', '10分', '30分', '1時間', '1日', '1週間', '1週間に1回', '2週間に1回', '2週間に3回', '毎週（曜日と時刻を選択）'];
  await client.views.open({ trigger_id: command.trigger_id, view: { type: 'modal', callback_id: 'create_reminder', private_metadata: command.channel_id, title: { type: 'plain_text', text: 'Botリマインダー' }, submit: { type: 'plain_text', text: '設定' }, close: { type: 'plain_text', text: 'キャンセル' }, blocks: [
    { type: 'input', block_id: 'reminder_interval', label: { type: 'plain_text', text: '通知のタイミング' }, element: { type: 'static_select', action_id: 'reminder_interval_select', initial_option: { text: { type: 'plain_text', text: '10分後' }, value: '10分' }, options: intervals.map((value) => ({ text: { type: 'plain_text', text: value.includes('に') || value.startsWith('毎週') ? value : `${value}後` }, value })) } },
    { type: 'input', optional: true, block_id: 'reminder_weekday', label: { type: 'plain_text', text: '曜日（「毎週」を選んだ場合・複数選択可）' }, element: { type: 'multi_static_select', action_id: 'reminder_weekday_select', initial_options: [{ text: { type: 'plain_text', text: '月曜日' }, value: '1' }], options: [['日曜日', '0'], ['月曜日', '1'], ['火曜日', '2'], ['水曜日', '3'], ['木曜日', '4'], ['金曜日', '5'], ['土曜日', '6']].map(([text, value]) => ({ text: { type: 'plain_text', text }, value })) } },
    { type: 'input', optional: true, block_id: 'reminder_time', label: { type: 'plain_text', text: '時刻（「毎週」を選んだ場合・日本時間）' }, element: { type: 'timepicker', action_id: 'reminder_time_select', initial_time: '09:00' } },
    { type: 'input', block_id: 'reminder_text', label: { type: 'plain_text', text: 'リマインド内容' }, element: { type: 'plain_text_input', action_id: 'reminder_text_input', placeholder: { type: 'plain_text', text: '例: 会議の準備' } } },
  ] } });
});
app.view('create_reminder', async ({ ack, body, view, client }) => {
  const when = view.state.values.reminder_interval.reminder_interval_select.selected_option.value;
  const text = input(view, 'reminder_text');
  const weekdays = (view.state.values.reminder_weekday?.reminder_weekday_select?.selected_options || [{ value: '1' }]).map((option) => Number(option.value));
  const time = view.state.values.reminder_time?.reminder_time_select?.selected_time || '09:00';
  const scheduleInfos = when.startsWith('毎週')
    ? weekdays.map((weekday) => ({ at: nextWeeklyAt(weekday, time), repeatMs: 7 * 86_400_000, label: `毎週${['日', '月', '火', '水', '木', '金', '土'][weekday]}曜日 ${time}` }))
    : [reminderSchedule(when)];
  if (!text) return ack({ response_action: 'errors', errors: { reminder_text: 'リマインド内容を入力してください。' } });
  const reminders = scheduleInfos.map((scheduleInfo, index) => ({ id: `${Date.now()}-${body.user.id}-${index}`, channel: view.private_metadata, user: body.user.id, text, at: scheduleInfo.at || Date.now() + scheduleInfo.ms, ...(scheduleInfo.repeatMs ? { repeatMs: scheduleInfo.repeatMs } : {}) }));
  state.reminders.push(...reminders);
  await saveState();
  for (const reminder of reminders) schedule(reminder, client);
  await ack();
  const label = when.startsWith('毎週') ? `毎週${weekdays.map((weekday) => ['日', '月', '火', '水', '木', '金', '土'][weekday]).join('・')}曜日 ${time}で繰り返す` : `${scheduleInfos[0].label}後の`;
  await client.chat.postEphemeral({ channel: view.private_metadata, user: body.user.id, text: output('reminder', { schedule: label, text }) });
});
app.command('/bot-topic', async ({ ack, command, respond }) => { await ack(); if (!await allow(command, respond)) return; const topic = topicIdeas[Math.floor(Math.random() * topicIdeas.length)]; await respond({ response_type: 'in_channel', text: output('topic', { topic }) }); });
app.command('/roll', async ({ ack, command, client, respond }) => {
  await ack();
  if (!await allow(command, respond)) return;
  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: 'modal', callback_id: 'roll_dice', private_metadata: command.channel_id,
      title: { type: 'plain_text', text: 'ダイスロール' }, submit: { type: 'plain_text', text: '振る' }, close: { type: 'plain_text', text: 'キャンセル' },
      blocks: [
        { type: 'input', block_id: 'dice_type', label: { type: 'plain_text', text: 'ダイスの種類' }, element: { type: 'static_select', action_id: 'dice_type_select', initial_option: { text: { type: 'plain_text', text: 'd6（6面）' }, value: '6' }, options: [4, 6, 8, 10, 12, 20, 100].map((sides) => ({ text: { type: 'plain_text', text: `d${sides}（${sides}面）` }, value: String(sides) })) } },
        { type: 'input', block_id: 'dice_count', label: { type: 'plain_text', text: '個数' }, element: { type: 'static_select', action_id: 'dice_count_select', initial_option: { text: { type: 'plain_text', text: '1個' }, value: '1' }, options: Array.from({ length: 10 }, (_, index) => ({ text: { type: 'plain_text', text: `${index + 1}個` }, value: String(index + 1) })) } },
      ],
    },
  });
});
app.view('roll_dice', async ({ ack, body, view, client }) => {
  const sides = Number(view.state.values.dice_type.dice_type_select.selected_option.value);
  const dice = Number(view.state.values.dice_count.dice_count_select.selected_option.value);
  const values = Array.from({ length: dice }, () => Math.floor(Math.random() * sides) + 1);
  await ack();
  await client.chat.postMessage({ channel: view.private_metadata, text: output('roll', { user: `<@${body.user.id}>`, dice: `${dice}d${sides}`, values: values.join(' + '), total: values.reduce((a, b) => a + b, 0) }) });
});
function startRoulette(channel, choices, client) { const shown = (value) => value.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character])); return client.chat.postMessage({ channel, text: '🎰 ルーレットを回しています…', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `🎰 *ルーレット*\n${choices.map((x) => `• ${shown(x)}`).join('\n')}` } }, { type: 'section', text: { type: 'plain_text', text: '回転中…' } }] }).then((message) => { let step = 0; const interval = setInterval(async () => { const choice = choices[step++ % choices.length]; try { await client.chat.update({ channel, ts: message.ts, text: `🎰 ${choice}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `🎰 *ルーレット*\n${choices.map((x) => x === choice ? `👉 *${shown(x)}*` : `　${shown(x)}`).join('\n')}` } }, { type: 'section', text: { type: 'plain_text', text: '回転中…' } }] }); } catch (error) { clearInterval(interval); } }, 350); setTimeout(async () => { clearInterval(interval); const winner = choices[Math.floor(Math.random() * choices.length)]; const result = output('roulette', { winner: shown(winner), choices: choices.map(shown).join(' ・ ') }); try { await client.chat.update({ channel, ts: message.ts, text: result, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: result } }, { type: 'context', elements: [{ type: 'mrkdwn', text: `候補: ${choices.map(shown).join(' ・ ')}` }] }] }); } catch (error) { console.error('Roulette update failed', error); } }, 3500); }); }
app.command('/roulette', async ({ ack, command, client, respond }) => { await ack(); if (!await allow(command, respond)) return; await client.views.open({ trigger_id: command.trigger_id, view: { type: 'modal', callback_id: 'start_roulette', private_metadata: command.channel_id, title: { type: 'plain_text', text: 'ルーレット' }, submit: { type: 'plain_text', text: '回す' }, close: { type: 'plain_text', text: 'キャンセル' }, blocks: [{ type: 'input', block_id: 'roulette_choices', label: { type: 'plain_text', text: '候補（1行に1つ）' }, element: { type: 'plain_text_input', action_id: 'roulette_choices_input', multiline: true, placeholder: { type: 'plain_text', text: 'カレー\nラーメン\n寿司' } } }] } }); });
app.view('start_roulette', async ({ ack, view, client }) => { const choices = input(view, 'roulette_choices').split(/\r?\n/).map((value) => value.trim()).filter(Boolean); if (choices.length < 2 || choices.length > 10) return ack({ response_action: 'errors', errors: { roulette_choices: '候補を2〜10個、1行ずつ入力してください。' } }); await ack(); await startRoulette(view.private_metadata, choices, client); });

app.event('reaction_added', async ({ event }) => { if (!event.item?.channel) return; const key = `${event.item.channel}:${event.reaction}`; state.reactions[key] = (state.reactions[key] || 0) + 1; await saveState(); });
app.event('reaction_removed', async ({ event }) => { if (!event.item?.channel) return; const key = `${event.item.channel}:${event.reaction}`; state.reactions[key] = Math.max(0, (state.reactions[key] || 0) - 1); await saveState(); });
async function membership(event, kind, client) { if (event.user === botUserId) return; const setting = settingsByChannel[event.channel]; if (!setting) return; const text = (kind === 'join' ? setting.joinMessage : setting.leaveMessage).replaceAll('{user}', `<@${event.user}>`); await client.chat.postMessage({ channel: event.channel, text, ...(setting.username ? { username: setting.username } : {}), ...(setting.iconEmoji ? { icon_emoji: setting.iconEmoji } : {}), ...(setting.iconUrl ? { icon_url: setting.iconUrl } : {}) }); }
app.event('member_joined_channel', async ({ event, client }) => membership(event, 'join', client));
app.event('member_left_channel', async ({ event, client }) => membership(event, 'leave', client));
(async () => { await loadData(); const auth = await app.client.auth.test(); botUserId = auth.user_id; for (const reminder of state.reminders) schedule(reminder, app.client); if (socketMode) await app.start(); else await app.start(process.env.PORT || 3000); console.log(`Slack Bot started (${socketMode ? 'Socket Mode' : 'HTTP Mode'})`); })();
