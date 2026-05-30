const MAX_CHANNEL_NAME_LENGTH = 100;

function toCodePoints(value) {
  return Array.from(String(value ?? ''));
}

function truncateByCodePoints(text, limit = MAX_CHANNEL_NAME_LENGTH) {
  const chars = toCodePoints(text);
  if (chars.length <= limit) {
    return chars.join('');
  }

  return chars.slice(0, limit).join('');
}

function normalizeChannelDecoration(input) {
  if (input === null || input === undefined) {
    return '';
  }

  return String(input)
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function normalizeChannelBaseName(input) {
  const normalized = normalizeChannelDecoration(input)
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .toLowerCase();

  return normalized || 'partner';
}

function buildPartnerChannelName(partnerName, prefix = '', suffix = '') {
  const normalizedPrefix = normalizeChannelDecoration(prefix).toLowerCase();
  const normalizedSuffix = normalizeChannelDecoration(suffix).toLowerCase();
  const normalizedBase = normalizeChannelBaseName(partnerName);

  const prefixChars = toCodePoints(normalizedPrefix);
  const baseChars = toCodePoints(normalizedBase);
  const suffixChars = toCodePoints(normalizedSuffix);

  const availableForBase = MAX_CHANNEL_NAME_LENGTH - prefixChars.length - suffixChars.length;

  let channelName;
  if (availableForBase >= baseChars.length) {
    channelName = `${normalizedPrefix}${normalizedBase}${normalizedSuffix}`;
  } else if (availableForBase > 0) {
    const trimmedBase = baseChars.slice(0, availableForBase).join('');
    channelName = `${normalizedPrefix}${trimmedBase}${normalizedSuffix}`;
  } else {
    channelName = `${normalizedPrefix}${normalizedBase}${normalizedSuffix}`;
    channelName = truncateByCodePoints(channelName, MAX_CHANNEL_NAME_LENGTH);
  }

  channelName = channelName.trim();
  if (!channelName) {
    return 'partner';
  }

  return truncateByCodePoints(channelName, MAX_CHANNEL_NAME_LENGTH);
}

module.exports = {
  MAX_CHANNEL_NAME_LENGTH,
  normalizeChannelDecoration,
  normalizeChannelBaseName,
  truncateByCodePoints,
  buildPartnerChannelName,
};
