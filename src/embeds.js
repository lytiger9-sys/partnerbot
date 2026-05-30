const { EmbedBuilder } = require('discord.js');

const STATUS_META = {
  pending: {
    label: '대기중',
    color: 0xF1C40F,
    description: '조건 검증이 끝나고 웹훅 입력을 기다리는 상태입니다.',
  },
  success: {
    label: '성공',
    color: 0x2ECC71,
    description: '파트너 등록이 완료되었습니다.',
  },
  failure: {
    label: '실패',
    color: 0xE74C3C,
    description: '검증 또는 등록 과정에서 거절되었습니다.',
  },
};

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '미확인';
  }

  return `${(Number(value) * 100).toFixed(2)}%`;
}

function formatCountComparison(current, limit, suffix = '명') {
  if (current === null || current === undefined || Number.isNaN(Number(current))) {
    return '미확인';
  }

  if (limit === null || limit === undefined || Number.isNaN(Number(limit))) {
    return `\`${current}${suffix}\``;
  }

  return `\`${current}${suffix}\` / 기준 \`${limit}${suffix}\``;
}

function formatPercentComparison(current, limit) {
  const currentText = formatPercent(current);
  if (limit === null || limit === undefined || Number.isNaN(Number(limit))) {
    return `\`${currentText}\``;
  }

  return `\`${currentText}\` / 기준 \`${formatPercent(limit)}\``;
}

function clampText(text, limit = 1024) {
  if (!text) {
    return null;
  }

  const value = String(text);
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 3)}...`;
}

function buildPartnerGuideEmbed({
  guildName,
  guildIconUrl,
  minMembers,
  botRatioLimit,
  partnerName,
  channelPrefix,
  channelSuffix,
  botInviteUrl,
}) {
  const embed = new EmbedBuilder()
    .setTitle(`🤝 ${guildName} 파트너 안내`)
    .setDescription(
      [
        '파트너 신청은 아래 순서로 진행됩니다.',
        '',
        '1. `파트너 신청` 버튼을 누릅니다.',
        '2. 서버 ID와 초대 링크를 입력합니다.',
        '3. 입력한 서버 ID, 초대 링크, 봇 설치 여부를 확인합니다.',
        '4. 조건이 맞으면 웹훅 URL을 입력합니다.',
        '',
        '상태는 로그 채널에 서버당 1개 임베드로 갱신됩니다.',
      ].join('\n'),
    )
    .setColor(0x5865F2)
    .setTimestamp();

  if (guildIconUrl) {
    embed.setThumbnail(guildIconUrl);
  }

  embed.addFields(
    {
      name: '조건',
      value: [
        `- 최소 인원: \`${minMembers}명\``,
        `- 최대 봇 비율: \`${formatPercent(botRatioLimit)}\``,
        '- 서버 ID와 초대 링크가 일치해야 합니다.',
        '- 봇이 먼저 설치되어 있어야 합니다.',
        '- 1일 1핑이며, 어길 시에 타임아웃 제재 3일입니다.',
      ].join('\n'),
    },
    {
      name: '제휴명',
      value: partnerName ? `\`${partnerName}\`` : '미설정',
      inline: true,
    },
    {
      name: '채널명 장식',
      value: [
        `- 앞: ${channelPrefix ? `\`${channelPrefix}\`` : '미설정'}`,
        `- 뒤: ${channelSuffix ? `\`${channelSuffix}\`` : '미설정'}`,
        '- 실제 채널명은 `앞 + 제휴명 + 뒤` 형태로 생성됩니다.',
      ].join('\n'),
    },
  );

  if (botInviteUrl) {
    embed.addFields({
      name: '봇 초대',
      value: `[봇 초대 링크 열기](${botInviteUrl})`,
      inline: true,
    });
  }

  return embed;
}

function buildPartnerStatusEmbed({
  guildName,
  guildId,
  guildIconUrl,
  status,
  inviteLink,
  serverIdInput,
  applicantTag,
  memberCount,
  botCount,
  botRatio,
  minMembers,
  botRatioLimit,
  reason,
  channelMention,
}) {
  const meta = STATUS_META[status] ?? STATUS_META.failure;
  const embed = new EmbedBuilder()
    .setTitle(`${guildName} 파트너 상태`)
    .setDescription(meta.description)
    .setColor(meta.color)
    .setTimestamp();

  if (guildIconUrl) {
    embed.setThumbnail(guildIconUrl);
  }

  embed.addFields(
    {
      name: '상태',
      value: meta.label,
      inline: true,
    },
    {
      name: '서버 ID',
      value: `\`${guildId}\``,
      inline: true,
    },
    {
      name: '신청자',
      value: applicantTag ? `\`${applicantTag}\`` : '미상',
      inline: true,
    },
  );

  if (serverIdInput) {
    embed.addFields({
      name: '입력한 서버 ID',
      value: `\`${serverIdInput}\``,
      inline: true,
    });
  }

  if (inviteLink) {
    embed.addFields({
      name: '초대 링크',
      value: `[열기](${inviteLink})`,
    });
  }

  embed.addFields(
    {
      name: '멤버 수',
      value: formatCountComparison(memberCount, minMembers),
      inline: true,
    },
    {
      name: '봇 수',
      value: botCount === null || botCount === undefined ? '미확인' : `\`${botCount}명\``,
      inline: true,
    },
    {
      name: '봇 비율',
      value: formatPercentComparison(botRatio, botRatioLimit),
      inline: true,
    },
  );

  if (channelMention) {
    embed.addFields({
      name: '파트너 채널',
      value: channelMention,
      inline: false,
    });
  }

  const cleanedReason = clampText(reason);
  if (cleanedReason) {
    embed.addFields({
      name: '메모',
      value: cleanedReason,
    });
  }

  return embed;
}

module.exports = {
  buildPartnerGuideEmbed,
  buildPartnerStatusEmbed,
  formatPercent,
};
