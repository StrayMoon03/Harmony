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
function model(count = 2, now = "2027-01-01T12:00Z") {
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
    new Date(now),
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
// Observe actual Pillow draw calls while the production renderer still generates a PNG.
// No OCR guesses or test-only renderer branches.
function renderedText(m) {
  const script = `import sys,io,json,runpy\nfrom unittest.mock import patch\nfrom PIL import ImageDraw\nrequest=sys.stdin.buffer.read()\noriginal_out=sys.stdout\ntext=[]\nreal=ImageDraw.ImageDraw.text\ndef capture(self,xy,value,*args,**kwargs):\n text.append(str(value))\n return real(self,xy,value,*args,**kwargs)\nsys.stdin=io.TextIOWrapper(io.BytesIO(request))\nsys.stdout=io.TextIOWrapper(io.BytesIO())\nwith patch.object(ImageDraw.ImageDraw,'text',capture):\n runpy.run_path('src/renderers/concert_countdown.py',run_name='__main__')\nsys.stdout=original_out\nprint(json.dumps(text))`;
  const p = spawnSync("python3", ["-c", script], {
    input: JSON.stringify({ action: "render", model: m }),
    encoding: "utf8",
  });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}
test("single-date cards omit DAY 1 and vertically center all remaining content for every concert state", async () => {
  for (const [state, label, days] of [
    ["upcoming", "DAYS TO GO", 206],
    ["tomorrow", "TOMORROW!", 1],
    ["today", "IT'S D-DAY, STAY!", 0],
    ["completed", "THANK YOU FOR THE MEMORIES!", 0],
  ]) {
    const m = model(1);
    m.panels[0] = { ...m.panels[0], state, label, days };
    const text = renderedText(m);
    assert.ok(!text.some((t) => /^DAY \d+$/.test(t)));
    assert.ok(text.join(" ").includes(label));
    assert.ok(text.includes("June 18, 2027"));
    if (state === "upcoming") assert.ok(text.includes("206"));
    const png = await render(m);
    const center = Number(
      inspect(
        png,
        "crop=im.crop((218,372,583,557)); mask=crop.convert('L').point(lambda v:255 if v>65 else 0); b=mask.getbbox(); print((b[1]+b[3])/2)",
      ),
    );
    assert.ok(Math.abs(center - 92) <= 2, `${state} text center ${center}`);
  }
});
test("multiple-date cards retain every DAY label, including a centered third panel", () => {
  for (const count of [2, 3, 5]) {
    const m = model(count),
      text = renderedText(m);
    assert.deepEqual(
      text.filter((t) => /^DAY \d+$/.test(t)),
      Array.from({ length: count }, (_, i) => "DAY " + (i + 1)),
    );
    for (const p of m.panels)
      assert.ok(
        text.includes(
          new Intl.DateTimeFormat("en-US", {
            dateStyle: "long",
            timeZone: "UTC",
          }).format(new Date(p.date + "T12:00Z")),
        ),
      );
  }
});
test("the approved double-date graphic is byte-for-byte unchanged", async () => {
  const fs = require("node:fs"),
    path = require("node:path");
  const m = {
    ...model(2, "2026-11-24T17:00Z"),
    testLabel: "TEST PREVIEW • FIXTURE DATES • NO VENUE PHOTO",
  };
  assert.deepEqual(
    await render(m),
    fs.readFileSync(
      path.join(__dirname, "../docs/countdown-previews/chicago-two-dates.png"),
    ),
  );
});
test("single-date changes are confined to text inside the existing panel; card size and all other pixels stay identical", async () => {
  const fs = require("node:fs"),
    path = require("node:path");
  const m = {
    ...model(1, "2026-11-24T17:00Z"),
    testLabel: "TEST PREVIEW • FIXTURE DATES • NO VENUE PHOTO",
  };
  const before = fs.readFileSync(
      path.join(__dirname, "../docs/countdown-previews/single-date.png"),
    ),
    after = await render(m);
  const script =
    "import sys,json,io,base64\nfrom PIL import Image,ImageChops\nx=json.load(sys.stdin)\na,b=[Image.open(io.BytesIO(base64.b64decode(v))) for v in x]\nassert a.size==b.size==(800,658)\nbox=ImageChops.difference(a,b).getbbox()\nassert box and box[0]>=218 and box[1]>=372 and box[2]<=583 and box[3]<=557,box\nprint('ok')";
  const p = spawnSync("python3", ["-c", script], {
    input: JSON.stringify([
      before.toString("base64"),
      after.toString("base64"),
    ]),
    encoding: "utf8",
  });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /ok/);
});
test("image-only presentation preserves every approved single/multi-date and concert-state preview byte-for-byte", async () => {
  const fs = require("node:fs"), path = require("node:path");
  const dir = path.join(__dirname, "../docs/countdown-single-date-fix");
  const { examples } = JSON.parse(fs.readFileSync(path.join(dir, "render-inputs.json"), "utf8"));
  for (const [name, m] of Object.entries(examples)) {
    assert.deepEqual(await render(m), fs.readFileSync(path.join(dir, name + ".png")), name);
  }
});
