const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { logThreadsBrowserDiagnostics } = require("./threadsDownloader");

test("diagnostic logging permits only exact boolean signals, never private payloads", () => {
  const safe = logThreadsBrowserDiagnostics('HARMONY_THREADS_DIAGNOSTICS:' + JSON.stringify({
    pageSignalsAvailable: true, loginPromptVisible: true, accountMenuVisible: 'true',
    cookies: 'SECRET', title: 'SECRET', url: 'https://signed.invalid/?token=SECRET',
    exactRecordSeen: true, rootVideoDeclared: true,
  }));
  assert.equal(safe.loginPromptVisible, true);
  assert.equal(safe.exactRecordSeen, true);
  assert.equal(safe.rootVideoDeclared, true);
  assert.equal(safe.authenticationEvidence, 'not_confirmed');
  assert.equal(JSON.stringify(safe).includes('SECRET'), false);
  assert.equal(JSON.stringify(safe).includes('https:'), false);
  assert.equal(Object.keys(safe).length, 11);
});

test("missing or malformed diagnostic output is harmless and unconfirmed", () => {
  for (const output of ['', 'HARMONY_THREADS_DIAGNOSTICS:{broken', 'HARMONY_THREADS_DIAGNOSTICS:null']) {
    const safe = logThreadsBrowserDiagnostics(output);
    assert.equal(safe.pageSignalsAvailable, false);
    assert.equal(safe.authenticationEvidence, 'not_confirmed');
  }
});

test("authenticated UI evidence is labeled as evidence, not cookie validity", () => {
  const safe = logThreadsBrowserDiagnostics('HARMONY_THREADS_DIAGNOSTICS:{"accountMenuVisible":true}');
  assert.equal(safe.authenticationEvidence, 'authenticated_ui');
});

const pythonSource = fs.readFileSync(__dirname + '/threadsBrowser.py', 'utf8');
const evaluationStart = pythonSource.indexOf('            r"""() => {');
assert.ok(evaluationStart >= 0);
const evaluation = pythonSource.slice(evaluationStart + '            r"""'.length).split('"""', 1)[0];
const element = (label, visible = true) => ({
  innerText: label, getAttribute: () => null,
  getClientRects: () => visible ? [{}] : [],
});
function inspectPage(text, controls, pathname = '/@example/post/EXACT', password = []) {
  const document = {
    body: { innerText: text },
    querySelectorAll: (selector) => selector.startsWith('input') ? password : controls,
  };
  return vm.runInNewContext('(' + evaluation + ')()', { document, location: { pathname } });
}
test("actual browser evaluation detects login, challenge and restriction signals without returning text", () => {
  const result = inspectPage("This content isn't available to everyone. PRIVATE", [element('Log in')], '/checkpoint');
  assert.equal(result.pageSignalsAvailable, true);
  assert.equal(result.loginPromptVisible, true);
  assert.equal(result.checkpointRoute, true);
  assert.equal(result.restrictionNoticeVisible, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test("hidden login controls do not establish a visible prompt; logged-in controls are distinct", () => {
  const result = inspectPage('', [element('Log in', false), element('Switch accounts')]);
  assert.equal(result.loginPromptVisible, false);
  assert.equal(result.accountMenuVisible, true);
  assert.equal(result.restrictionNoticeVisible, false);
});
test("visible password form and login redirect are diagnostic evidence only", () => {
  const result = inspectPage('', [], '/accounts/login/', [element('password')]);
  assert.equal(result.loginPromptVisible, true);
  assert.equal(result.loginRoute, true);
  assert.equal(result.accountMenuVisible, false);
});
