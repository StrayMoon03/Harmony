const INDIVIDUAL_BIASES = [
  "Bang Chan", "Lee Know", "Changbin", "Hyunjin", "Han", "Felix", "Seungmin", "I.N",
];
const BIAS_CHOICES = [...INDIVIDUAL_BIASES, "OT8", "Still deciding"];
const BIAS_ROLE_KEYS = [...INDIVIDUAL_BIASES, "OT8"];
const INDIVIDUALS_BY_KEY = new Map(INDIVIDUAL_BIASES.map((name) => [name.toLocaleLowerCase(), name]));

function valuesFromStored(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* Legacy scalar bias value. */ }
  return [value];
}

function normalizeBiases(value, { allowEmpty = true } = {}) {
  const raw = valuesFromStored(value);
  const normalized = [];
  for (const entry of raw) {
    const text = String(entry || "").trim();
    const canonical = BIAS_CHOICES.find((choice) => choice.toLocaleLowerCase() === text.toLocaleLowerCase());
    if (!canonical) throw new Error("Choose one or more supported bias options.");
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  if (normalized.includes("Still deciding")) {
    if (normalized.length > 1) throw new Error("Still deciding cannot be combined with a selected member or OT8.");
    return ["Still deciding"];
  }
  if (normalized.includes("OT8")) return ["OT8"];
  if (INDIVIDUAL_BIASES.every((bias) => normalized.includes(bias))) return ["OT8"];
  if (!normalized.length && !allowEmpty) throw new Error("Choose at least one bias option.");
  return INDIVIDUAL_BIASES.filter((bias) => normalized.includes(bias));
}

function biasLabel(value) {
  return normalizeBiases(value).join(", ");
}

function legacyBiasValue(value) {
  return biasLabel(value) || null;
}

function biasRoleKey(value) {
  const text = String(value || "").trim().toLocaleLowerCase();
  if (text === "ot8") return "OT8";
  return INDIVIDUALS_BY_KEY.get(text) || null;
}

module.exports = { INDIVIDUAL_BIASES, BIAS_CHOICES, BIAS_ROLE_KEYS, normalizeBiases, biasLabel, legacyBiasValue, biasRoleKey };
