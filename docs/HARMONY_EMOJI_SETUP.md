# Harmony Discord emoji setup

Upload these files in the testing server under **Server Settings → Emoji**.
Discord will assign each emoji an ID; do not guess or reuse an unrelated ID.

| Purpose | Discord emoji name | Source file | Railway variable |
|---|---|---|---|
| Working Harmony | `harmony_working` | `assets/harmony/working.png` | `HARMONY_WORKING_EMOJI_ID` |
| Uh-Oh Harmony | `harmony_uhoh` | `assets/harmony/uh-oh.png` | `HARMONY_UHOH_EMOJI_ID` |
| Thank You Harmony | `harmony_thank_you` | `assets/harmony/thank-you.png` | `HARMONY_THANK_YOU_EMOJI_ID` |
| Facebook heart | `harmony_heart_facebook` | `assets/hearts/facebook.png` | `HARMONY_HEART_FACEBOOK_ID` |
| Instagram heart | `harmony_heart_instagram` | `assets/hearts/instagram.png` | `HARMONY_HEART_INSTAGRAM_ID` |
| YouTube heart | `harmony_heart_youtube` | `assets/hearts/youtube.png` | `HARMONY_HEART_YOUTUBE_ID` |
| Threads heart | `harmony_heart_threads` | `assets/hearts/threads.png` | `HARMONY_HEART_THREADS_ID` |
| TikTok heart | `harmony_heart_tiktok` | `assets/hearts/tiktok.png` | `HARMONY_HEART_TIKTOK_ID` |
| X heart | `harmony_heart_x` | `assets/hearts/x.png` | `HARMONY_HEART_X_ID` |

After uploading, enable Discord Developer Mode, right-click each emoji, and copy its ID into the matching Railway variable. Harmony validates that each configured value looks like a Discord snowflake. Until an ID is configured, platform hearts use their previous Unicode fallback and Harmony status art uses the included compact transparent attachment.
