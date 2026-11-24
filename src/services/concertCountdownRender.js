"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
let tail = Promise.resolve(),
  queued = 0;
function worker(payload) {
  if (queued >= 8)
    return Promise.reject(
      Error("Countdown image processor is busy. Try again shortly."),
    );
  queued++;
  const job = tail.then(
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          "python3",
          [path.join(__dirname, "../renderers/concert_countdown.py")],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        const chunks = [];
        let size = 0,
          error = "",
          settled = false;
        const finish = (err, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve(result);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(Error("Countdown image processing timed out"));
        }, 15000);
        child.stdout.on("data", (c) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) {
            child.kill("SIGKILL");
            finish(Error("Countdown image is too large"));
          } else chunks.push(c);
        });
        child.stderr.on("data", (c) => {
          error = (error + c).slice(-800);
        });
        child.stdin.on("error", () => {});
        child.on("error", () =>
          finish(Error("Countdown image processor unavailable")),
        );
        child.on("close", (code) =>
          finish(
            code === 0
              ? null
              : Error("Countdown image processing failed: " + error.trim()),
            Buffer.concat(chunks),
          ),
        );
        child.stdin.end(JSON.stringify(payload));
      }),
  );
  tail = job
    .catch(() => {})
    .finally(() => {
      queued--;
    });
  return job;
}
function photoData(photo) {
  if (!photo) return null;
  const bytes = Buffer.from(photo.bytes);
  if (bytes.length > 4 * 1024 * 1024) throw Error("Photograph exceeds 4 MB");
  return bytes.toString("base64");
}
async function validatePhoto(bytes) {
  return {
    bytes: await worker({ action: "photo", photo: photoData({ bytes }) }),
    type: "jpeg",
  };
}
async function render(model, photo) {
  return worker({ action: "render", model, photo: photoData(photo) });
}
module.exports = { render, validatePhoto };
