/**
 * Pure classifier.
 * The only place that decides Photo / Video / Reel / Multi-Photo.
 *
 * Operates exclusively on the files that were actually downloaded.
 *
 * @param {Array<{
 *   path: string,
 *   isImage: boolean,
 *   isVideo: boolean,
 *   mime: string
 * }>} files
 * @param {string} [originalUrl]
 * @returns {{
 *   kind: string,
 *   label: string,
 *   files: typeof files
 * }}
 */
function classify(files, originalUrl = "") {
  const media = files.filter(
    (file) => file.isImage || file.isVideo
  );

  if (media.length === 0) {
    return {
      kind: "unknown",
      label: "Post",
      files: [],
    };
  }

  // =========================
  // Single media item
  // =========================

  if (media.length === 1) {
    const file = media[0];

    if (file.isVideo) {
      const isReel =
        typeof originalUrl === "string" &&
        (
          /\/reel\//i.test(originalUrl) ||
          /\/reels\//i.test(originalUrl)
        );

      return {
        kind: isReel ? "reel" : "video",
        label: isReel ? "Reel" : "Video",
        files: media,
      };
    }

    return {
      kind: "photo",
      label: "Photo",
      files: media,
    };
  }

  // =========================
  // Multiple media items
  // =========================

  return {
    kind: "multi-photo",
    label: "Multi-Photo",
    files: media,
  };
}

module.exports = {
  classify,
};