const { App } = require('@slack/bolt');
const fs = require('node:fs/promises');
const path = require('node:path');

// Load credentials at runtime. This source code never logs their values.
// Node.js 20.6+ provides loadEnvFile, so no dotenv dependency is required.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// Values can also be supplied through the process environment supplied by the host.
// Socket Mode: SLACK_APP_TOKEN, SLACK_BOT_TOKEN, DEVELOPER_USER_IDS
// HTTP Mode:   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, DEVELOPER_USER_IDS
const socketMode = Boolean(process.env.SLACK_APP_TOKEN);
const required = [
  'SLACK_BOT_TOKEN',
  'DEVELOPER_USER_IDS',
  ...(socketMode ? ['SLACK_APP_TOKEN'] : ['SLACK_SIGNING_SECRET']),
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const developers = new Set(
  process.env.DEVELOPER_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean),
);
const settingsPath = path.join(__dirname, '.bot-data', 'channel-settings.json');
let settingsByChannel = {};
let botUserId;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  ...(socketMode
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : { signingSecret: process.env.SLACK_SIGNING_SECRET }),
});

async function loadSettings() {
  try {
    settingsByChannel = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    settingsByChannel = {};
  }
}

async function saveSettings() {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(settingsByChannel, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, settingsPath);
}

function isDeveloper(userId) {
  return developers.has(userId);
}

function textValue(view, blockId) {
  return view.state.values[blockId][`${blockId}_input`].value.trim();
}

function buildSettingsModal(channelId, current = {}) {
  const fields = [
    ['join_message', '入室メッセージ', current.joinMessage || '👋 {user} さんが入室しました'],
    ['leave_message', '退室メッセージ', current.leaveMessage || '👋 {user} さんが退室しました'],
    ['bot_name', 'Botの表示名（空欄なら標準名）', current.username || ''],
    [
      'icon',
      'Botアイコン（:emoji: または公開画像URL）',
      current.iconEmoji || current.iconUrl || '',
    ],
  ];

  return {
    type: 'modal',
    callback_id: 'save_channel_settings',
    private_metadata: channelId,
    title: { type: 'plain_text', text: '入退室メッセージ設定' },
    submit: { type: 'plain_text', text: '保存' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'このチャンネル専用の設定です。`{user}` は対象ユーザーへのメンションに置換されます。アイコンURLは、誰でも直接開ける公開HTTPS画像（PNG/JPEG/GIF）を指定してください。URLの代わりに `:smile:` のようなSlack絵文字も使えます。',
        },
      },
      ...fields.map(([id, label, initialValue]) => ({
        type: 'input',
        block_id: id,
        label: { type: 'plain_text', text: label },
        element: {
          type: 'plain_text_input',
          action_id: `${id}_input`,
          initial_value: initialValue,
        },
      })),
    ],
  };
}

app.command('/entry-settings', async ({ ack, command, client, respond }) => {
  await ack();
  if (!isDeveloper(command.user_id)) {
    await respond({ response_type: 'ephemeral', text: 'このコマンドは開発者のみ利用できます。' });
    return;
  }

  await client.views.open({
    trigger_id: command.trigger_id,
    view: buildSettingsModal(command.channel_id, settingsByChannel[command.channel_id]),
  });
});

app.view('save_channel_settings', async ({ ack, body, view, client }) => {
  if (!isDeveloper(body.user.id)) {
    await ack({ response_action: 'errors', errors: { join_message: '開発者のみ保存できます。' } });
    return;
  }

  const joinMessage = textValue(view, 'join_message');
  const leaveMessage = textValue(view, 'leave_message');
  const username = textValue(view, 'bot_name');
  const icon = textValue(view, 'icon');
  const errors = {};
  if (!joinMessage) errors.join_message = '入室メッセージを入力してください。';
  if (!leaveMessage) errors.leave_message = '退室メッセージを入力してください。';
  const isEmoji = /^:[a-z0-9_+\-]+:$/i.test(icon);
  const isHttpsUrl = /^https:\/\/[^\s]+$/i.test(icon);
  if (icon && !isEmoji && !isHttpsUrl) {
    errors.icon = '`:+1:` のような絵文字名、または公開HTTPS画像URLを入力してください。';
  }
  if (Object.keys(errors).length) {
    await ack({ response_action: 'errors', errors });
    return;
  }

  settingsByChannel[view.private_metadata] = {
    joinMessage,
    leaveMessage,
    username: username || undefined,
    iconEmoji: isEmoji ? icon : undefined,
    iconUrl: isHttpsUrl ? icon : undefined,
  };
  await saveSettings();
  await ack();
  await client.chat.postEphemeral({
    channel: view.private_metadata,
    user: body.user.id,
    text: 'このチャンネルの入退室メッセージ設定を保存しました。',
  });
});

async function postMembershipMessage(event, kind, client) {
  if (event.user === botUserId) return;
  const settings = settingsByChannel[event.channel];
  if (!settings) return;

  const template = kind === 'join' ? settings.joinMessage : settings.leaveMessage;
  const text = template.replaceAll('{user}', `<@${event.user}>`);
  await client.chat.postMessage({
    channel: event.channel,
    text,
    ...(settings.username ? { username: settings.username } : {}),
    ...(settings.iconEmoji ? { icon_emoji: settings.iconEmoji } : {}),
    ...(settings.iconUrl ? { icon_url: settings.iconUrl } : {}),
  });
}

app.event('member_joined_channel', async ({ event, client }) => {
  await postMembershipMessage(event, 'join', client);
});

app.event('member_left_channel', async ({ event, client }) => {
  await postMembershipMessage(event, 'leave', client);
});

(async () => {
  await loadSettings();
  const auth = await app.client.auth.test();
  botUserId = auth.user_id;
  if (socketMode) {
    await app.start();
  } else {
    await app.start(process.env.PORT || 3000);
  }
  console.log(`⚡ Slack 入退室Bot is running (${socketMode ? 'Socket Mode' : 'HTTP Mode'})`);
})();
