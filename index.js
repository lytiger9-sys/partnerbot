const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const cron = require('node-cron');
require('dotenv').config();

const {
  initDatabase,
  DB_PATH,
  setDatabaseChangeNotifier,
  syncInstalledGuild,
  syncInstalledGuilds,
  removeInstalledGuild,
  getInstalledGuild,
  getSettings,
  upsertSettings,
  savePartnerApplication,
  savePartnerWebhook,
  getPartnerApplication,
  getPartnerByChannelId,
  listPartnersByGuild,
  listActivePromotions,
  savePartnerStatus,
  deletePartnerStatus,
  pruneMissingInstalledGuilds,
  pruneMissingPartnerStatuses,
} = require('./src/database');
const {
  buildPartnerGuideEmbed,
  buildPartnerStatusEmbed,
} = require('./src/embeds');
const {
  buildPartnerChannelName,
} = require('./src/channel-names');
const {
  createDatabaseBackupManager,
  restoreDatabaseBackupFromDiscord,
} = require('./src/db-backup');

const TOKEN = process.env.DISCORD_TOKEN;
const BOT_INVITE_URL = process.env.BOT_INVITE_URL || '';
const DB_BACKUP_CHANNEL_ID = process.env.DB_BACKUP_CHANNEL_ID || '1510067772804169849';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
  ],
});

let databaseBackupManager = null;

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function botInviteMessage() {
  if (BOT_INVITE_URL) {
    return `봇이 아직 설치되어 있지 않습니다. 먼저 초대해 주세요: [봇 초대 링크](${BOT_INVITE_URL})`;
  }

  return '봇이 아직 설치되어 있지 않습니다. 관리자에게 봇 초대를 요청하세요.';
}

async function ensureGuildTracked(guildId) {
  const installed = await getInstalledGuild(guildId);
  if (installed) {
    return true;
  }

  if (client.guilds.cache.has(guildId)) {
    await syncInstalledGuild(guildId);
    return true;
  }

  return false;
}

function hasCoreSettings(settings) {
  return Boolean(
    settings
    && settings.min_members !== null
    && settings.min_members !== undefined
    && settings.bot_ratio !== null
    && settings.bot_ratio !== undefined
    && settings.partner_name
    && settings.log_channel_id
    && settings.category_id,
  );
}

function hasPromoSettings(settings) {
  return Boolean(hasCoreSettings(settings) && settings.promo_message && String(settings.promo_message).trim());
}

async function getGuildStats(guild) {
  const members = await guild.members.fetch();
  const memberCount = members.size;
  const botCount = members.filter((member) => member.user.bot).size;
  const botRatio = memberCount > 0 ? botCount / memberCount : 0;

  return {
    memberCount,
    botCount,
    botRatio,
  };
}

async function updatePartnerStatusMessage(guild, patch, settingsOverride = null) {
  try {
    const settings = settingsOverride ?? await getSettings(guild.id);
    if (!settings?.log_channel_id) {
      return null;
    }

    const { channelMention, ...storagePatch } = patch;
    const saved = await savePartnerStatus(guild.id, {
      ...storagePatch,
      log_channel_id: settings.log_channel_id,
    });

    const logChannel = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) {
      console.warn(`Unable to fetch log channel for guild ${guild.id}`);
      return null;
    }

    const embed = buildPartnerStatusEmbed({
      guildName: guild.name,
      guildId: guild.id,
      guildIconUrl: typeof guild.iconURL === 'function' ? guild.iconURL({ size: 128 }) : null,
      status: saved.status,
      inviteLink: saved.invite_link,
      serverIdInput: saved.server_id_input,
      applicantTag: saved.applicant_tag,
      memberCount: saved.member_count,
      botCount: saved.bot_count,
      botRatio: saved.bot_ratio,
      minMembers: Number(settings.min_members ?? 0),
      botRatioLimit: Number(settings.bot_ratio ?? 0),
      reason: saved.reason,
      channelMention,
    });

    let existingMessage = null;
    if (saved.message_id) {
      existingMessage = await logChannel.messages.fetch(saved.message_id).catch(() => null);
    }

    if (existingMessage) {
      await existingMessage.edit({ embeds: [embed] });
      return existingMessage;
    }

    const sent = await logChannel.send({ embeds: [embed] });
    await savePartnerStatus(guild.id, {
      message_id: sent.id,
      log_channel_id: settings.log_channel_id,
    });
    return sent;
  } catch (error) {
    console.error(`Failed to update partner status for ${guild.id}:`, error);
    return null;
  }
}

