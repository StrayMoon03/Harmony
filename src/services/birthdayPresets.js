const BIASES = [
  "Bang Chan",
  "Lee Know",
  "Changbin",
  "Hyunjin",
  "Han",
  "Felix",
  "Seungmin",
  "I.N",
  "OT8",
  "Still deciding",
];
const { normalizeBiases } = require("./memberBiases");

const PRESETS = {
  "Bang Chan": [
    "You’ve worked hard, made it through another year, and deserve a day filled with comfort, laughter, and something delicious.",
    "Today’s reminder: you are doing better than you think, you are deeply appreciated, and you deserve to celebrate every bit of yourself.",
    "Turn the music up, take a proper break, and let the people who love you make a big deal out of you today.",
  ],
  "Lee Know": [
    "May your birthday be calm, delightfully unpredictable, and filled with exactly the food and people you actually like.",
    "You have officially earned one full day of doing things your way—with excellent snacks and no unnecessary nonsense.",
    "Stay warm, eat well, laugh loudly, and remember that quiet love still counts as very big love.",
  ],
  Changbin: [
    "Walk into this new year of your life with confidence, big energy, and the certainty that you are stronger than every difficult day behind you.",
    "Today calls for loud laughter, excellent food, and celebrating everything that makes you wonderfully, unmistakably you.",
    "May this year bring you strength when you need it, softness when you want it, and plenty of reasons to celebrate.",
  ],
  Hyunjin: [
    "May this next chapter be filled with beautiful surprises, creative sparks, and moments that feel worthy of being framed.",
    "Today, the world gets to celebrate its favorite work of art: you. Be dramatic about it—you have permission.",
    "May your new year be colorful, meaningful, and full of the kind of beauty you notice when everyone else rushes past.",
  ],
  Han: [
    "May your birthday have perfect music, unstoppable laughter, and enough cozy time to recharge after being iconic.",
    "You bring more joy into the room than you probably realize. Today, we are sending every bit of that joy right back.",
    "Here’s to another year of brilliant ideas, ridiculous laughs, and being loved in all your wonderfully complicated glory.",
  ],
  Felix: [
    "May your day be sunshine-soft, brownie-sweet, and filled with reminders that your kindness makes a real difference.",
    "You deserve a birthday overflowing with warmth, happy surprises, and people who make you feel completely at home.",
    "Today is for bright smiles, sweet treats, and celebrating the light you bring into other people’s lives.",
  ],
  Seungmin: [
    "May your birthday be full of sharp humor, genuine smiles, and the quiet satisfaction of knowing everyone remembered.",
    "Wishing you a year of steady happiness, unexpected victories, and plenty of perfectly timed laughter.",
    "You deserve good music, good people, and a birthday celebration that is sincere—with just enough chaos to keep it interesting.",
  ],
  "I.N": [
    "May this new year bring you confidence, fresh adventures, and many reasons to smile that enormous, unstoppable smile.",
    "You keep growing into yourself so beautifully. Today, celebrate how far you have come and everything waiting ahead.",
    "Here’s to a birthday full of laughter, great style, excellent food, and the freedom to enjoy every minute.",
  ],
  OT8: [
    "Eight voices are joining one very loud celebration today: may your year be filled with courage, comfort, laughter, and people who always STAY.",
    "Consider this an OT8 group hug for your birthday—warm, chaotic, encouraging, and absolutely impossible to escape.",
    "May your birthday playlist be perfect, your cake be generous, and all eight members’ worth of good energy follow you into this new year.",
  ],
  "Still deciding": [
    "No bias required today—the spotlight belongs entirely to you. May your birthday be joyful, comfortable, and beautifully yours.",
    "While your bias line remains under investigation, one thing is settled: you deserve a wonderful birthday.",
    "The bias decision can wait. Today, the entire celebration is centered on you and everything that makes you special.",
  ],
};

function normalizeBias(value) {
  const values = normalizeBiases(value);
  return values.length === 1 ? values[0] : "Still deciding";
}

function presetFor(profile, year) {
  const biases = normalizeBiases(profile.biases_json || profile.bias);
  const effectiveBiases = biases.length ? biases : ["Still deciding"];
  const choices = effectiveBiases.flatMap((bias) => PRESETS[bias] || []);
  const available = choices.length ? choices : PRESETS["Still deciding"];
  const seed = [...String(profile.user_id || profile.birthday_name || "Harmony")]
    .reduce((total, char) => total + char.charCodeAt(0), Number(year) || 0);
  return available[seed % available.length];
}

function spotlightFor(biasValue) {
  const biases = normalizeBiases(biasValue);
  if (biases.includes("OT8")) {
    return "Help us celebrate by dropping an OT8 moment that always makes you smile!";
  }
  if (!biases.length || biases.includes("Still deciding")) {
    return "Help us celebrate by leaving some birthday love below!";
  }
  if (biases.length === 1) return `Help us celebrate by sharing a favorite ${biases[0]} moment below!`;
  return `Help us celebrate by sharing a favorite ${biases.join(" or ")} moment below!`;
}

module.exports = {
  BIASES,
  normalizeBias,
  normalizeBiases,
  presetFor,
  spotlightFor,
};
