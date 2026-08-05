/**
 * Pure classifier. The only place that decides photo / video / carousel.
 * Operates exclusively on the files that were actually downloaded.
 *
 * @param {Array<{ path: string, isImage: boolean, isVideo: boolean, mime: string }>} files
 * @param {string} [originalUrl] - optional, used only for cosmetic "Reel" label
 * @returns {{ kind: string, label: string, files: typeof files }}
 */
function classify(files, originalUrl = "") {
  const media = files.filter((f) => f.isImage || f.isVideo);

  if (media.length === 0) {
    return {
      kind: "unknown",
      label: "Post",
      files: [],
    };
  }

  if (media.length === 1) {
    const file = media[0];

    if (file.isVideo) {
      // Cosmetic only: single video from a /reel/ URL may still be labelled "Reel".
      const isReel =
        typeof originalUrl === "string" &&
        (/\/reel\//i.test(originalUrl) || /\/reels\//i.test(originalUrl));

      return {
        kind: "video",
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

  return {
    kind: "carousel",
    label: "Carousel",
    files: media,
  };
}

module.exports = {
  classify,
};
