const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { requestText, conditionalHeaders, contentDigest, publicUrl } = require("./common");
const { extractYouTubeId } = require("../../modules/media/youtube");
// Verified from the official @StrayKids page's canonical channel link, 2026-11-18.
const accountId = "UC9rMiEjNaCSsebs31MRDCRA";
const url = "https://www.youtube.com/feeds/videos.xml?channel_id=" + accountId;
function validTimestamp(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function parseFeed(xml, channelId = accountId) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("youtube_feed_invalid_xml");
  const data = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
  const feedChannelId = data.feed?.["yt:channelId"];
  if (!data.feed || ![channelId, channelId.replace(/^UC/, "")].includes(feedChannelId)) {
    throw new Error("youtube_feed_channel_mismatch");
  }
  const entries = data.feed.entry ? [].concat(data.feed.entry) : [];
  return entries.map((entry) => {
    const id = String(entry["yt:videoId"] || "");
    if (entry["yt:channelId"] !== channelId || extractYouTubeId("https://www.youtube.com/watch?v=" + id) !== id) {
      throw new Error("youtube_video_identity_invalid");
    }
    return {
      id, url: "https://www.youtube.com/watch?v=" + id,
      aliases: ["https://youtu.be/" + id], title: String(entry.title || "Official Stray Kids upload"),
      summary: String(entry["media:group"]?.["media:description"] || ""),
      publishedAt: validTimestamp(entry.published), updatedAt: validTimestamp(entry.updated),
      metadata: {
        channelId, links: ["https://www.youtube.com/watch?v=" + id],
        images: [publicUrl(entry["media:group"]?.["media:thumbnail"]?.["@_url"])].filter(Boolean),
        bodyHash: contentDigest(entry["media:group"]?.["media:description"] || ""),
      },
    };
  });
}
async function fetchItems({ source, since, fetchImpl, budget }) {
  const result = await requestText(source.source_url, { fetchImpl, budget, headers: conditionalHeaders(source) });
  if (result.status === 304) return { notModified: true };
  const entries = parseFeed(result.text, source.account_id);
  const dates = entries.map((item) => item.publishedAt).filter(Boolean).sort();
  const coverage = dates[0] && dates[0] <= since;
  return {
    items: entries.filter((item) => !item.publishedAt || item.publishedAt >= since),
    etag: result.etag, lastModified: result.lastModified,
    cursor: entries[0]?.id || source.cursor,
    limitation: coverage ? null : "YouTube feed history does not establish full requested coverage. No API catch-up is enabled.",
  };
}
module.exports = {
  key: "youtube-uploads", accountId, url,
  accountMetadata: { currentUrl: "https://www.youtube.com/@StrayKids", verifiedAt: "2026-11-18", verification: "official channel canonical link" },
  parseFeed, fetchItems,
};