async function logFailureAndReply(interaction, settings, patch, replyText) {
  await updatePartnerStatusMessage(interaction.guild, {
    status: 'failure',
    ...patch,
  }, settings);

  return interaction.reply({
    content: replyText,
    ephemeral: true,
  });
}

async function syncExistingPartnerChannelNames(guild, settings = null) {
  const currentSettings = settings ?? await getSettings(guild.id);
  if (!currentSettings) {
    return { renamed: 0, failed: 0 };
  }

  const partners = await listPartnersByGuild(guild.id);
  let renamed = 0;
  let failed = 0;

  for (const partner of partners) {
    if (!partner.partner_name || !partner.channel_id) {
      continue;
    }

    const channel = await guild.channels.fetch(partner.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased() || typeof channel.setName !== 'function') {
      continue;
    }

    const desiredName = buildPartnerChannelName(
      partner.partner_name,
      currentSettings.channel_prefix,
      currentSettings.channel_suffix,
    );

    if (channel.name === desiredName) {
      continue;
    }

    try {
      await channel.setName(desiredName);
      renamed += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Failed to rename partner channel ${partner.channel_id} in guild ${guild.id}:`, error);
    }
  }

  return { renamed, failed };
}

async function registerSlashCommands() {
  const commands = [
    {
      name: '설정',
      description: '파트너 조건과 로그 채널을 설정합니다.',
      default_member_permissions: PermissionFlagsBits.Administrator.toString(),
      dm_permission: false,
    },
    {
      name: '홍보글설정',
      description: '현재 채널의 가장 오래된 일반 메시지를 홍보글로 저장합니다.',
      default_member_permissions: PermissionFlagsBits.Administrator.toString(),
      dm_permission: false,
    },
    {
      name: '채널명설정',
      description: '파트너 채널의 앞/뒤 문구를 설정합니다.',
      default_member_permissions: PermissionFlagsBits.Administrator.toString(),
      dm_permission: false,
    },
    {
      name: '임베드게시',
      description: '파트너 신청 안내 임베드를 게시합니다.',
      default_member_permissions: PermissionFlagsBits.Administrator.toString(),
      dm_permission: false,
    },
    {
      name: 'db백업',
      description: '현재 DB 파일을 백업 채널로 전송합니다.',
      default_member_permissions: PermissionFlagsBits.Administrator.toString(),
      dm_permission: false,
    },
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
}

async function handleSetupCommand(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('modal_setup')
    .setTitle('서버 파트너 설정');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('min_members')
        .setLabel('최소 인원 수')
        .setPlaceholder('예: 100')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('bot_ratio')
        .setLabel('최대 봇 비율 (0~1)')
        .setPlaceholder('예: 0.25')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('partner_name')
        .setLabel('제휴명')
        .setPlaceholder('예: 파트너 채널 이름')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('log_channel')
        .setLabel('로그 채널 ID')
        .setPlaceholder('예: 123456789012345678')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('category')
        .setLabel('파트너 카테고리 ID')
        .setPlaceholder('예: 123456789012345678')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
  );

  return interaction.showModal(modal);
}

async function handleChannelNameCommand(interaction) {
  const settings = await getSettings(interaction.guildId);
  const modal = new ModalBuilder()
    .setCustomId('modal_channel_name')
    .setTitle('채널명 설정');

  const prefixInput = new TextInputBuilder()
    .setCustomId('channel_prefix')
    .setLabel('채널명 앞 문구')
    .setPlaceholder('예: ✨-')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const suffixInput = new TextInputBuilder()
    .setCustomId('channel_suffix')
    .setLabel('채널명 뒤 문구')
    .setPlaceholder('예: -파트너')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  if (settings?.channel_prefix) {
    prefixInput.setValue(settings.channel_prefix);
  }

  if (settings?.channel_suffix) {
    suffixInput.setValue(settings.channel_suffix);
  }

  modal.addComponents(
    new ActionRowBuilder().addComponents(prefixInput),
    new ActionRowBuilder().addComponents(suffixInput),
  );

  return interaction.showModal(modal);
}

async function handlePromoSettingCommand(interaction) {
  const settings = await getSettings(interaction.guildId);
  if (!hasCoreSettings(settings)) {
    return interaction.reply({
      content: '먼저 `/설정`을 완료해주세요.',
      ephemeral: true,
    });
  }

  const messages = await interaction.channel.messages.fetch({ limit: 100 });
  const sourceMessage = messages
    .filter((message) => !message.author.bot && String(message.content || '').trim())
    .last();

  if (!sourceMessage) {
    return interaction.reply({
      content: '홍보글로 사용할 일반 메시지를 찾을 수 없습니다.',
      ephemeral: true,
    });
  }

  await upsertSettings(interaction.guildId, {
    minMembers: settings.min_members,
    botRatio: settings.bot_ratio,
    partnerName: settings.partner_name,
    logChannelId: settings.log_channel_id,
    categoryId: settings.category_id,
    promoMessage: sourceMessage.content,
  });

  return interaction.reply({
    content: '현재 채널의 가장 오래된 일반 메시지를 홍보글로 설정했습니다.',
    ephemeral: true,
  });
}

async function handleGuidePostCommand(interaction) {
  const settings = await getSettings(interaction.guildId);
  if (!hasCoreSettings(settings)) {
    return interaction.reply({
      content: '먼저 `/설정`을 완료해주세요.',
      ephemeral: true,
    });
  }

  const embed = buildPartnerGuideEmbed({
    guildName: interaction.guild.name,
    guildIconUrl: interaction.guild.iconURL({ size: 128 }),
    minMembers: Number(settings.min_members ?? 0),
    botRatioLimit: Number(settings.bot_ratio ?? 0),
    partnerName: settings.partner_name,
    channelPrefix: settings.channel_prefix,
    channelSuffix: settings.channel_suffix,
    botInviteUrl: BOT_INVITE_URL,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_apply')
      .setLabel('파트너 신청')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('btn_webhook')
      .setLabel('웹훅 입력')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.channel.send({
    embeds: [embed],
    components: [row],
  });

  return interaction.reply({
    content: '파트너 신청 안내 임베드를 게시했습니다.',
    ephemeral: true,
  });
}

async function handleDatabaseBackupCommand(interaction) {
  if (!databaseBackupManager) {
    return interaction.reply({
      content: 'DB 백업 기능이 아직 초기화되지 않았습니다.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await databaseBackupManager.requestBackup('manual /db백업');
    return interaction.editReply({
      content: 'DB 백업 파일을 백업 채널로 전송했습니다.',
    });
  } catch (error) {
    console.error('DB 백업 명령 처리 실패:', error);

    return interaction.editReply({
      content: 'DB 백업 파일 전송에 실패했습니다.',
    });
  }
}

async function handleSetupModal(interaction) {
  const minMembers = Number.parseInt(interaction.fields.getTextInputValue('min_members').trim(), 10);
  const botRatio = Number.parseFloat(interaction.fields.getTextInputValue('bot_ratio').trim());
  const partnerName = interaction.fields.getTextInputValue('partner_name').trim();
  const logChannelId = interaction.fields.getTextInputValue('log_channel').trim();
  const categoryId = interaction.fields.getTextInputValue('category').trim();

  if (!Number.isInteger(minMembers) || minMembers < 0) {
    return interaction.reply({
      content: '최소 인원 수는 0 이상의 정수여야 합니다.',
      ephemeral: true,
    });
  }

  if (!Number.isFinite(botRatio) || botRatio < 0 || botRatio > 1) {
    return interaction.reply({
      content: '봇 비율은 0 이상 1 이하의 숫자여야 합니다.',
      ephemeral: true,
    });
  }

  if (!partnerName) {
    return interaction.reply({
      content: '제휴명은 비워둘 수 없습니다.',
      ephemeral: true,
    });
  }

  const logChannel = await interaction.guild.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) {
    return interaction.reply({
      content: '로그 채널 ID가 올바르지 않거나 텍스트 채널이 아닙니다.',
      ephemeral: true,
    });
  }

  const category = await interaction.guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    return interaction.reply({
      content: '파트너 카테고리 ID가 올바르지 않거나 카테고리 채널이 아닙니다.',
      ephemeral: true,
    });
  }

  const current = await getSettings(interaction.guildId);
  await upsertSettings(interaction.guildId, {
    minMembers,
    botRatio,
    partnerName,
    logChannelId,
    categoryId,
    promoMessage: current?.promo_message ?? null,
  });

  return interaction.reply({
    content: '서버 설정이 완료되었습니다. 채널명 앞/뒤는 `/채널명설정`에서 따로 바꿀 수 있습니다.',
    ephemeral: true,
  });
}

async function handleChannelNameModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const channelPrefixInput = interaction.fields.getTextInputValue('channel_prefix').trim();
    const channelSuffixInput = interaction.fields.getTextInputValue('channel_suffix').trim();

    await upsertSettings(interaction.guildId, {
      channelPrefix: channelPrefixInput || null,
      channelSuffix: channelSuffixInput || null,
    });

    const updatedSettings = await getSettings(interaction.guildId);
    const { renamed, failed } = await syncExistingPartnerChannelNames(interaction.guild, updatedSettings);

    const replyParts = ['채널명 장식이 저장되었습니다.'];
    if (renamed > 0) {
      replyParts.push(`${renamed}개 기존 파트너 채널 이름을 갱신했습니다.`);
    }
    if (failed > 0) {
      replyParts.push(`${failed}개 채널은 이름 갱신에 실패했습니다.`);
    }

    return interaction.editReply({
      content: replyParts.join(' '),
    });
  } catch (error) {
    console.error('채널명 설정 처리 중 오류:', error);

    return interaction.editReply({
      content: '채널명 설정 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
    });
  }
}

async function handleApplyButton(interaction) {
  const settings = await getSettings(interaction.guildId);
  if (!hasCoreSettings(settings)) {
    return interaction.reply({
      content: '먼저 `/설정`을 완료해주세요.',
      ephemeral: true,
    });
  }

  const tracked = await ensureGuildTracked(interaction.guildId);
  if (!tracked) {
    return interaction.reply({
      content: botInviteMessage(),
      ephemeral: true,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId('modal_apply')
    .setTitle('파트너 신청');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('server_id')
        .setLabel('서버 ID')
        .setPlaceholder(interaction.guildId)
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('invite_link')
        .setLabel('초대 링크')
        .setPlaceholder('https://discord.gg/...')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
  );

  return interaction.showModal(modal);
}

async function handleWebhookButton(interaction) {
  const settings = await getSettings(interaction.guildId);
  if (!hasCoreSettings(settings)) {
    return interaction.reply({
      content: '먼저 `/설정`을 완료해주세요.',
      ephemeral: true,
    });
  }

  if (!settings.promo_message) {
    return interaction.reply({
      content: '먼저 `/홍보글설정`을 완료해주세요.',
      ephemeral: true,
    });
  }

  const tracked = await ensureGuildTracked(interaction.guildId);
  if (!tracked) {
    return interaction.reply({
      content: botInviteMessage(),
      ephemeral: true,
    });
  }

  const partner = await getPartnerApplication(interaction.user.id, interaction.guildId);
  if (!partner) {
    return interaction.reply({
      content: '먼저 파트너 신청/조건을 완료해주세요.',
      ephemeral: true,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId('modal_webhook')
    .setTitle('웹훅 및 제휴명 입력');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('p_name')
        .setLabel('자신의 서버 제휴명')
        .setPlaceholder('예: 홍보 채널')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('webhook_url')
        .setLabel('웹훅 URL')
        .setPlaceholder('https://discord.com/api/webhooks/...')
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
  );

  return interaction.showModal(modal);
}

async function handleApplyModal(interaction) {
  const settings = await getSettings(interaction.guildId);
  if (!hasCoreSettings(settings)) {
    return interaction.reply({
      content: '먼저 `/설정`을 완료해주세요.',
      ephemeral: true,
    });
  }

  const tracked = await ensureGuildTracked(interaction.guildId);
  if (!tracked) {
    return interaction.reply({
      content: botInviteMessage(),
      ephemeral: true,
    });
  }

  const serverIdInput = interaction.fields.getTextInputValue('server_id').trim();
  const inviteLink = interaction.fields.getTextInputValue('invite_link').trim();

  if (!/^\d{17,20}$/.test(serverIdInput)) {
    return logFailureAndReply(
      interaction,
      settings,
      {
        invite_link: inviteLink,
        server_id_input: serverIdInput,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        reason: '서버 ID 형식이 올바르지 않습니다.',
      },
      '❌ 서버 ID 형식이 올바르지 않습니다.',
    );
  }

  if (serverIdInput !== interaction.guildId) {
    return logFailureAndReply(
      interaction,
      settings,
      {
        invite_link: inviteLink,
        server_id_input: serverIdInput,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        reason: '입력한 서버 ID가 현재 서버와 일치하지 않습니다.',
      },
      '❌ 입력한 서버 ID가 현재 서버와 일치하지 않습니다.',
    );
  }

  let invite;
  try {
    invite = await client.fetchInvite(inviteLink, { withCounts: true });
  } catch (error) {
    return logFailureAndReply(
      interaction,
      settings,
      {
        invite_link: inviteLink,
        server_id_input: serverIdInput,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        reason: '유효하지 않은 초대 링크입니다.',
      },
      '❌ 유효하지 않은 초대 링크입니다.',
    );
  }

  const inviteGuildId = invite.guild?.id ?? null;
  if (!inviteGuildId || inviteGuildId !== interaction.guildId) {
    return logFailureAndReply(
      interaction,
      settings,
      {
        invite_link: inviteLink,
        server_id_input: serverIdInput,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        reason: '초대 링크의 서버와 입력한 서버 ID가 일치하지 않습니다.',
      },
      '❌ 초대 링크의 서버와 입력한 서버 ID가 일치하지 않습니다.',
    );
  }

  let stats;
  try {
    stats = await getGuildStats(interaction.guild);
  } catch (error) {
    return logFailureAndReply(
      interaction,
      settings,
      {
        invite_link: inviteLink,
        server_id_input: serverIdInput,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        reason: '서버 멤버 정보를 불러오지 못했습니다.',
      },
      '❌ 서버 멤버 정보를 불러오지 못했습니다.',
    );
  }

  const minMembers = Number(settings.min_members ?? 0);
  const maxBotRatio = Number(settings.bot_ratio ?? 0);

  if (stats.memberCount < minMembers) {
    return logFailureAndReply(
      interaction,
      settings,
      {
        invite_link: inviteLink,
        server_id_input: serverIdInput,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        member_count: stats.memberCount,
        bot_count: stats.botCount,
        bot_ratio: stats.botRatio,
        reason: `최소 인원 조건 미달입니다. 현재 ${stats.memberCount}명, 기준 ${minMembers}명입니다.`,
      },
      `❌ 최소 인원 조건 미달입니다. 현재 ${stats.memberCount}명, 기준 ${minMembers}명입니다.`,
    );
  }

  if (Number.isFinite(maxBotRatio) && stats.botRatio > maxBotRatio) {
    const currentPercent = (stats.botRatio * 100).toFixed(2);
    const limitPercent = (maxBotRatio * 100).toFixed(2);

    return logFailureAndReply(
      interaction,
      settings,
      {
        invite_link: inviteLink,
        server_id_input: serverIdInput,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        member_count: stats.memberCount,
        bot_count: stats.botCount,
        bot_ratio: stats.botRatio,
        reason: `봇 비율 초과입니다. 현재 ${currentPercent}%, 기준 ${limitPercent}%입니다.`,
      },
      `❌ 봇 비율 초과입니다. 현재 ${currentPercent}%, 기준 ${limitPercent}%입니다.`,
    );
  }

  await savePartnerApplication({
    userId: interaction.user.id,
    guildId: interaction.guildId,
    inviteLink,
  });

  await updatePartnerStatusMessage(interaction.guild, {
    status: 'pending',
    invite_link: inviteLink,
    server_id_input: serverIdInput,
    applicant_user_id: interaction.user.id,
    applicant_tag: interaction.user.tag,
    member_count: stats.memberCount,
    bot_count: stats.botCount,
    bot_ratio: stats.botRatio,
    reason: '웹훅 입력 대기중',
  }, settings);

  return interaction.reply({
    content: '✅ 조건 확인 완료. 이제 **웹훅 입력** 버튼을 눌러주세요.',
    ephemeral: true,
  });
}

async function handleWebhookModal(interaction) {
  const settings = await getSettings(interaction.guildId);
  if (!hasPromoSettings(settings)) {
    return interaction.reply({
      content: '먼저 `/설정`과 `/홍보글설정`을 완료해주세요.',
      ephemeral: true,
    });
  }

  const tracked = await ensureGuildTracked(interaction.guildId);
  if (!tracked) {
    return interaction.reply({
      content: botInviteMessage(),
      ephemeral: true,
    });
  }

  const partner = await getPartnerApplication(interaction.user.id, interaction.guildId);
  if (!partner) {
    return interaction.reply({
      content: '먼저 파트너 신청/조건을 완료해주세요.',
      ephemeral: true,
    });
  }

  const partnerNameInput = interaction.fields.getTextInputValue('p_name').trim();
  const webhookUrl = interaction.fields.getTextInputValue('webhook_url').trim();
  const channelName = buildPartnerChannelName(
    partnerNameInput,
    settings.channel_prefix,
    settings.channel_suffix,
  );

  if (!partnerNameInput) {
    return interaction.reply({
      content: '제휴명은 비워둘 수 없습니다.',
      ephemeral: true,
    });
  }

  if (!webhookUrl) {
    return interaction.reply({
      content: '웹훅 URL은 비워둘 수 없습니다.',
      ephemeral: true,
    });
  }

  let testResponse;
  try {
    testResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: settings.promo_message,
        username: interaction.guild.name,
      }),
    });
  } catch (error) {
    await updatePartnerStatusMessage(interaction.guild, {
      status: 'failure',
      invite_link: partner.invite_link,
      server_id_input: interaction.guildId,
      applicant_user_id: interaction.user.id,
      applicant_tag: interaction.user.tag,
      reason: '웹훅 전송에 실패했습니다.',
    }, settings);

    return interaction.reply({
      content: '❌ 웹훅 전송에 실패했습니다. URL을 다시 확인해주세요.',
      ephemeral: true,
    });
  }

  if (!testResponse.ok) {
    await updatePartnerStatusMessage(interaction.guild, {
      status: 'failure',
      invite_link: partner.invite_link,
      server_id_input: interaction.guildId,
      applicant_user_id: interaction.user.id,
      applicant_tag: interaction.user.tag,
      reason: '웹훅 전송에 실패했습니다.',
    }, settings);

    return interaction.reply({
      content: '❌ 웹훅 전송에 실패했습니다. URL을 다시 확인해주세요.',
      ephemeral: true,
    });
  }

  let partnerChannel = null;
  if (partner.channel_id) {
    const existingChannel = await interaction.guild.channels.fetch(partner.channel_id).catch(() => null);
    if (existingChannel && existingChannel.isTextBased()) {
      partnerChannel = existingChannel;
      if (partnerChannel.name !== channelName) {
        await partnerChannel.setName(channelName).catch(() => null);
      }
    }
  }

  if (!partnerChannel) {
    const category = await interaction.guild.channels.fetch(settings.category_id).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      await updatePartnerStatusMessage(interaction.guild, {
        status: 'failure',
        invite_link: partner.invite_link,
        server_id_input: interaction.guildId,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        reason: '파트너 카테고리를 찾을 수 없습니다.',
      }, settings);

      return interaction.reply({
        content: '❌ 파트너 카테고리를 찾을 수 없습니다. `/설정`을 다시 확인해주세요.',
        ephemeral: true,
      });
    }

    try {
      partnerChannel = await interaction.guild.channels.create({
        name: channelName,
        parent: category.id,
      });
    } catch (error) {
      await updatePartnerStatusMessage(interaction.guild, {
        status: 'failure',
        invite_link: partner.invite_link,
        server_id_input: interaction.guildId,
        applicant_user_id: interaction.user.id,
        applicant_tag: interaction.user.tag,
        reason: '파트너 채널 생성에 실패했습니다.',
      }, settings);

      return interaction.reply({
        content: '❌ 파트너 채널 생성에 실패했습니다. 권한과 카테고리 설정을 확인해주세요.',
        ephemeral: true,
      });
    }
  }

  await savePartnerWebhook({
    userId: interaction.user.id,
    guildId: interaction.guildId,
    partnerName: partnerNameInput,
    webhookUrl,
    channelId: partnerChannel.id,
  });

  await updatePartnerStatusMessage(interaction.guild, {
    status: 'success',
    invite_link: partner.invite_link,
    server_id_input: interaction.guildId,
    applicant_user_id: interaction.user.id,
    applicant_tag: interaction.user.tag,
    reason: `파트너 채널 등록 완료: ${partnerChannel}`,
    channelMention: partnerChannel.toString(),
  }, settings);

  return interaction.reply({
    content: `✅ 파트너 등록 완료! ${partnerChannel} 채널이 생성/갱신되었습니다.`,
    ephemeral: true,
  });
}

client.once('ready', async () => {
  try {
    await restoreDatabaseBackupFromDiscord({
      client,
      channelId: DB_BACKUP_CHANNEL_ID,
      dbPath: DB_PATH,
    });
  } catch (error) {
    console.warn('DB 백업 복원 준비 중 오류:', error);
  }

  try {
    await initDatabase();
  } catch (error) {
    console.warn('로컬 DB 초기화 실패, 백업으로 재시도합니다:', error);
    await restoreDatabaseBackupFromDiscord({
      client,
      channelId: DB_BACKUP_CHANNEL_ID,
      dbPath: DB_PATH,
      force: true,
    });
    await initDatabase();
  }

  await syncInstalledGuilds(client.guilds.cache.values());

  const currentGuildIds = [...client.guilds.cache.keys()];
  await pruneMissingInstalledGuilds(currentGuildIds);
  await pruneMissingPartnerStatuses(currentGuildIds);

  databaseBackupManager = createDatabaseBackupManager({
    client,
    channelId: DB_BACKUP_CHANNEL_ID,
    dbPath: DB_PATH,
  });

  setDatabaseChangeNotifier((reason) => {
    if (!databaseBackupManager) {
      return null;
    }

    return databaseBackupManager.requestBackup(reason);
  });

  try {
    await databaseBackupManager.requestBackup('startup sync');
  } catch (error) {
    console.error('시작 시 DB 백업 전송 실패:', error);
  }

  try {
    await registerSlashCommands();
    console.log('슬래시 명령어 동기화 완료');
  } catch (error) {
    console.error('명령어 등록 중 오류:', error);
  }

  cron.schedule('0 15 * * *', async () => {
    const promotions = await listActivePromotions();
    for (const promotion of promotions) {
      try {
        const guild = client.guilds.cache.get(promotion.guild_id);
        await fetch(promotion.webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: promotion.promo_message,
            username: guild ? guild.name : '파트너 봇',
          }),
        });
      } catch (error) {
        console.error('자동 홍보 실패:', error);
      }
    }
  }, {
    timezone: 'Asia/Seoul',
  });

  console.log(`봇 로그인 완료: ${client.user.tag}`);
});

client.on('guildCreate', async (guild) => {
  await syncInstalledGuild(guild.id);
});

client.on('guildDelete', async (guild) => {
  await removeInstalledGuild(guild.id);
  await deletePartnerStatus(guild.id);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) {
    return;
  }

  if (!message.guild) {
    return;
  }

  const partnerChannel = await getPartnerByChannelId(message.channel.id);
  if (!partnerChannel) {
    return;
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const messages = await message.channel.messages.fetch({ limit: 50 });
  const userMessages = messages.filter(
    (item) => item.author.id === message.author.id && item.createdTimestamp > todayStart.getTime(),
  );

  if (userMessages.size <= 1) {
    return;
  }

  try {
    const guildMember = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!guildMember) {
      return;
    }

    await guildMember.timeout(3 * 24 * 60 * 60 * 1000, '파트너 채널 홍보 규정 위반');
    await message.delete();
    await message.channel.send({
      content: `⚠️ ${message.author}님, 파트너 채널은 하루에 한 번만 이용 가능합니다. 3일간 타임아웃됩니다.`,
    }).then((notice) => setTimeout(() => notice.delete().catch(() => null), 5000));
  } catch (error) {
    console.error('도배 방지 처리 실패:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: '서버에서만 사용할 수 있는 명령어입니다.',
          ephemeral: true,
        });
      }

      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: '이 명령어는 관리자만 사용할 수 있습니다.',
          ephemeral: true,
        });
      }

      switch (interaction.commandName) {
        case '설정':
          return handleSetupCommand(interaction);
        case '홍보글설정':
          return handlePromoSettingCommand(interaction);
        case '채널명설정':
          return handleChannelNameCommand(interaction);
        case '임베드게시':
          return handleGuidePostCommand(interaction);
        case 'db백업':
          return handleDatabaseBackupCommand(interaction);
        default:
          return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_setup') {
        return handleSetupModal(interaction);
      }

      if (interaction.customId === 'modal_channel_name') {
        return handleChannelNameModal(interaction);
      }

      if (interaction.customId === 'modal_apply') {
        return handleApplyModal(interaction);
      }

      if (interaction.customId === 'modal_webhook') {
        return handleWebhookModal(interaction);
      }

      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'btn_apply') {
        return handleApplyButton(interaction);
      }

      if (interaction.customId === 'btn_webhook') {
        return handleWebhookButton(interaction);
      }
    }
  } catch (error) {
    console.error('interactionCreate 처리 중 오류:', error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
        ephemeral: true,
      }).catch(() => null);
    }
  }
});

client.login(TOKEN);
