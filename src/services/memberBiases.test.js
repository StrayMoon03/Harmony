const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeBiases, biasLabel } = require("./memberBiases");

test("member bias selections canonicalize singles, multiples, all-eight OT8, and legacy values", () => {
  assert.deepEqual(normalizeBiases("Han"), ["Han"]);
  assert.deepEqual(normalizeBiases(["Han", "Felix"]), ["Han", "Felix"]);
  assert.deepEqual(normalizeBiases(["Bang Chan", "Lee Know", "Changbin", "Hyunjin", "Han", "Felix", "Seungmin", "I.N"]), ["OT8"]);
  assert.deepEqual(normalizeBiases(["OT8", "Han"]), ["OT8"]);
  assert.throws(() => normalizeBiases(["Still deciding", "Han"]), /cannot be combined/);
  assert.equal(biasLabel(["Han", "Felix"]), "Han, Felix");
});
