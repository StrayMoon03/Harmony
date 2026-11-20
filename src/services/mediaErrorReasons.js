const { FAILURE_TEXT } = require("../modules/media/messageLifecycle");

const FACEBOOK_LOGIN_WALL_USER_TEXT =
  "This Facebook post looks like it’s in a private group or only visible to certain people, so Harmony can’t see it.";

const FACEBOOK_LOGIN_WALL_INBOX_TEXT =
  "This Facebook post is likely in a private group or limited to certain people, so Harmony can’t see it. If other Facebook posts are failing too, the cookies may need refreshing.";

function errorText(error) {
  return [
    error?.message,
    error?.stderr,
    typeof error === "string" ? error : "",
  ].filter(Boolean).join(" ");
}

function looksLikeLoginOrAudienceWall(text) {
  if (/this content isn['’]?t available to everyone|can['’]?t be seen by certain audiences/i.test(text)) {
    return true;
  }
  if (/confirm.{0,40}not a bot|\bnot a bot\b/i.test(text)) return false;
  return /\blogin required\b|http redirect to login|redirect(?:ed)? to (?:the )?login(?: page)?/i.test(text);
}

function looksLikeLoginOrCheckpointWall(text) {
  if (/opened a login(?: or checkpoint)? page|login or checkpoint page/i.test(text)) return true;
  if (
    /\/checkpoint\/|checkpoint(?: page|required| blocked)?/i.test(text) &&
    !/confirm.{0,40}not a bot|\bnot a bot\b/i.test(text)
  ) {
    return true;
  }
  return looksLikeLoginOrAudienceWall(text);
}

function refersToFacebook(error, sourceUrl) {
  const haystack = String(sourceUrl || "").toLowerCase();
  if (haystack.includes("facebook.com") || haystack.includes("fb.watch")) return true;
  return /\bfacebook\b/i.test(errorText(error));
}

function isFacebookLoginOrCheckpointWall(error, sourceUrl) {
  return refersToFacebook(error, sourceUrl) && looksLikeLoginOrCheckpointWall(errorText(error));
}

function publicFailureText(error, sourceUrl) {
  if (isFacebookLoginOrCheckpointWall(error, sourceUrl)) {
    return FACEBOOK_LOGIN_WALL_USER_TEXT;
  }
  return FAILURE_TEXT;
}

function safeReason(error, sourceUrl) {
  const text = errorText(error);

  // Facebook shows the same login/checkpoint page for a private-group post
  // and for expired cookies. Lead with the private-post explanation; mention
  // cookies only as the follow-up if other Facebook posts are failing too.
  if (isFacebookLoginOrCheckpointWall(error, sourceUrl)) {
    return FACEBOOK_LOGIN_WALL_INBOX_TEXT;
  }
  if (error?.socialAuthFailureKind === "owner") {
    return "The platform account needs a security check by its owner (then refresh cookies).";
  }
  if (error?.socialAuthFailureKind === "session") {
    return "The platform login cookies need to be refreshed.";
  }
  if (/Threads post is text-only/i.test(text)) {
    return "This Threads post is text-only, so there was no photo or video to share.";
  }
  // Display-only. This must not be treated as health-store evidence.
  if (looksLikeLoginOrAudienceWall(text)) {
    return "The platform login cookies may need to be refreshed.";
  }
  if (/no audio|audio stream|silent/i.test(text)) {
    return "The downloaded video did not contain a usable audio track.";
  }
  if (/requested format is not available|no formats found/i.test(text)) {
    return "The platform did not provide a downloadable media format Harmony could use.";
  }
  if (/below.{0,20}(?:size|byte) threshold|too small|file size|signature rejection/i.test(text)) {
    return "The retrieved media could not be used for posting.";
  }
  if (/compress|too large|size limit|under Discord limit/i.test(text)) {
    return "The media could not be reduced safely to Discord’s upload limit.";
  }
  if (/timeout|timed out|SIGKILL/i.test(text)) {
    return "The platform took too long to return usable media.";
  }
  if (/verify|verified|exact post|expose media|linkOnly|FACEBOOK_UNVERIFIED_MEDIA/i.test(text)) {
    return "Harmony could not verify media belonging to this exact post.";
  }
  if (/unsupported URL|extract|download|retrieve|no media/i.test(text)) {
    return "Harmony could not retrieve usable media from this link.";
  }
  return "Harmony encountered an unexpected media-processing error.";
}

module.exports = {
  FACEBOOK_LOGIN_WALL_USER_TEXT,
  FACEBOOK_LOGIN_WALL_INBOX_TEXT,
  isFacebookLoginOrCheckpointWall,
  publicFailureText,
  safeReason,
};
