function normalizePreservedComment(value) {
  return String(value || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function hasMeaningfulText(value) {
  return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(value);
}

/**
 * Removes only the exact social URL Harmony selected for processing.
 * If the URL cannot be found exactly, deletion is unsafe and the original
 * Discord message must remain untouched.
 *
 * @param {string} content
 * @param {string} processedUrl
 * @returns {{ safeToDelete: boolean, comment: string|null }}
 */
function extractMemberComment(content, processedUrl) {
  const source = String(content || "");
  const target = String(processedUrl || "");
  const index = target ? source.indexOf(target) : -1;

  if (index < 0) {
    return { safeToDelete: false, comment: null };
  }

  let start = index;
  let end = index + target.length;
  if (source[start - 1] === "<" && source[end] === ">") {
    start -= 1;
    end += 1;
  }

  const comment = normalizePreservedComment(
    `${source.slice(0, start)}${source.slice(end)}`
  );

  if (!comment) {
    return { safeToDelete: true, comment: null };
  }

  // A punctuation-only remainder can be URL punctuation or intentional text.
  // Preserve the original message rather than guessing.
  if (!hasMeaningfulText(comment)) {
    return { safeToDelete: false, comment: null };
  }

  return { safeToDelete: true, comment };
}

module.exports = { extractMemberComment, normalizePreservedComment };
