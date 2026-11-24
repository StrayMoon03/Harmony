"use strict";
const { validatePhoto } = require("./concertCountdownRender");
async function downloadPhoto(a) {
  if (!a || a.size > 4 * 1024 * 1024)
    throw Error("Choose a JPEG or PNG up to 4 MB");
  const url = new URL(a.url);
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw Error("Use a Discord file upload");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error("Could not download the photograph. Upload it again.");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw Error("Photograph exceeds 4 MB");
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return validatePhoto(Buffer.concat(chunks));
}
module.exports = { downloadPhoto };
