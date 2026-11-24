const test = require("node:test"),
  assert = require("node:assert/strict"),
  { spawnSync } = require("node:child_process");
const {
  render,
  validatePhoto,
} = require("../src/services/concertCountdownRender");
const { buildCountdown } = require("../src/services/concertCountdownModel");
const config = {
  guildId: "test",
  city: "Chicago",
  country: "USA",
  venue: "Soldier Field",
  timezone: "America/Chicago",
  eventIds: [1, 2, 3, 4, 5],
};
function model(count = 2) {
  return buildCountdown(
    config,
    Array.from({ length: count }, (_, n) => ({
      id: n + 1,
      guild_id: "test",
      calendar_type: "stray_kids",
      category: "concert",
      all_day: 1,
      event_date: `2027-06-${18 + n}`,
    })),
    new Date("2027-01-01T12:00Z"),
  );
}
function fixture(code) {
  const p = spawnSync(
    "python3",
    ["-c", `import sys,io\nfrom PIL import Image,ImageDraw\n${code}`],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(p.status, 0, p.stderr.toString());
  return p.stdout;
}
function inspect(bytes, code = "print(im.size)") {
  const p = spawnSync(
    "python3",
    [
      "-c",
      `import sys,io\nfrom PIL import Image\nim=Image.open(io.BytesIO(sys.stdin.buffer.read()))\n${code}`,
    ],
    { input: bytes },
  );
  assert.equal(p.status, 0, p.stderr.toString());
  return p.stdout.toString().trim();
}
const photo = () =>
  fixture(
    "im=Image.new('RGB',(1200,600),'blue'); ImageDraw.Draw(im).rectangle((400,0,800,599),fill='red'); im.save(sys.stdout.buffer,format='PNG')",
  );
test("actual deterministic PNGs have balanced single, double and five-date layouts", async () => {
  for (const count of [1, 2, 5]) {
    const m = model(count),
      png = await render(m);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(inspect(png), `(800, ${458 + Math.ceil(count / 2) * 200})`);
    assert.deepEqual(await render(m), png);
  }
});
test("single panel is centered, paired panels balanced, numbers have visible orange pixels", async () => {
  const one = await render(model(1)),
    two = await render(model(2));
  assert.equal(
    inspect(one, "print(im.getpixel((220,400))==im.getpixel((580,400)))"),
    "True",
  );
  assert.equal(
    inspect(two, "print(im.getpixel((40,400))==im.getpixel((420,400)))"),
    "True",
  );
  assert.equal(
    inspect(
      two,
      "print(sum(1 for p in im.crop((28,401,392,488)).getdata() if p[0]>240 and 90<p[1]<170 and p[2]<80)>300)",
    ),
    "True",
  );
});
test("JPEG and PNG are fully decoded, normalized and cropped to a panorama without stretching", async () => {
  const normalized = await validatePhoto(photo());
  assert.equal(normalized.type, "jpeg");
  assert.equal(inspect(normalized.bytes), "(1200, 600)");
  const png = await render(model(2), normalized);
  assert.equal(
    inspect(
      png,
      "print(im.getpixel((400,190))[0]>200 and im.getpixel((60,190))[2]>150)",
    ),
    "True",
  );
});
test("invalid, truncated, oversized and decompression-bomb photographs are rejected", async () => {
  await assert.rejects(
    validatePhoto(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    /processing failed/,
  );
  const broken = photo().subarray(0, 60);
  await assert.rejects(validatePhoto(broken), /processing failed/);
  await assert.rejects(
    validatePhoto(Buffer.alloc(4 * 1024 * 1024 + 1)),
    /4 MB/,
  );
  const bomb = fixture(
    "Image.new('RGB',(5000,4000)).save(sys.stdout.buffer,format='PNG')",
  );
  await assert.rejects(validatePhoto(bomb), /pixels|megapixels/);
  const gif = fixture(
    "Image.new('RGB',(100,100)).save(sys.stdout.buffer,format='GIF')",
  );
  await assert.rejects(validatePhoto(gif), /JPEG or PNG/);
});
test("long names, missing photograph, tomorrow, D-day and completed panels render successfully", async () => {
  const m = {
    ...model(3),
    city: "A very long city name with many neighborhoods ".repeat(2),
    venue:
      "An unusually long venue name with several connected performance spaces ".repeat(
        2,
      ),
  };
  m.panels[0] = { ...m.panels[0], state: "tomorrow", label: "TOMORROW!" };
  m.panels[1] = { ...m.panels[1], state: "today", label: "IT'S D-DAY, STAY!" };
  m.panels[2] = {
    ...m.panels[2],
    state: "completed",
    label: "THANK YOU FOR THE MEMORIES!",
  };
  assert.equal(inspect(await render(m)), "(800, 858)");
});
test("image queue is bounded under concurrent requests", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => render(model(1))),
  );
  assert.ok(
    results.some(
      (r) => r.status === "rejected" && /busy/.test(r.reason.message),
    ),
  );
  assert.ok(results.some((r) => r.status === "fulfilled"));
});
