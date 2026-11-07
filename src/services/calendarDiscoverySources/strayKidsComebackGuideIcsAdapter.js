const { createIcsSource } = require("./googleCalendarIcsAdapter");

module.exports = createIcsSource({
  SOURCE_KEY: "stray-kids-comeback-guide-ics",
  SOURCE_PROVIDER: "stray-kids-comeback-guide",
  SOURCE_NAME: "SKZ Comeback Guide",
  CALENDAR_NAME: "Stray Kids Schedule (SKZCBGuide)",
  TIMEZONE: "Asia/Seoul",
  CALENDAR_URL: "https://www.straykidscomebackguide.com/",
  FEED_URL: "https://calendar.google.com/calendar/ical/5895c23cbb5d5f820b7b57e3046db27e8d63982bd40c9a7b167fcaf135a9173f%40group.calendar.google.com/public/basic.ics",
});
