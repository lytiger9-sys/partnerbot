const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');

const { DB_PATH, getDatabaseInstance } = require('./database');

const BACKUP_FILENAME = path.basename(DB_PATH);
const SQLITE_SIDE_CAR_SUFFIXES = ['-wal', '-shm', '-journal'];

function isBackupAttachment(attachment) {
  return String(attachment?.name || '').toLowerCase() === BACKUP_FILENAME.toLowerCase();
}

async function removeSqliteSideCars(dbPath) {
  await Promise.all(
    SQLITE_SIDE_CAR_SUFFIXES.map((suffix) =>
      fs.unlink(`${dbPath}${suffix}`).catch(() => null),
    ),
  );
}

async function createSqliteBackupSnapshot(destinationPath, sourceDatabase = getDatabaseInstance()) {
  await new Promise((resolve, reject) => {
    let backup;

    const stepBackup = () => {
      backup.step(-1, (stepError, completed) => {
        if (stepError) {
          reject(stepError);
          return;
        }

        if (completed) {
          resolve();
          return;
        }

        stepBackup();
      });
    };

    try {
      backup = sourceDatabase.backup(destinationPath, (initError) => {
        if (initError) {
          reject(initError);
          return;
        }

        try {
          stepBackup();
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function createSnapshotFile(dbPath = DB_PATH) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-bot-db-'));
  const snapshotPath = path.join(tempDirectory, path.basename(dbPath));

  await createSqliteBackupSnapshot(snapshotPath);

  return {
    snapshotPath,
    tempDirectory,
    cleanup: async () => {
      await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => null);
    },
  };
}

async function findLatestDatabaseBackupAttachment(channel, { maxPages = 50 } = {}) {
  let before = null;

  for (let page = 0; page < maxPages; page += 1) {
    const messages = await channel.messages.fetch(
      before ? { limit: 100, before } : { limit: 100 },
    ).catch(() => null);

    if (!messages || messages.size === 0) {
      return null;
    }

    const orderedMessages = [...messages.values()].sort(
      (left, right) => right.createdTimestamp - left.createdTimestamp,
    );

    for (const message of orderedMessages) {
      const attachment = [...message.attachments.values()].find(isBackupAttachment);
      if (attachment) {
        return {
          message,
          attachment,
        };
      }
    }

    const oldestMessage = orderedMessages[orderedMessages.length - 1];
    if (!oldestMessage || messages.size < 100) {
      return null;
    }

    before = oldestMessage.id;
  }

  return null;
}

async function restoreDatabaseBackupFromDiscord({
  client,
  channelId,
  dbPath = DB_PATH,
  force = false,
  logger = console,
} = {}) {
  const currentFileStats = await fs.stat(dbPath).catch(() => null);
  if (!force && currentFileStats && currentFileStats.size > 0) {
    return {
      restored: false,
      reason: 'local-database-present',
    };
  }

  if (!channelId) {
    logger.warn('DB 백업 채널 ID가 설정되지 않아 시작 시 복원을 건너뜁니다.');
    return {
      restored: false,
      reason: 'missing-backup-channel-id',
    };
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
    logger.warn(`DB 백업 채널을 찾지 못했습니다: ${channelId}`);
    return {
      restored: false,
      reason: 'backup-channel-unavailable',
    };
  }

  const latestBackup = await findLatestDatabaseBackupAttachment(channel);
  if (!latestBackup) {
    logger.warn('DB 백업 파일을 백업 채널에서 찾지 못했습니다.');
    return {
      restored: false,
      reason: 'backup-file-not-found',
    };
  }

  const response = await fetch(latestBackup.attachment.url);
  if (!response.ok) {
    throw new Error(`DB 백업 다운로드 실패: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('다운로드한 DB 백업이 비어 있습니다.');
  }

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  if (force) {
    await fs.unlink(dbPath).catch(() => null);
    await removeSqliteSideCars(dbPath);
  }

  await fs.writeFile(dbPath, buffer);

  logger.log(`DB 백업 복원 완료: ${latestBackup.message.id}`);

  return {
    restored: true,
    messageId: latestBackup.message.id,
    attachmentName: latestBackup.attachment.name,
  };
}

function createDatabaseBackupManager({
  client,
  channelId,
  dbPath = DB_PATH,
  logger = console,
} = {}) {
  let activeRun = null;
  let pending = false;
  let latestReason = 'db-change';

  async function sendBackupOnce(reason) {
    const snapshot = await createSnapshotFile(dbPath);
    const backupFilename = path.basename(dbPath);

    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
        throw new Error(`DB 백업 채널을 사용할 수 없습니다: ${channelId}`);
      }

      const attachment = new AttachmentBuilder(snapshot.snapshotPath, {
        name: backupFilename,
      });

      await channel.send({
        content: `DB 백업 전송: ${reason}`,
        files: [attachment],
      });
    } finally {
      await snapshot.cleanup();
    }
  }

  async function drainQueue() {
    let lastError = null;

    try {
      while (pending) {
        pending = false;
        const reason = latestReason;
        latestReason = 'db-change';

        try {
          await sendBackupOnce(reason);
        } catch (error) {
          lastError = error;
          logger.error('DB 백업 전송 실패:', error);
        }
      }
    } finally {
      activeRun = null;
    }

    if (lastError) {
      throw lastError;
    }
  }

  function requestBackup(reason = 'db-change') {
    latestReason = reason;
    pending = true;

    if (!activeRun) {
      activeRun = drainQueue();
    }

    return activeRun;
  }

  return {
    requestBackup,
  };
}

module.exports = {
  BACKUP_FILENAME,
  createDatabaseBackupManager,
  restoreDatabaseBackupFromDiscord,
};
