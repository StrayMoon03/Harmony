function formatDiscordTimestamp(value) {
  if (value === null || value === undefined || value === "") return "";
  const raw = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? raw.replace(" ", "T") + "Z"
    : raw;
  const milliseconds = new Date(normalized).getTime();
  if (!Number.isFinite(milliseconds)) return raw;
  return `<t:${Math.floor(milliseconds / 1000)}:f>`;
}

module.exports = { formatDiscordTimestamp };
