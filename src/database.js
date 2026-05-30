const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = path.resolve(__dirname, '..', 'bot_database.db');

let db = null;
let changeNotifier = null;

function getDb() {
  if (!db) {
    throw new Error('Database is not initialized');
  }

  return db;
}

function getDatabaseInstance() {
  return getDb().getDatabaseInstance();
}

function setDatabaseChangeNotifier(notifier) {
  changeNotifier = typeof notifier === 'function' ? notifier : null;
}

function notifyDatabaseChanged(reason) {
  if (typeof changeNotifier !== 'function') {
    return;
  }

  try {
    const result = changeNotifier(reason);
    if (result && typeof result.catch === 'function') {
      result.catch((error) => {
        console.error('DB 자동 백업 실패:', error);
      });
    }
  } catch (error) {
    console.error('DB 자동 백업 실패:', error);
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

async function migrateLegacySchema() {
  const database = getDb();

  await database.exec('DROP TABLE IF EXISTS licenses;');

  const settingsColumns = await database.all('PRAGMA table_info(settings)');
  if (!settingsColumns.some((column) => column.name === 'channel_prefix')) {
    await database.exec('ALTER TABLE settings ADD COLUMN channel_prefix TEXT;');
  }

  if (!settingsColumns.some((column) => column.name === 'channel_suffix')) {
    await database.exec('ALTER TABLE settings ADD COLUMN channel_suffix TEXT;');
  }

  const partnerColumns = await database.all('PRAGMA table_info(partners)');
  if (partnerColumns.some((column) => column.name === 'last_promo_at')) {
    await database.exec('ALTER TABLE partners DROP COLUMN last_promo_at;');
  }
}

async function initDatabase() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS installed_guilds (
      guild_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      min_members INTEGER,
      bot_ratio REAL,
      partner_name TEXT,
      log_channel_id TEXT,
      category_id TEXT,
      promo_message TEXT,
      channel_prefix TEXT,
      channel_suffix TEXT
    );

    CREATE TABLE IF NOT EXISTS partners (
      user_id TEXT,
      guild_id TEXT,
      invite_link TEXT,
      partner_name TEXT,
      webhook_url TEXT,
      channel_id TEXT,
      PRIMARY KEY (user_id, guild_id)
    );

    CREATE TABLE IF NOT EXISTS partner_statuses (
      guild_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      invite_link TEXT,
      server_id_input TEXT,
      log_channel_id TEXT,
      message_id TEXT,
      reason TEXT,
      applicant_user_id TEXT,
      applicant_tag TEXT,
      member_count INTEGER,
      bot_count INTEGER,
      bot_ratio REAL,
      updated_at TIMESTAMP
    );
  `);

  await migrateLegacySchema();

  return db;
}

async function syncInstalledGuild(guildId) {
  const database = getDb();
  await database.run('INSERT OR IGNORE INTO installed_guilds (guild_id) VALUES (?)', [guildId]);
  notifyDatabaseChanged('installed_guilds sync');
}

async function syncInstalledGuilds(guilds) {
  const tasks = [];

  for (const guild of guilds) {
    const guildId = typeof guild === 'string' ? guild : guild.id;
    if (guildId) {
      tasks.push(syncInstalledGuild(guildId));
    }
  }

  await Promise.all(tasks);
}

async function removeInstalledGuild(guildId) {
  const database = getDb();
  await database.run('DELETE FROM installed_guilds WHERE guild_id = ?', [guildId]);
  notifyDatabaseChanged('installed_guilds remove');
}

async function getInstalledGuild(guildId) {
  const database = getDb();
  return database.get('SELECT guild_id FROM installed_guilds WHERE guild_id = ?', [guildId]);
}

async function listInstalledGuildIds() {
  const database = getDb();
  const rows = await database.all('SELECT guild_id FROM installed_guilds ORDER BY guild_id');
  return rows.map((row) => row.guild_id);
}

async function pruneMissingInstalledGuilds(validGuildIds) {
  const database = getDb();
  const ids = [...validGuildIds];

  if (ids.length === 0) {
    await database.run('DELETE FROM installed_guilds');
    notifyDatabaseChanged('installed_guilds prune');
    return;
  }

  const placeholders = ids.map(() => '?').join(', ');
  await database.run(`DELETE FROM installed_guilds WHERE guild_id NOT IN (${placeholders})`, ids);
  notifyDatabaseChanged('installed_guilds prune');
}

async function getSettings(guildId) {
  const database = getDb();
  return database.get('SELECT * FROM settings WHERE guild_id = ?', [guildId]);
}

async function upsertSettings(guildId, data) {
  const database = getDb();
  const current = await getSettings(guildId);

  const minMembers = hasOwn(data, 'minMembers') ? data.minMembers : current?.min_members ?? null;
  const botRatio = hasOwn(data, 'botRatio') ? data.botRatio : current?.bot_ratio ?? null;
  const partnerName = hasOwn(data, 'partnerName') ? data.partnerName : current?.partner_name ?? null;
  const logChannelId = hasOwn(data, 'logChannelId') ? data.logChannelId : current?.log_channel_id ?? null;
  const categoryId = hasOwn(data, 'categoryId') ? data.categoryId : current?.category_id ?? null;
  const promoMessage = hasOwn(data, 'promoMessage') ? data.promoMessage : current?.promo_message ?? null;
  const channelPrefix = hasOwn(data, 'channelPrefix') ? data.channelPrefix : current?.channel_prefix ?? null;
  const channelSuffix = hasOwn(data, 'channelSuffix') ? data.channelSuffix : current?.channel_suffix ?? null;

  await database.run(
    `
      INSERT OR REPLACE INTO settings (
        guild_id,
        min_members,
        bot_ratio,
        partner_name,
        log_channel_id,
        category_id,
        promo_message,
        channel_prefix,
        channel_suffix
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      guildId,
      minMembers,
      botRatio,
      partnerName,
      logChannelId,
      categoryId,
      promoMessage,
      channelPrefix,
      channelSuffix,
    ],
  );

  notifyDatabaseChanged('settings upsert');
}

