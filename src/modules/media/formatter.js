/**
 * Format a friendly "already shared" reply.
 *
 * @param {{ shared_by: string, shared_at: string }} record
 * @returns {string}
 */
function formatAlreadySharedReply(record) {
  let dateLine = record.shared_at;

  try {
    const d = new Date(record.shared_at);

    dateLine = d.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    // Keep the raw value if parsing fails.
  }

  return [
    "Thank you for helping keep our collection growing!",
    "",
    "It looks like this post has already been added.",
    "",
    `Originally shared on ${dateLine}`,
    `by ${record.shared_by}`,
    "",
    "💜 𝑯𝒂𝒓𝒎𝒐𝒏𝒚",
  ].join("\n");
}