async function savePartnerApplication({ userId, guildId, inviteLink }) {
  const database = getDb();

  await database.run(
    `
      INSERT INTO partners (user_id, guild_id, invite_link)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        invite_link = excluded.invite_link
    `,
    [userId, guildId, inviteLink],
  );

  notifyDatabaseChanged('partner application save');
}

async function savePartnerWebhook({ userId, guildId, partnerName, webhookUrl, channelId }) {
  const database = getDb();

  await database.run(
    `
      INSERT INTO partners (user_id, guild_id, partner_name, webhook_url, channel_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        partner_name = excluded.partner_name,
        webhook_url = excluded.webhook_url,
        channel_id = excluded.channel_id
    `,
    [userId, guildId, partnerName, webhookUrl, channelId],
  );

  notifyDatabaseChanged('partner webhook save');
}

async function getPartnerApplication(userId, guildId) {
  const database = getDb();
  return database.get('SELECT * FROM partners WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
}

async function getPartnerByChannelId(channelId) {
  const database = getDb();
  return database.get('SELECT * FROM partners WHERE channel_id = ?', [channelId]);
}

async function listPartnersByGuild(guildId) {
  const database = getDb();
  return database.all(
    'SELECT * FROM partners WHERE guild_id = ? AND channel_id IS NOT NULL ORDER BY user_id',
    [guildId],
  );
}

async function listActivePromotions() {
  const database = getDb();
  return database.all(
    `
      SELECT p.webhook_url, s.promo_message, p.guild_id
      FROM partners p
      JOIN settings s ON p.guild_id = s.guild_id
      JOIN installed_guilds g ON p.guild_id = g.guild_id
      WHERE p.webhook_url IS NOT NULL AND s.promo_message IS NOT NULL
    `,
  );
}

async function getPartnerStatus(guildId) {
  const database = getDb();
  return database.get('SELECT * FROM partner_statuses WHERE guild_id = ?', [guildId]);
}

async function savePartnerStatus(guildId, patch = {}) {
  const database = getDb();
  const current = await getPartnerStatus(guildId);

  const next = {
    guild_id: guildId,
    status: hasOwn(patch, 'status') ? patch.status : current?.status ?? 'pending',
    invite_link: hasOwn(patch, 'invite_link') ? patch.invite_link : current?.invite_link ?? null,
    server_id_input: hasOwn(patch, 'server_id_input') ? patch.server_id_input : current?.server_id_input ?? null,
    log_channel_id: hasOwn(patch, 'log_channel_id') ? patch.log_channel_id : current?.log_channel_id ?? null,
    message_id: hasOwn(patch, 'message_id') ? patch.message_id : current?.message_id ?? null,
    reason: hasOwn(patch, 'reason') ? patch.reason : current?.reason ?? null,
    applicant_user_id: hasOwn(patch, 'applicant_user_id') ? patch.applicant_user_id : current?.applicant_user_id ?? null,
    applicant_tag: hasOwn(patch, 'applicant_tag') ? patch.applicant_tag : current?.applicant_tag ?? null,
    member_count: hasOwn(patch, 'member_count') ? patch.member_count : current?.member_count ?? null,
    bot_count: hasOwn(patch, 'bot_count') ? patch.bot_count : current?.bot_count ?? null,
    bot_ratio: hasOwn(patch, 'bot_ratio') ? patch.bot_ratio : current?.bot_ratio ?? null,
    updated_at: new Date().toISOString(),
  };

  await database.run(
    `
      INSERT OR REPLACE INTO partner_statuses (
        guild_id,
        status,
        invite_link,
        server_id_input,
        log_channel_id,
        message_id,
        reason,
        applicant_user_id,
        applicant_tag,
        member_count,
        bot_count,
        bot_ratio,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      next.guild_id,
      next.status,
      next.invite_link,
      next.server_id_input,
      next.log_channel_id,
      next.message_id,
      next.reason,
      next.applicant_user_id,
      next.applicant_tag,
      next.member_count,
      next.bot_count,
      next.bot_ratio,
      next.updated_at,
    ],
  );

  notifyDatabaseChanged('partner status save');

  return next;
}

async function deletePartnerStatus(guildId) {
  const database = getDb();
  await database.run('DELETE FROM partner_statuses WHERE guild_id = ?', [guildId]);
  notifyDatabaseChanged('partner status delete');
}

async function pruneMissingPartnerStatuses(validGuildIds) {
  const database = getDb();
  const ids = [...validGuildIds];

  if (ids.length === 0) {
    await database.run('DELETE FROM partner_statuses');
    notifyDatabaseChanged('partner status prune');
    return;
  }

  const placeholders = ids.map(() => '?').join(', ');
  await database.run(`DELETE FROM partner_statuses WHERE guild_id NOT IN (${placeholders})`, ids);
  notifyDatabaseChanged('partner status prune');
}

module.exports = {
  DB_PATH,
  initDatabase,
  getDatabaseInstance,
  setDatabaseChangeNotifier,
  syncInstalledGuild,
  syncInstalledGuilds,
  removeInstalledGuild,
  getInstalledGuild,
  listInstalledGuildIds,
  pruneMissingInstalledGuilds,
  getSettings,
  upsertSettings,
  savePartnerApplication,
  savePartnerWebhook,
  getPartnerApplication,
  getPartnerByChannelId,
  listPartnersByGuild,
  listActivePromotions,
  getPartnerStatus,
  savePartnerStatus,
  deletePartnerStatus,
  pruneMissingPartnerStatuses,
};
